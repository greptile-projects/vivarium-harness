import { basename, dirname } from "node:path";
import type { HarnessConfig } from "../config.js";
import type { AttemptRunner } from "../harness.js";
import { runArmStreaming, sessionUsage } from "../live/stream.js";
import { harnessProvenance, type HarnessProvenance } from "../provenance.js";
import { parseSubtickets, readLadder } from "./ladder.js";
import { PlanArtifacts } from "./plan-artifacts.js";

// The one fixed goal of the experiment. Greg plans every milestone toward this.
// It is a direction, not a milestone that gets reached — the climb never ends.
export const NORTH_STAR =
  "Build a working clone of GitHub: a web application where users can host git repositories, browse code, open and review pull requests, and manage issues.";

// A milestone should decompose into this many subtickets. This is guidance in
// the prompt now, not an enforced bound — Greg edits the ladder directly and we
// trust him to keep milestones the right size. The loop's runaway cap counts
// milestones, so milestone size only affects how much one rung builds.
export const MIN_SUBTICKETS_PER_MILESTONE = 2;
export const MAX_SUBTICKETS_PER_MILESTONE = 5;

// The full instruction handed to a fresh, stateless Greg. Everything Greg knows
// is in here: the goal and the ladder of milestones planned so far. Greg cannot
// see the builders' code or output — only the plan. He plans the next milestone
// by editing the ladder file directly; there is no structured hand-off.
export function plannerPrompt(
  ladder: string,
  milestoneNumber: number,
  ladderFile: string,
): string {
  const priorLadder =
    ladder.trim().length > 0
      ? ladder.trim()
      : "(no milestones yet — this is the very first)";

  return `You are Greg Tile, the planner for a long-running autonomous build. You are stateless: everything you know is written below. Do not assume any memory of earlier turns.

# North Star
${NORTH_STAR}

The North Star is a direction, not a finish line. You will not complete it, and the climb continues indefinitely — always plan the next milestone.

# The ladder
The ladder is a single markdown file, \`${ladderFile}\`, in your working directory. It holds the North Star and every milestone planned so far, each broken into subtickets. It is the single source of truth and is mounted into both build checkouts. Its current contents are:

---
${priorLadder}
---

You are blind to the builders: you CANNOT see the code they wrote, their pull requests, or whether their work truly succeeded. The ladder above — the plan itself — is your only input. Plan forward from it.

# Your job for this turn (milestone ${milestoneNumber})
Plan milestone ${milestoneNumber}: the next coherent chunk of progress toward the North Star, building on the milestones above without repeating them.

**Append the milestone to \`${ladderFile}\` by editing the file directly** (read it first, then add to the end — never rewrite or reorder what is already there). Use exactly this shape:

## Milestone ${milestoneNumber}: <milestone title>

<one-line summary of the milestone>

### [ ] ${milestoneNumber}.1 <subticket title>

<Full standalone ticket body: what to build, acceptance criteria, constraints. It is handed verbatim to a builder agent with NO other context, so it must stand entirely on its own.>

### [ ] ${milestoneNumber}.2 <subticket title>

<Full standalone ticket body.>

Rules:
- Break the milestone into ${MIN_SUBTICKETS_PER_MILESTONE}–${MAX_SUBTICKETS_PER_MILESTONE} ordered subtickets, numbered ${milestoneNumber}.1, ${milestoneNumber}.2, … Each is one PR-sized ticket a single engineer could land, and each should build on the previous one in this milestone.
- Every subticket heading MUST start with \`### [ ] \` (an unchecked box) followed by its number. The box tracks build progress — leave every box unchecked; the harness checks them off after it builds each subticket. Do not add checkboxes anywhere else.
- Do NOT file any tickets or call any Linear tools, and do not invent ticket ids. The harness files each milestone in Linear itself after you finish and stamps the ids onto the headings (you may see \` — GRE-12\`-style suffixes on earlier headings; never add your own).
- Change nothing above your new milestone. Only append.

When you have appended the milestone to the file, you are done. Your reply text is ignored — the ladder file is the result.`;
}

