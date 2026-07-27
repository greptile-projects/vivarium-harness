import { resolve } from "node:path";
import { MAX_MILESTONES, type HarnessConfig } from "../config.js";
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
import {
  closeSubticketInLinear,
  fileMilestoneInLinear,
  type MilestoneFiler,
  type SubticketCloser,
} from "./linear.js";
import { NORTH_STAR, planNextMilestone } from "./planner.js";

// The one shared ladder, mounted into both checkouts.
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
  ) => Promise<void>;
  // Files the freshly planned milestone in Linear (rung milestone + chained
  // issues) and stamps the ids onto the ladder headings. Mechanical, so it
  // belongs to the loop — Greg's headless session cannot do it (codex blocks
  // destructive MCP tool calls on an approval no headless session can answer).
  file: MilestoneFiler;
  // Moves a built subticket's Linear issue to Done after its box is checked.
  // Fails CLOSED (halts the run) — see closeSubticketInLinear.
  close: SubticketCloser;
  harness: (config: HarnessConfig) => Promise<HarnessRunResult>;
  log: (message: string) => void;
}

// Ticket ids are bookkeeping, not build state: a filing failure logs and the
// climb continues. The filer itself already swallows Linear errors; this guard
// also covers an injected filer that throws.
async function fileSafely(
  file: MilestoneFiler,
  ladderPath: string,
  milestoneNumber: number,
  log: (message: string) => void,
): Promise<void> {
  try {
    await file(ladderPath, milestoneNumber, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`  Linear filing failed (continuing without ids): ${message}`);
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
  const file = deps.file ?? fileMilestoneInLinear;
  const close = deps.close ?? closeSubticketInLinear;
  const harness = deps.harness ?? runHarness;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));

  await initLadder(ladderPath, NORTH_STAR);
  const repos = base.arms.map((arm) => arm.repo);
  for (const link of await ensureLadderLinks(ladderPath, repos)) {
    log(link.message);
  }

  const built: BuiltSubticket[] = [];
  // Distinct milestones this run has built subtickets under — the unit the
  // pause counts.
  const milestonesTouched = new Set<number>();

  for (;;) {
    const ladder = await readLadder(ladderPath);
    const pending = nextPendingSubticket(ladder);

    // Nothing left to build — Greg plans the next rung by editing the ladder,
    // then we loop back and pick up the subtickets he appended. Unless this
    // run has already spent its rung budget: then it pauses instead.
    if (!pending) {
      if (milestonesTouched.size >= milestoneLimit) break;
      const milestoneNumber = highestMilestone(ladder) + 1;
      log(`\n=== Milestone ${milestoneNumber}: planning ===`);
      await plan(base, ladderPath, ladder, milestoneNumber);
      await fileSafely(file, ladderPath, milestoneNumber, log);
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
      milestonesTouched.size >= milestoneLimit
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
    // the subticket is left unchecked so a re-run retries it.
    let run: HarnessRunResult;
    try {
      run = await harness({
        ...base,
        ticket: pending.description,
        // Snapshotted into the run: the whole ladder is mounted into both
        // checkouts, so it is part of what the arms could read.
        ladderPath,
        // Which rung this run is: the ticket body alone leaves the run's own
        // artifacts unable to say, and the only link was the outcome line the
        // ladder gets *afterwards* — which a halted run never gets at all.
        subticket: {
          number: pending.number,
          milestone: pending.milestone,
          title: pending.title,
          ticket: pending.ticket,
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

    await completeSubticket(ladderPath, pending.number, runOutcome(run));
    log(`  ${pending.number}: ${run.status} → ${run.artifactDir}`);
    // Close the built subticket's Linear issue. Deliberately NOT fail-open
    // like filing: a throw here halts the climb (the box stays checked — the
    // build itself succeeded), so the board can never silently drift.
    await close(pending.ticket, pending.number, log);
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

// Greg without the harness: plans milestones onto the ladder — filing Linear
// tickets and appending checkbox subtickets exactly as `runGreg` would — but
// never builds anything. Unlike `runGreg`, this keeps planning new milestones
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
  const file = deps.file ?? fileMilestoneInLinear;
  const log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));

  await initLadder(ladderPath, NORTH_STAR);
  const repos = base.arms.map((arm) => arm.repo);
  for (const link of await ensureLadderLinks(ladderPath, repos)) {
    log(link.message);
  }

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
    await plan(base, ladderPath, ladder, milestoneNumber);
    await fileSafely(file, ladderPath, milestoneNumber, log);

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
