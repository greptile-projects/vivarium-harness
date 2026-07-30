import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  SANDBOX_TEMPLATE,
  type HarnessConfig,
  type SandboxMode,
} from "../harness/config.js";
import {
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "../harness/github.js";
import type { AttemptRunner } from "../harness/harness.js";
import { plannerPrompt } from "../harness/prompts.js";
import { runArmStreaming } from "../harness/session.js";
import {
  malformedSubticketHeadings,
  parseSubtickets,
  readLadder,
} from "./ladder.js";

// Planning gets one retry: unlike the build arms (which get maxAttempts via
// runArm), a planner session used to be one-shot, so a single transient hang
// (e.g. a wedged tool call killed by the watchdog) sank the whole run.
export const PLANNER_ATTEMPTS = 2;

interface PlannerExecution {
  cwd: string;
  sandbox: SandboxMode;
  exec?: string[];
}

// Greg follows the arms' isolation mode. Real runs use a fresh Firecracker
// microVM with only the scratch ladder workspace; host smoke tests keep the
// existing workspace-write path.
export function plannerExecution(
  base: HarnessConfig,
  workspace: string,
  sandboxName?: string,
): PlannerExecution {
  const isolated =
    base.arms?.every((arm) => arm.sandboxName !== undefined) ?? false;
  if (!isolated) {
    return { cwd: workspace, sandbox: "workspace-write" };
  }

  if (!sandboxName) {
    throw new Error("planner sandbox name is required in isolated mode");
  }
  return {
    cwd: workspace,
    sandbox: "danger-full-access",
    exec: ["sbx", "exec", "-i", "-w", workspace, sandboxName],
  };
}

async function preservePlannerSessions(
  source: string,
  codexHome: string,
): Promise<void> {
  const destination = join(
    resolve(codexHome),
    "sessions",
    "greg",
    basename(source),
  );
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

function commandError(label: string, result: CommandResult): Error {
  return new Error(
    `${label}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
  );
}

// Run one fresh, stateless Greg session to plan the next milestone by editing
// the ladder file directly. Never continues a thread — statelessness is the
// point; the ladder is the only carried state. Greg runs with write access
// scoped to the ladder's directory so he can append to the file. Returns
// nothing: the loop re-reads the ladder to see what was added.
//
// Only *session* failures (the runner throwing — e.g. a watchdog abort — or
// Codex reporting an error) are retried, each time with a fresh session and a
// re-read of the real ladder. A failed attempt's scratch edits are discarded,
// never written back, so every retry plans against the ladder as it actually
// is. A session that succeeds but writes the wrong thing is not transient and
// fails immediately.
//
// Returns the session's `threadId`. Greg's planning turn runs *outside*
// `runHarness`, so no `RunArtifacts` exists to copy its transcript — and Codex
// files every session under CODEX_HOME by thread id alone. Without this the
// planner's raw reasoning is on disk but unfindable among hundreds of siblings,
// which for an experiment whose whole premise is "preserve everything, read it
// later" is the same as losing it.
export async function planNextMilestone(
  base: HarnessConfig,
  ladderPath: string,
  ladder: string,
  milestoneNumber: number,
  runner: AttemptRunner = runArmStreaming,
  command: CommandRunner = runCommand,
): Promise<string | undefined> {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= PLANNER_ATTEMPTS; attempt += 1) {
    const currentLadder =
      attempt === 1 ? ladder : await readLadder(ladderPath);

    // Greg gets a working directory containing the ladder and nothing else.
    //
    // He used to run with cwd = the harness repo root, because that is where
    // LADDER.md lives. Codex loads AGENTS.md from its working directory as
    // instructions, so the document describing two arms, which one is reviewed,
    // and that "Tuatara is presented first" was in his context on *every*
    // planning turn — automatically, with no action on his part. The same
    // directory also holds `results/` (both arms' pull requests and
    // transcripts), `.env` (both repo URLs and both tokens), and, on the host
    // smoke path, both checkouts. `prompts.ts` tells him he is blind to the
    // builders; this is what makes that true rather than merely asserted.
    //
    // The scratch directory is outside the repo, so even a `..` walk lands in
    // the system temp dir instead of the experiment.
    const workspace = await mkdtemp(join(tmpdir(), "vivarium-planner-"));
    const sessionDirectory = await mkdtemp(
      join(tmpdir(), "vivarium-planner-sessions-"),
    );
    const scratchLadder = join(workspace, basename(ladderPath));
    const isolated =
      base.arms?.every((arm) => arm.sandboxName !== undefined) ?? false;
    const plannerSandbox = isolated
      ? `vivarium-greg-${randomUUID().replace(/-/g, "").slice(0, 12)}`
      : undefined;
    const execution = plannerExecution(base, workspace, plannerSandbox);

    let result;
    let planned: string | undefined;
    try {
      await writeFile(scratchLadder, currentLadder, "utf8");
      if (plannerSandbox) {
        const created = await command("sbx", [
          "create",
          "--no-share-skills",
          "--name",
          plannerSandbox,
          "--cpus",
          "2",
          "--memory",
          "4g",
          "--template",
          SANDBOX_TEMPLATE,
          "codex",
          workspace,
        ]);
        if (created.code !== 0) {
          throw commandError("could not provision Greg's sandbox", created);
        }
        const targets = [
          "host.docker.internal",
          "gateway.docker.internal",
          "localhost",
          "127.0.0.1",
          "::1",
        ];
        const denied = await command("sbx", [
          "policy",
          "deny",
          "network",
          "--sandbox",
          plannerSandbox,
          targets.join(","),
        ]);
        if (denied.code !== 0) {
          throw commandError(
            `could not isolate Greg's sandbox from ${targets.join(", ")}`,
            denied,
          );
        }
      }
      result = await runner(
        {
          arm: "greg",
          prompt: plannerPrompt(
            currentLadder,
            milestoneNumber,
            basename(ladderPath),
          ),
          cwd: execution.cwd,
          sandbox: execution.sandbox,
          fastMode: base.fastMode,
          codexHome: base.codexHome,
          idleTimeoutMs: base.idleTimeoutMs,
          exec: execution.exec,
        },
        () => {},
      );

      // Read the scratch now — the finally below deletes it — but write
      // nothing back yet: the write-back happens after this attempt is known
      // good, below. An errored session's scratch is never read at all, so its
      // half-append is discarded exactly like a thrown attempt's and the retry
      // starts from the ladder as it really is.
      if (!result.isError) {
        planned = await readFile(scratchLadder, "utf8");
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    } finally {
      // Sessions are preserved in the finally, before the microVM and scratch
      // dirs go: a
      // failed attempt (a watchdog abort, a thrown runner) still produced a
      // transcript, and deleting it with the scratch dir would lose the record
      // of exactly the planning turns worth reading. Best-effort — a failed
      // copy must not turn into a planning retry.
      if (plannerSandbox) {
        await command("sbx", [
          "cp",
          `${plannerSandbox}:/home/agent/.codex/sessions`,
          sessionDirectory,
        ]).catch(() => undefined);
        await preservePlannerSessions(sessionDirectory, base.codexHome).catch(
          () => {},
        );
        await command("sbx", ["rm", "--force", plannerSandbox]).catch(
          () => undefined,
        );
      }
      await Promise.all([
        rm(workspace, { recursive: true, force: true }).catch(() => {}),
        rm(sessionDirectory, { recursive: true, force: true }).catch(() => {}),
      ]);
    }

    if (result.isError) {
      lastError = result.output || "unknown error";
      continue;
    }

    // Greg's reply is ignored; the file is the contract. Look for an unchecked
    // subticket that belongs to exactly milestone `milestoneNumber` — not just
    // whatever is next pending overall, since earlier milestones may still be
    // unbuilt (write-ahead planning stacks up several before anything builds).
    // This one check rejects a Greg that wrote nothing, appended the wrong
    // milestone number (e.g. 99 when asked for 2, which would resume the climb
    // from the wrong rung), or left every box already checked.
    //
    // Validated on the *scratch* text, before anything reaches the real
    // ladder: a rejected planning turn used to be written back first and then
    // fail this check, leaving the malformed milestone sitting in the durable,
    // arm-mounted file the throw was meant to keep it out of.
    const planted = parseSubtickets(planned ?? "").find(
      (subticket) => subticket.milestone === milestoneNumber && !subticket.done,
    );
    if (!planted) {
      throw new Error(
        `Greg did not append a buildable milestone ${milestoneNumber} to the ladder. ` +
          `Expected a new "## Milestone ${milestoneNumber}:" section with "### [ ] ${milestoneNumber}.x" subtickets.`,
      );
    }

    // The prompt tells Greg to ONLY append, and this is where that stops being
    // advisory: everything already on the ladder must survive as an exact
    // prefix of the new text. A turn that planted a valid milestone N by
    // rewriting what came before it — earlier milestones, checked boxes, the
    // North Star header — would pass the check above and then replace the
    // climb's durable state wholesale. Trailing whitespace is forgiven so a
    // tool that normalizes the end of the file cannot fail a legitimate
    // append.
    if (
      planned !== undefined &&
      !planned.startsWith(currentLadder.replace(/\s+$/, ""))
    ) {
      throw new Error(
        `Greg rewrote existing ladder content instead of only appending milestone ${milestoneNumber}. ` +
          "The turn is discarded and the ladder is unchanged.",
      );
    }

    // A duplicate subticket number is the one malformed shape the loop cannot
    // survive: completeSubticket flips the first heading that matches the
    // number, so a duplicated 3.1 can leave an unchecked twin that
    // nextPendingSubticket keeps finding — the climb rebuilds the same rung
    // forever. Rejected here, while the ladder is still untouched.
    const numbers = parseSubtickets(planned ?? "").map(
      (subticket) => subticket.number,
    );
    const duplicate = numbers.find(
      (number, index) => numbers.indexOf(number) !== index,
    );
    if (duplicate !== undefined) {
      throw new Error(
        `Greg's turn leaves the ladder with a duplicate subticket number (${duplicate}). ` +
          "The turn is discarded and the ladder is unchanged.",
      );
    }

    // A sibling heading Greg got *almost* right is worse than one he got
    // wrong: `### 3.2 Title` with its checkbox missing does not parse, so the
    // planted check above still passes on the siblings that do — and the
    // malformed one persists as ladder text the loop never sees and never
    // builds. Every ###-level heading in the appended text must parse.
    const appendedText =
      planned?.slice(currentLadder.replace(/\s+$/, "").length) ?? "";
    const malformed = malformedSubticketHeadings(appendedText);
    if (malformed.length > 0) {
      throw new Error(
        `Greg's turn contains a heading that does not parse as a subticket: ${JSON.stringify(malformed[0])}. ` +
          "It would sit on the ladder without ever being built. " +
          "The turn is discarded and the ladder is unchanged.",
      );
    }

    // Carry Greg's validated edit back to the real ladder — written in place,
    // never renamed, so the arms' read-only bind mount keeps showing current
    // text instead of pinning the inode it started on. Only when he actually
    // changed something: an untouched scratch file must not clobber a ladder
    // that moved underneath us.
    if (planned !== undefined && planned !== currentLadder) {
      await writeFile(ladderPath, planned, "utf8");
    }
    return result.threadId;
  }

  throw new Error(
    `Greg failed to plan milestone ${milestoneNumber} after ${PLANNER_ATTEMPTS} attempt(s): ${lastError}`,
  );
}
