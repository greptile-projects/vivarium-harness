import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findTranscript } from "../harness/artifacts.js";
import { MAX_MILESTONES, type HarnessConfig } from "../harness/config.js";
import { runHarness, type HarnessRunResult } from "../harness/harness.js";
import {
  completeSubticket,
  ensureLadderLinks,
  highestMilestone,
  initLadder,
  nextPendingSubticket,
  parseSubtickets,
  readLadder,
  runOutcome,
} from "./ladder.js";
import { NORTH_STAR } from "../harness/prompts.js";
import {
  planDirectory,
  recordPlannerSession,
  subticketRunDirectory,
} from "../harness/state.js";
import { planNextMilestone } from "./planner.js";

// The one shared ladder, mounted into both arm containers (or symlinked into
// local checkouts on the host-only smoke path).
export const LADDER_PATH = resolve("LADDER.md");

// The runaway guard (defined in config.ts with the other fixed constants) is
// counted in milestones: a run always finishes the rung it is on and pauses
// between rungs. Re-running continues from the ladder; --unbounded (Infinity)
// removes the cap.

// One subticket the loop built this run, tagged with its milestone.
export interface BuiltSubticket {
  number: string;
  milestone: number;
  title: string;
  run: HarnessRunResult;
}

// One subticket Greg planned during a write-ahead run — appended to the
// ladder, but never handed to the harness.
export interface PlannedSubticket {
  number: string;
  milestone: number;
  title: string;
}

// Injectable so the loop can be tested without spawning Greg or the arms.
export interface GregDeps {
  plan: (
    base: HarnessConfig,
    ladderPath: string,
    ladder: string,
    milestoneNumber: number,
  ) => Promise<string | undefined>;
  harness: (config: HarnessConfig) => Promise<HarnessRunResult>;
  log: (message: string) => void;
  // A live-view request to finish one particular milestone and then return
  // normally. Unlike the abort signal, this is observed only at rung
  // boundaries, so no planner or harness session is torn down mid-turn.
  stopAfterMilestone: () => number | undefined;
}

// The shared preamble of both loop entrypoints: seed the ladder file if this is
// the very first run. Container launchers mount it themselves; host smoke-test
// checkouts get the legacy symlink.
async function setupLadder(
  base: HarnessConfig,
  ladderPath: string,
  log: (message: string) => void,
): Promise<void> {
  await initLadder(ladderPath, NORTH_STAR);
  const repos = base.arms
    .filter((arm) => arm.container === undefined)
    .map((arm) => arm.repo);
  for (const link of await ensureLadderLinks(ladderPath, repos)) {
    log(link.message);
  }
}

