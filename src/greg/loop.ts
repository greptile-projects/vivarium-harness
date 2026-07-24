import { resolve } from "node:path";
import type { HarnessConfig } from "../config.js";
import { runHarness, type HarnessRunResult } from "../harness.js";
import {
  completeSubticket,
  ensureLadderLinks,
  errorOutcome,
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

// How many rungs one invocation climbs. A rung is a whole milestone: the loop
// plans it and builds all its subtickets, then stops so a human can look before
// climbing further (`bun run continue` does the next rung). This is the runaway
// guard — the climb is a direction with no finish line, so it never runs on its
// own past a rung boundary. --unbounded (Infinity) removes the stop.
export const MILESTONES_PER_RUN = 1;

// One subticket the loop built this run, tagged with its milestone.
export interface BuiltSubticket {
  number: string;
  milestone: number;
  title: string;
  // The harness result, or `error` when the harness itself threw (an
  // infrastructure failure, distinct from an arm failing inside a run).
  run?: HarnessRunResult;
  error?: string;
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
// then checks its box and records the outcome. Greg is blind to the builders, so
// a subticket is simply "built" once its harness run returns (pass or fail).
//
// One call climbs `milestoneLimit` whole rungs (default 1): it plans a milestone
// when none is pending, builds every subticket in it, and stops once that many
// milestones have been fully built — so `bun run greg` / `bun run continue` each
// advance exactly one rung. A run that finds a half-built milestone on the
// ladder finishes it first, and that counts as the rung. Pass Infinity to climb
// without stopping. Everything is resumable: a re-run reads the ladder and
// continues from the first unchecked box.
export async function runGreg(
  base: HarnessConfig,
  milestoneLimit: number = MILESTONES_PER_RUN,
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
  let rungsClimbed = 0;

  while (rungsClimbed < milestoneLimit) {
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
    // the loop here; the ladder already records the intent. Checking the box is
    // what advances the loop, so we check it whether the run succeeds OR the
    // harness throws (infrastructure failure) — otherwise the same subticket
    // would rebuild forever. The outcome line preserves which happened.
    try {
      const run = await harness({ ...base, ticket: pending.description });
      await completeSubticket(ladderPath, pending.number, runOutcome(run));
      log(`  ${pending.number}: ${run.status} → ${run.artifactDir}`);
      built.push({
        number: pending.number,
        milestone: pending.milestone,
        title: pending.title,
        run,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await completeSubticket(ladderPath, pending.number, errorOutcome(message));
      log(`  ${pending.number}: harness error — ${message}`);
      built.push({
        number: pending.number,
        milestone: pending.milestone,
        title: pending.title,
        error: message,
      });
    }

    // A rung is climbed when the milestone we were building has no unchecked
    // subtickets left. Subtickets in a milestone are contiguous and built in
    // order, so this fires on the last one — completing the whole rung.
    const remaining = parseSubtickets(await readLadder(ladderPath)).some(
      (subticket) =>
        subticket.milestone === pending.milestone && !subticket.done,
    );
    if (!remaining) {
      rungsClimbed += 1;
      log(`  milestone ${pending.milestone} complete (rung ${rungsClimbed})`);
    }
  }

  return built;
}
