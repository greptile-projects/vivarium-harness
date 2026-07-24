import { LADDER_PATH } from "./loop.js";
import { parseSubtickets, readLadder } from "./ladder.js";
import {
  closeSubticketInLinear,
  fileMilestoneInLinear,
  type MilestoneFiler,
  type SubticketCloser,
} from "./linear.js";

// Put the board back in step with the ladder after an interrupted climb.
//
// The ladder survives a crash — it is the state, and a box is only ever checked
// after a run actually succeeded. Linear does not survive it as cleanly, because
// filing and closing are separate steps from the build and neither is retried:
//
//   - a crash between `completeSubticket` and `close` (loop.ts) leaves a built
//     subticket's issue open forever; the next run reads the box as `[x]` and
//     walks straight past it;
//   - a crash inside the filer leaves the rest of that rung's subtickets
//     unstamped, and filing only ever runs immediately after planning — so the
//     next run, which finds pending subtickets and skips planning, never files
//     them either.
//
// Neither drifts the *build* (ids are bookkeeping), but both leave the board
// lying about the climb. This pass reads the ladder — still the only source of
// truth — and makes Linear agree with it again.

// What the ladder says Linear ought to look like. Derived from the file alone,
// so it can be computed and inspected without touching the network.
export interface ReconcilePlan {
  // Built subtickets (`[x]`) carrying an id: their issues must be Done. We
  // cannot tell from the ladder which are already closed, and we do not need
  // to — closing an issue that is already closed is a no-op, so re-closing the
  // whole set is the self-healing move.
  close: Array<{ number: string; ticket: string }>;
  // Milestones with at least one subticket missing an id. Filing is idempotent
  // per subticket (headings that already carry an id are skipped), so re-filing
  // one of these finishes it without double-stamping anything.
  file: number[];
}

export function reconcilePlan(ladder: string): ReconcilePlan {
  const subtickets = parseSubtickets(ladder);

  const close = subtickets
    .filter((subticket) => subticket.done && subticket.ticket)
    .map((subticket) => ({
      number: subticket.number,
      ticket: subticket.ticket as string,
    }));

  const file = [
    ...new Set(
      subtickets
        .filter((subticket) => !subticket.ticket)
        .map((subticket) => subticket.milestone),
    ),
  ].sort((a, b) => a - b);

  return { close, file };
}

export interface ReconcileDeps {
  file: MilestoneFiler;
  close: SubticketCloser;
}

// Run the plan. Unlike the climb, this fails OPEN throughout — including on the
// closes, which halt the loop when they fail there. The difference is what a
// failure means: mid-climb, a close that cannot be performed means the board is
// drifting from a run still in progress, and stopping is how that gets noticed.
// Here the drift has already happened and this pass exists to shrink it, so one
// unreachable issue must not abandon the rest. Whatever is left over is
// reported and fixed by running the pass again.
export async function reconcileLadder(
  ladderPath: string = LADDER_PATH,
  log: (message: string) => void = (message) =>
    process.stderr.write(`${message}\n`),
  deps: Partial<ReconcileDeps> = {},
): Promise<ReconcilePlan> {
  const file = deps.file ?? fileMilestoneInLinear;
  const close = deps.close ?? closeSubticketInLinear;

  const ladder = await readLadder(ladderPath);
  const plan = reconcilePlan(ladder);

  if (!plan.close.length && !plan.file.length) {
    log("reconcile: ladder and Linear already agree — nothing to do");
    return plan;
  }

  for (const milestone of plan.file) {
    log(`reconcile: filing unstamped subtickets under milestone ${milestone}`);
    try {
      await file(ladderPath, milestone, log);
    } catch (error) {
      log(`  filing milestone ${milestone} failed: ${message(error)}`);
    }
  }

  for (const subticket of plan.close) {
    try {
      await close(subticket.ticket, subticket.number, log);
    } catch (error) {
      log(`  ${subticket.number}: ${message(error)}`);
    }
  }

  return plan;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Invoked by scripts/resume-clean.sh --reconcile-linear.
if (import.meta.main) {
  await reconcileLadder();
}