// Preserve Greg's planning turn under its rung — the thread id into
// rung-NN/plan/plan.json and the raw Codex transcript beside it. Fails open —
// the milestone is already planned and on the ladder, so losing the record of
// *how* must not unwind it.
async function preservePlannerSession(
  base: HarnessConfig,
  milestone: number,
  threadId: string | undefined,
  log: (message: string) => void,
): Promise<void> {
  try {
    let copied: string | undefined;
    if (threadId) {
      const source = await findTranscript(
        join(base.codexHome, "sessions"),
        threadId,
      );
      if (source) {
        const directory = planDirectory(base.resultsDir, milestone);
        await mkdir(directory, { recursive: true });
        copied = join(directory, `${threadId}.jsonl`);
        await copyFile(source, copied);
      }
    }
    await recordPlannerSession(base.resultsDir, {
      milestone,
      threadId,
      transcript: copied,
      plannedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`  planner transcript not preserved (continuing): ${message}`);
  }
}

// The whole of Greg Tile: a todo-runner over one markdown ladder file. The
// ladder IS the state — Greg (the agent) plans a milestone by editing the file
// directly, appending `### [ ]` subticket checkboxes; the loop reads the file,
// builds the next unchecked subticket by running the harness on its description,
// then checks its box and records the outcome. A subticket is only checked off
// once its harness run actually succeeds — any failure (the harness throwing,
// or an arm exhausting its retries) halts the loop immediately instead of
// checking the box and moving on, so a broken rung can never look built. The
// subticket stays unchecked and a re-run retries it.
//
// When no subtickets are pending, it is Greg's turn to plan the next milestone.
// The North Star is a direction, not a destination, so the loop pauses after
// `milestoneLimit` milestones (default 2) for a human to reconfirm, or runs
// unbounded when passed Infinity. The pause is per rung: a run always finishes
// the milestone it is building (resuming counts the resumed rung as one), and
// stops before planning or starting a rung beyond the limit. Everything is
// resumable: a re-run reads the ladder and continues from the first unchecked
// box.
export async function runGreg(
  base: HarnessConfig,
  milestoneLimit: number = MAX_MILESTONES,
  deps: Partial<GregDeps> = {},
  ladderPath: string = LADDER_PATH,
): Promise<BuiltSubticket[]> {
  const plan = deps.plan ?? planNextMilestone;
  const harness = deps.harness ?? runHarness;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));
  const stopAfterMilestone = deps.stopAfterMilestone ?? (() => undefined);

  await setupLadder(base, ladderPath, log);

  const built: BuiltSubticket[] = [];
  // Distinct milestones this run has built subtickets under — the unit the
  // pause counts.
  const milestonesTouched = new Set<number>();

  for (;;) {
    const ladder = await readLadder(ladderPath);
    const pending = nextPendingSubticket(ladder);
    const stopAfter = stopAfterMilestone();

    // Nothing left to build — Greg plans the next rung by editing the ladder,
    // then we loop back and pick up the subtickets he appended. Unless this
    // run has already spent its rung budget: then it pauses instead.
    if (!pending) {
      if (
        stopAfter !== undefined &&
        highestMilestone(ladder) >= stopAfter
      ) {
        break;
      }
      if (milestonesTouched.size >= milestoneLimit) break;
      const milestoneNumber = highestMilestone(ladder) + 1;
      log(`\n=== Milestone ${milestoneNumber}: planning ===`);
      const threadId = await plan(base, ladderPath, ladder, milestoneNumber);
      await preservePlannerSession(base, milestoneNumber, threadId, log);
      const planned = nextPendingSubticket(await readLadder(ladderPath));
      log(
        `Milestone ${milestoneNumber} planned${
          planned ? ` — first subticket ${planned.number}` : ""
        }`,
      );
      continue;
    }

    // The next pending subticket opens a rung beyond this run's budget (its
    // milestone was planned ahead of time) — pause here, between milestones.
    if (
      !milestonesTouched.has(pending.milestone) &&
      (milestonesTouched.size >= milestoneLimit ||
        (stopAfter !== undefined && pending.milestone > stopAfter))
    ) {
      break;
    }

    log(
      `  ${pending.number} ${pending.title}${
        pending.ticket ? ` (${pending.ticket})` : ""
      }: building…`,
    );

    // Mechanical harness run — the two arms build this subticket. Greg is not in
    // the loop here; the ladder already records the intent. Any failure halts
    // the whole run loudly rather than silently checking the box and moving on:
    // the subticket is left unchecked so a re-run retries it. The destination
    // files the artifacts by ladder coordinates (rung-NN/run/N.M) — a re-run of
    // a failed box builds into the same directory, archiving what it replaces.
    let run: HarnessRunResult;
    try {
      run = await harness({
        ...base,
        ticket: pending.description,
        destination: {
          directory: subticketRunDirectory(
            base.resultsDir,
            pending.milestone,
            pending.number,
          ),
          subticket: {
            number: pending.number,
            milestone: pending.milestone,
            title: pending.title,
          },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`  ${pending.number}: harness error — ${message}`);
      throw error instanceof Error
        ? error
        : new Error(`harness error building ${pending.number}: ${message}`);
    }

    if (run.status === "completed_with_failures") {
      const outcome = runOutcome(run);
      log(`  ${pending.number}: ${outcome}`);
      throw new Error(
        `Greg halted: subticket ${pending.number} failed and was left unchecked — ${outcome}`,
      );
    }

    await completeSubticket(ladderPath, pending.number);
    // The ladder gets the box and nothing else. The durable record of what the
    // rung landed is the run's own artifact directory (rung-NN/run/N.M), which
    // the harness already wrote and which never crosses into a container or a
    // prompt — there is no separate bookkeeping write to fail.
    log(`  ${pending.number}: ${runOutcome(run)}`);
    milestonesTouched.add(pending.milestone);
    built.push({
      number: pending.number,
      milestone: pending.milestone,
      title: pending.title,
      run,
    });
  }

  return built;
}

// Greg without the harness: plans milestones onto the ladder — appending
// checkbox subtickets exactly as `runGreg` would — but never builds anything. Unlike `runGreg`, this keeps planning new milestones
// even while earlier ones are still unbuilt (`runGreg`'s "no pending subticket"
// gate would otherwise stop it after the first). Nothing is checked off, so a
// later `runGreg` picks up and builds every subticket queued here, oldest
// first. `milestoneLimit` caps how many milestones get planned this run, same
// per-rung runaway guard as `runGreg`.
export async function planAhead(
  base: HarnessConfig,
  milestoneLimit: number = MAX_MILESTONES,
  deps: Partial<GregDeps> = {},
  ladderPath: string = LADDER_PATH,
): Promise<PlannedSubticket[]> {
  const plan = deps.plan ?? planNextMilestone;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));
  const stopAfterMilestone = deps.stopAfterMilestone ?? (() => undefined);

  await setupLadder(base, ladderPath, log);

  const planned: PlannedSubticket[] = [];

  for (
    let milestonesPlanned = 0;
    milestonesPlanned < milestoneLimit;
    milestonesPlanned += 1
  ) {
    const ladder = await readLadder(ladderPath);
    const before = parseSubtickets(ladder).length;
    const milestoneNumber = highestMilestone(ladder) + 1;
    log(`\n=== Milestone ${milestoneNumber}: planning ahead ===`);
    const threadId = await plan(base, ladderPath, ladder, milestoneNumber);
    await preservePlannerSession(base, milestoneNumber, threadId, log);

    const after = parseSubtickets(await readLadder(ladderPath));
    for (const subticket of after.slice(before)) {
      log(
        `  ${subticket.number} ${subticket.title}${
          subticket.ticket ? ` (${subticket.ticket})` : ""
        }: planned`,
      );
      planned.push({
        number: subticket.number,
        milestone: subticket.milestone,
        title: subticket.title,
      });
    }
    if ((stopAfterMilestone() ?? Infinity) <= milestoneNumber) break;
  }

  return planned;
}
