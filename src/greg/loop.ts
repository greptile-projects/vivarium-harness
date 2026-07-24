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
  }

  return built;
}
