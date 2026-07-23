import { resolve } from "node:path";
import type { HarnessConfig } from "../config.js";
import { runHarness, type HarnessRunResult } from "../harness.js";
import {
  appendRunOutcome,
  appendRungPlan,
  ensureLadderLinks,
  initLadder,
  readLadder,
  type Rung,
} from "./ladder.js";
import { NORTH_STAR, proposeRung, type PlannedRung } from "./planner.js";

// The one shared ladder, mounted into both checkouts.
export const LADDER_PATH = resolve("LADDER.md");

// Runaway guard: Greg pauses after this many rungs so a human reconfirms before
// he climbs further. Re-running continues from the ladder; --unbounded removes
// the cap entirely.
export const MAX_RUNGS = 10;

export interface GregIteration {
  rung: Rung;
  run: HarnessRunResult;
}

// Injectable so the loop can be tested without spawning Greg or the arms.
export interface GregDeps {
  propose: (
    base: HarnessConfig,
    ladderPath: string,
    ladder: string,
    index: number,
  ) => Promise<PlannedRung>;
  harness: (config: HarnessConfig) => Promise<HarnessRunResult>;
  log: (message: string) => void;
}

// The whole of Greg Tile: a mechanical loop, not an agent that decides. Greg
// (the agent) only plans one rung; the loop appends it to the ladder and then
// runs the harness on it directly — never as one of Greg's tool calls. The
// North Star is a direction, not a destination, so the loop has no natural end;
// it pauses after `rungLimit` rungs (default 10) for a human to reconfirm, or
// runs unbounded when passed Infinity.
export async function runGreg(
  base: HarnessConfig,
  rungLimit: number = MAX_RUNGS,
  deps: Partial<GregDeps> = {},
  ladderPath: string = LADDER_PATH,
): Promise<GregIteration[]> {
  const propose = deps.propose ?? proposeRung;
  const harness = deps.harness ?? runHarness;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));

  await initLadder(ladderPath, NORTH_STAR);
  const repos = base.arms.map((arm) => arm.repo);
  for (const link of await ensureLadderLinks(ladderPath, repos)) {
    log(link.message);
  }

  const iterations: GregIteration[] = [];
  for (let index = 1; index <= rungLimit; index += 1) {
    log(`\n=== Rung ${index}: planning ===`);
    const ladder = await readLadder(ladderPath);
    const rung: Rung = { index, ...(await propose(base, ladderPath, ladder, index)) };

    await appendRungPlan(ladderPath, rung);
    log(`Rung ${index}: ${rung.title}${rung.ticket ? ` (${rung.ticket})` : ""}`);

    // Mechanical harness run — the two arms build this rung. Greg is not in the
    // loop here; the ladder already records the intent above.
    log(`Rung ${index}: running both arms…`);
    const run = await harness({ ...base, ticket: rung.description });
    await appendRunOutcome(ladderPath, run);
    log(`Rung ${index}: ${run.status} → ${run.artifactDir}`);

    iterations.push({ rung, run });
  }

  return iterations;
}
