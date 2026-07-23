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
import { NORTH_STAR, proposeRung, type RungOutcome } from "./planner.js";

// The one shared ladder, mounted into both checkouts.
export const LADDER_PATH = resolve("LADDER.md");

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
  ) => Promise<RungOutcome>;
  harness: (config: HarnessConfig) => Promise<HarnessRunResult>;
  log: (message: string) => void;
}

// The whole of Greg Tile: a mechanical loop, not an agent that decides. Greg
// (the agent) only plans one rung; the loop appends it to the ladder and then
// runs the harness on it directly — never as one of Greg's tool calls. It keeps
// climbing until Greg reports the North Star is reached.
export async function runGreg(
  base: HarnessConfig,
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
  for (let index = 1; ; index += 1) {
    log(`\n=== Rung ${index}: planning ===`);
    const ladder = await readLadder(ladderPath);
    const outcome = await propose(base, ladderPath, ladder, index);

    if (outcome.kind === "north-star-reached") {
      log("Greg reports the North Star is reached. Stopping the climb.");
      break;
    }

    const rung: Rung = { index, ...outcome.rung };
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