// Planning gets one retry: unlike the build arms (which get maxAttempts via
// runArm), a planner session used to be one-shot, so a single transient hang
// (e.g. a wedged tool call killed by the watchdog) sank the whole run.
export const PLANNER_ATTEMPTS = 2;

// Run one fresh, stateless Greg session to plan the next milestone by editing
// the ladder file directly. Never continues a thread — statelessness is the
// point; the ladder is the only carried state. Greg runs with write access
// scoped to the ladder's directory so he can append to the file. He does NOT
// file Linear tickets — the loop does that mechanically afterwards (see
// linear.ts for why a headless Codex session cannot). Returns nothing: the
// loop re-reads the ladder to see what was added.
//
// Only *session* failures (the runner throwing — e.g. a watchdog abort — or
// Codex reporting an error) are retried, each time with a fresh session and a
// re-read of the ladder so anything a failed attempt half-appended is visible.
// A session that succeeds but writes the wrong thing is not transient and
// fails immediately.
// Every session now leaves a record under `results/plan-…/`: the prompt as sent,
// the ladder as Greg was shown it, his reply, the rollout transcript, the
// subprocess's stderr and what the session cost — the same standard the build
// arms have always been held to. `base.resultsDir` is what turns it on; a config
// without one (only the unit tests) plans without recording.
export async function planNextMilestone(
  base: HarnessConfig,
  ladderPath: string,
  ladder: string,
  milestoneNumber: number,
  runner: AttemptRunner = runArmStreaming,
  // Injected for the same reason as `runner`: the default shells out to git, and
  // the suite does not.
  provenance: () => Promise<HarnessProvenance> = harnessProvenance,
): Promise<void> {
  let lastError = "unknown error";
  const artifacts = base.resultsDir
    ? await PlanArtifacts.create({
        resultsDir: base.resultsDir,
        codexHome: base.codexHome,
        milestone: milestoneNumber,
        ladderPath,
        harness: await provenance(),
      })
    : undefined;
  // Whatever happens, the ladder as it ends up is written down — including when
  // the planner threw, which is when it matters most.
  const settle = async (
    status: "planned" | "failed",
    error?: string,
  ): Promise<void> => {
    await artifacts?.complete(status, await readLadder(ladderPath), error);
  };

  for (let attempt = 1; attempt <= PLANNER_ATTEMPTS; attempt += 1) {
    const currentLadder =
      attempt === 1 ? ladder : await readLadder(ladderPath);
    const prompt = plannerPrompt(
      currentLadder,
      milestoneNumber,
      basename(ladderPath),
    );
    const startedAt = new Date().toISOString();
    const opened = await artifacts?.startAttempt(
      attempt,
      prompt,
      currentLadder,
    );

    let result;
    try {
      result = await runner(
        {
          arm: "greg",
          prompt,
          cwd: dirname(ladderPath),
          sandbox: "workspace-write",
          codexHome: base.codexHome,
          idleTimeoutMs: base.idleTimeoutMs,
          stderrPath: opened?.stderrPath,
        },
        () => {},
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await artifacts?.finishAttempt(attempt, {
        status: "failed",
        startedAt,
        error: lastError,
        usage: sessionUsage(error),
      });
      continue;
    }

    await artifacts?.finishAttempt(attempt, {
      status: result.isError ? "failed" : "succeeded",
      startedAt,
      threadId: result.threadId,
      output: result.isError ? undefined : result.output,
      error: result.isError ? result.output || "unknown error" : undefined,
      usage: result.usage,
      raw: result.raw,
    });

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
      const message =
        `Greg did not append a buildable milestone ${milestoneNumber} to the ladder. ` +
        `Expected a new "## Milestone ${milestoneNumber}:" section with "### [ ] ${milestoneNumber}.x" subtickets.`;
      await settle("failed", message);
      throw new Error(message);
    }
    await settle("planned");
    return;
  }

  const message = `Greg failed to plan milestone ${milestoneNumber} after ${PLANNER_ATTEMPTS} attempt(s): ${lastError}`;
  await settle("failed", message);
  throw new Error(message);
}
