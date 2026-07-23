import type { HarnessConfig } from "../config.js";
import { runHarness, type HarnessRunResult } from "../harness.js";
import type { GregConfig } from "./config.js";
import {
  appendRunOutcome,
  appendRungPlan,
  ensureLadderLinks,
  initLadder,
  readLadder,
  type Rung,
} from "./ladder.js";
import { proposeRung, type RungOutcome } from "./planner.js";

export interface GregIteration {
  rung: Rung;
  run: HarnessRunResult;
}

// Injectable so the loop can be tested without spawning Greg or the arms.
export interface GregDeps {
  propose: (
    config: GregConfig,
    ladder: string,
    index: number,
  ) => Promise<RungOutcome>;
  harness: (config: HarnessConfig) => Promise<HarnessRunResult>;
  log: (message: string) => void;
}

// The whole of Greg Tile: a mechanical loop, not an agent that decides. Greg
// (the agent) only plans one rung; the loop appends it to the ladder and then
// runs the harness on it directly — never as one of Greg's tool calls.
export async function runGreg(
  config: GregConfig,
  deps: Partial<GregDeps> = {},
): Promise<GregIteration[]> {
  const propose = deps.propose ?? proposeRung;
  const harness = deps.harness ?? runHarness;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));

  await initLadder(config.ladderPath, config.northStar);
  const repos = config.base.arms.map((arm) => arm.repo);
  for (const link of await ensureLadderLinks(
    config.ladderPath,
    repos,
    config.ladderLinkName,
  )) {
    log(link.message);
  }

  const iterations: GregIteration[] = [];
  for (let index = 1; index <= config.maxRungs; index += 1) {
    log(`\n=== Rung ${index}/${config.maxRungs}: planning ===`);
    const ladder = await readLadder(config.ladderPath);
    const outcome = await propose(config, ladder, index);

    if (outcome.kind === "north-star-reached") {
      log("Greg reports the North Star is reached. Stopping the climb.");
      break;
    }

    const rung: Rung = { index, ...outcome.rung };
    await appendRungPlan(config.ladderPath, rung);
    log(`Rung ${index}: ${rung.title}${rung.ticket ? ` (${rung.ticket})` : ""}`);

    // Mechanical harness run — the two arms build this rung. Greg is not in the
    // loop here; the ladder already records the intent above.
    log(`Rung ${index}: running both arms…`);
    const run = await harness({ ...config.base, ticket: rung.description });
    await appendRunOutcome(config.ladderPath, run);
    log(`Rung ${index}: ${run.status} → ${run.artifactDir}`);

    iterations.push({ rung, run });
  }

  return iterations;
}
