import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CONTAINER_IMAGE,
  type HarnessConfig,
  type SandboxMode,
} from "../harness/config.js";
import type { AttemptRunner } from "../harness/harness.js";
import { plannerPrompt } from "../harness/prompts.js";
import { runArmStreaming } from "../harness/session.js";
import { parseSubtickets, readLadder } from "./ladder.js";

// Planning gets one retry: unlike the build arms (which get maxAttempts via
// runArm), a planner session used to be one-shot, so a single transient hang
// (e.g. a wedged tool call killed by the watchdog) sank the whole run.
export const PLANNER_ATTEMPTS = 2;

interface PlannerExecution {
  cwd: string;
  sandbox: SandboxMode;
  exec?: string[];
}

// Greg follows the arms' isolation mode. Real runs use a fresh container with
// only the scratch ladder and transcript/auth mounts; host smoke tests keep the
// existing workspace-write path.
export function plannerExecution(
  base: HarnessConfig,
  workspace: string,
  sessionDirectory: string,
): PlannerExecution {
  const containerized =
    base.arms?.every((arm) => arm.container !== undefined) ?? false;
  if (!containerized) {
    return { cwd: workspace, sandbox: "workspace-write" };
  }

  const codexHome = resolve(base.codexHome);
  return {
    cwd: "/workspace",
    sandbox: "danger-full-access",
    exec: [
      "docker",
      "run",
      "--rm",
      "-i",
      "--env",
      "VIVARIUM_DOCKER=0",
      "--env",
      "VIVARIUM_GUI=0",
      "--mount",
      `type=bind,source=${workspace},target=/workspace`,
      "--mount",
      `type=bind,source=${join(codexHome, "auth.json")},target=/codex/auth.json,readonly`,
      "--mount",
      `type=bind,source=${sessionDirectory},target=/codex/sessions`,
      "--workdir",
      "/workspace",
      base.containerImage ?? CONTAINER_IMAGE,
    ],
  };
}

async function preserveContainerSessions(
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

// Run one fresh, stateless Greg session to plan the next milestone by editing
// the ladder file directly. Never continues a thread — statelessness is the
// point; the ladder is the only carried state. Greg runs with write access
// scoped to the ladder's directory so he can append to the file. Returns
// nothing: the loop re-reads the ladder to see what was added.
//
// Only *session* failures (the runner throwing — e.g. a watchdog abort — or
// Codex reporting an error) are retried, each time with a fresh session and a
// re-read of the ladder so anything a failed attempt half-appended is visible.
// A session that succeeds but writes the wrong thing is not transient and
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
    // transcripts), `.env` (both repo paths and both tokens), and the two
    // checkouts as siblings. `prompts.ts` tells him he is blind to the
    // builders; this is what makes that true rather than merely asserted.
    //
    // The scratch directory is outside the repo, so even a `..` walk lands in
    // the system temp dir instead of the experiment.
    const workspace = await mkdtemp(join(tmpdir(), "vivarium-planner-"));
    const sessionDirectory = await mkdtemp(
      join(tmpdir(), "vivarium-planner-sessions-"),
    );
    const scratchLadder = join(workspace, basename(ladderPath));
    const execution = plannerExecution(base, workspace, sessionDirectory);

    let result;
    try {
      await writeFile(scratchLadder, currentLadder, "utf8");
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
          codexHome: base.codexHome,
          idleTimeoutMs: base.idleTimeoutMs,
          exec: execution.exec,
        },
        () => {},
      );
      if (execution.exec) {
        await preserveContainerSessions(sessionDirectory, base.codexHome);
      }

      // Carry Greg's edit back to the real ladder — written in place, never
      // renamed, so the arms' read-only bind mount keeps showing current text
      // instead of pinning the inode it started on. Only when he actually
      // changed something: an untouched scratch file must not clobber a ladder
      // that moved underneath us.
      const planned = await readFile(scratchLadder, "utf8");
      if (planned !== currentLadder) {
        await writeFile(ladderPath, planned, "utf8");
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    } finally {
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
    const planted = parseSubtickets(await readLadder(ladderPath)).find(
      (subticket) => subticket.milestone === milestoneNumber && !subticket.done,
    );
    if (!planted) {
      throw new Error(
        `Greg did not append a buildable milestone ${milestoneNumber} to the ladder. ` +
          `Expected a new "## Milestone ${milestoneNumber}:" section with "### [ ] ${milestoneNumber}.x" subtickets.`,
      );
    }
    return result.threadId;
  }

  throw new Error(
    `Greg failed to plan milestone ${milestoneNumber} after ${PLANNER_ATTEMPTS} attempt(s): ${lastError}`,
  );
}
