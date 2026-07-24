import { resolve } from "node:path";
import type { HarnessConfig } from "../config.js";
import { runHarness, type HarnessRunResult } from "../harness.js";
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
import { NORTH_STAR, planNextMilestone } from "./planner.js";

// The one shared ladder, mounted into both checkouts.
export const LADDER_PATH = resolve("LADDER.md");

// Runaway guard: Greg pauses once he has built this many subtickets (harness
// runs) so a human reconfirms before he climbs further. Checked per subticket,
// so it holds no matter how many subtickets a milestone contains. Re-running
// continues from the ladder; --unbounded (Infinity) removes the cap.
export const MAX_SUBTICKETS = 10;

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
  ) => Promise<void>;
  harness: (config: HarnessConfig) => Promise<HarnessRunResult>;
  log: (message: string) => void;
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
// `subticketLimit` subtickets (default 10) for a human to reconfirm, or runs
// unbounded when passed Infinity. Everything is resumable: a re-run reads the
// ladder and continues from the first unchecked box.
export async function runGreg(
  base: HarnessConfig,
  subticketLimit: number = MAX_SUBTICKETS,
  deps: Partial<GregDeps> = {},
  ladderPath: string = LADDER_PATH,
): Promise<BuiltSubticket[]> {
  const plan = deps.plan ?? planNextMilestone;
  const harness = deps.harness ?? runHarness;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));

  await initLadder(ladderPath, NORTH_STAR);
  const repos = base.arms.map((arm) => arm.repo);
  for (const link of await ensureLadderLinks(ladderPath, repos)) {
    log(link.message);
  }

  const built: BuiltSubticket[] = [];

  while (built.length < subticketLimit) {
    const ladder = await readLadder(ladderPath);
    const pending = nextPendingSubticket(ladder);

    // Nothing left to build — Greg plans the next rung by editing the ladder,
    // then we loop back and pick up the subtickets he appended.
    if (!pending) {
      const milestoneNumber = highestMilestone(ladder) + 1;
      log(`\n=== Milestone ${milestoneNumber}: planning ===`);
      await plan(base, ladderPath, ladder, milestoneNumber);
      const planned = nextPendingSubticket(await readLadder(ladderPath));
      log(
        `Milestone ${milestoneNumber} planned${
          planned ? ` — first subticket ${planned.number}` : ""
        }`,
      );
      continue;
    }

    log(
      `  ${pending.number} ${pending.title}${
        pending.ticket ? ` (${pending.ticket})` : ""
      }: building…`,
    );

    // Mechanical harness run — the two arms build this subticket. Greg is not in
    // the loop here; the ladder already records the intent. Any failure halts
    // the whole run loudly rather than silently checking the box and moving on:
    // the subticket is left unchecked so a re-run retries it.
    let run: HarnessRunResult;
    try {
      run = await harness({ ...base, ticket: pending.description });
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

    await completeSubticket(ladderPath, pending.number, runOutcome(run));
    log(`  ${pending.number}: ${run.status} → ${run.artifactDir}`);
    built.push({
      number: pending.number,
      milestone: pending.milestone,
      title: pending.title,
      run,
    });
  }

  return built;
}

// Greg without the harness: plans milestones onto the ladder — filing Linear
// tickets and appending checkbox subtickets exactly as `runGreg` would — but
// never builds anything. Unlike `runGreg`, this keeps planning new milestones
// even while earlier ones are still unbuilt (`runGreg`'s "no pending subticket"
// gate would otherwise stop it after the first). Nothing is checked off, so a
// later `runGreg` picks up and builds every subticket queued here, oldest
// first. `subticketLimit` caps how many subtickets get planned this run, same
// runaway guard as `runGreg`.
export async function planAhead(
  base: HarnessConfig,
  subticketLimit: number = MAX_SUBTICKETS,
  deps: Partial<GregDeps> = {},
  ladderPath: string = LADDER_PATH,
): Promise<PlannedSubticket[]> {
  const plan = deps.plan ?? planNextMilestone;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));

  await initLadder(ladderPath, NORTH_STAR);
  const repos = base.arms.map((arm) => arm.repo);
  for (const link of await ensureLadderLinks(ladderPath, repos)) {
    log(link.message);
  }

  const planned: PlannedSubticket[] = [];

  while (planned.length < subticketLimit) {
    const ladder = await readLadder(ladderPath);
    const before = parseSubtickets(ladder).length;
    const milestoneNumber = highestMilestone(ladder) + 1;
    log(`\n=== Milestone ${milestoneNumber}: planning ahead ===`);
    await plan(base, ladderPath, ladder, milestoneNumber);

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
  }

  return planned;
}
