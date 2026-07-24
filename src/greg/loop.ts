import { resolve } from "node:path";
import type { HarnessConfig } from "../config.js";
import { runHarness, type HarnessRunResult } from "../harness.js";
import {
  appendMilestone,
  appendSubticket,
  appendSubticketError,
  appendSubticketOutcome,
  countMilestones,
  ensureLadderLinks,
  initLadder,
  readLadder,
  type Milestone,
  type Subticket,
} from "./ladder.js";
import {
  NORTH_STAR,
  proposeMilestone,
  type PlannedMilestone,
} from "./planner.js";

// The one shared ladder, mounted into both checkouts.
export const LADDER_PATH = resolve("LADDER.md");

// Runaway guard: Greg pauses once he has built this many subtickets (harness
// runs) so a human reconfirms before he climbs further. The cap is checked at
// milestone boundaries, so the current milestone always finishes — overshoot is
// bounded because parseMilestone caps a milestone at MAX_SUBTICKETS_PER_MILESTONE.
// Re-running continues from the ladder; --unbounded (Infinity) removes the cap.
export const MAX_SUBTICKETS = 10;

export interface SubticketRun {
  subticket: Subticket;
  // The harness result, or `error` when the harness itself threw (an
  // infrastructure failure, distinct from an arm failing inside a run).
  run?: HarnessRunResult;
  error?: string;
}

export interface MilestoneResult {
  milestone: Milestone;
  subtickets: SubticketRun[];
}

// Injectable so the loop can be tested without spawning Greg or the arms.
export interface GregDeps {
  propose: (
    base: HarnessConfig,
    ladderPath: string,
    ladder: string,
    milestoneNumber: number,
  ) => Promise<PlannedMilestone>;
  harness: (config: HarnessConfig) => Promise<HarnessRunResult>;
  log: (message: string) => void;
}

// The whole of Greg Tile: a mechanical loop, not an agent that decides. Greg
// (the agent) only plans a milestone and its subtickets; the loop appends them
// to the ladder and runs the harness on each subticket directly — never as one
// of Greg's tool calls. Greg is blind to the builders, so a subticket is simply
// "done" once its harness run returns. The North Star is a direction, not a
// destination, so the loop pauses after `subticketLimit` subtickets (default
// 10) for a human to reconfirm, or runs unbounded when passed Infinity.
export async function runGreg(
  base: HarnessConfig,
  subticketLimit: number = MAX_SUBTICKETS,
  deps: Partial<GregDeps> = {},
  ladderPath: string = LADDER_PATH,
): Promise<MilestoneResult[]> {
  const propose = deps.propose ?? proposeMilestone;
  const harness = deps.harness ?? runHarness;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));

  await initLadder(ladderPath, NORTH_STAR);
  const repos = base.arms.map((arm) => arm.repo);
  for (const link of await ensureLadderLinks(ladderPath, repos)) {
    log(link.message);
  }

  const results: MilestoneResult[] = [];
  let built = 0;
  // Continue numbering after any milestones a previous run already recorded.
  let milestoneNumber = countMilestones(await readLadder(ladderPath));

  // Checked at milestone boundaries: the current milestone always builds fully.
  while (built < subticketLimit) {
    milestoneNumber += 1;
    log(`\n=== Milestone ${milestoneNumber}: planning ===`);
    const ladder = await readLadder(ladderPath);
    const planned = await propose(base, ladderPath, ladder, milestoneNumber);

    const milestone: Milestone = {
      number: milestoneNumber,
      title: planned.title,
      ticket: planned.ticket,
      summary: planned.summary,
    };
    await appendMilestone(ladderPath, milestone);
    log(
      `Milestone ${milestoneNumber}: ${milestone.title}${
        milestone.ticket ? ` (${milestone.ticket})` : ""
      } — ${planned.subtickets.length} subtickets`,
    );

    const subtickets: SubticketRun[] = [];
    for (let index = 0; index < planned.subtickets.length; index += 1) {
      const planSub = planned.subtickets[index];
      const subticket: Subticket = {
        number: `${milestoneNumber}.${index + 1}`,
        title: planSub.title,
        ticket: planSub.ticket,
        description: planSub.description,
      };
      await appendSubticket(ladderPath, subticket);
      log(
        `  ${subticket.number} ${subticket.title}${
          subticket.ticket ? ` (${subticket.ticket})` : ""
        }: building…`,
      );

      // Mechanical harness run — the two arms build this subticket. Greg is not
      // in the loop here; the ladder already records the intent above. If the
      // harness throws (infrastructure failure), record it and keep going: the
      // milestone must finish so its header on the ladder is not left standing
      // over un-built subtickets that a resumed run would skip.
      try {
        const run = await harness({ ...base, ticket: subticket.description });
        await appendSubticketOutcome(ladderPath, run);
        log(`  ${subticket.number}: ${run.status} → ${run.artifactDir}`);
        subtickets.push({ subticket, run });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendSubticketError(ladderPath, message);
        log(`  ${subticket.number}: harness error — ${message}`);
        subtickets.push({ subticket, error: message });
      }
      built += 1;
    }

    results.push({ milestone, subtickets });
  }

  return results;
}
