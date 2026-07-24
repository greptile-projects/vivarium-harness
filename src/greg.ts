#!/usr/bin/env bun
import { parseArgs, usage, validateConfig } from "./config.js";
import { MAX_SUBTICKETS, planAhead, runGreg } from "./greg/loop.js";

const gregUsage = `Usage:
  bun run greg [--unbounded]
  bun run greg -- --write-ahead [--unbounded]

Greg Tile is a stateless planner loop over the two-arm harness. Each turn he
plans one milestone (a rung) and its subtickets (1.1, 1.2, …), files them in
Linear, appends them to the ladder (mounted into both checkouts), then
mechanically runs the harness on each subticket. The North Star is a direction,
not a destination, so Greg pauses after ${MAX_SUBTICKETS} subtickets for you to
reconfirm; re-running continues the climb. Pass --unbounded to run without that
cap.

--write-ahead plans milestones onto the ladder without building anything —
useful for queuing up several rungs for review before spending harness runs on
them. It shares the same ${MAX_SUBTICKETS}-subticket cap (also liftable with
--unbounded). A later \`bun run greg\` builds everything queued this way.

${usage}`;

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const unbounded = argv.includes("--unbounded");
    const writeAhead = argv.includes("--write-ahead");
    // Greg adds no configuration of its own — it reuses the harness arm setup
    // and only fills the per-subticket ticket. The placeholder ticket is
    // overwritten per subticket by the loop.
    const base = await validateConfig(
      parseArgs(["--ticket", "greg-planner", ...argv], process.env),
    );

    // Unbounded never returns; the capped run pauses for a human to reconfirm.
    const limit = unbounded ? Infinity : MAX_SUBTICKETS;

    if (writeAhead) {
      const planned = await planAhead(base, limit);
      const milestones = new Set(planned.map((subticket) => subticket.milestone)).size;
      process.stdout.write(
        `\nGreg planned ${planned.length} subticket(s) across ${milestones} milestone(s) without building any. Re-run \`bun run greg\` to build them, or \`bun run greg -- --write-ahead\` to plan further ahead.\n`,
      );
      return;
    }

    const built = await runGreg(base, limit);
    const milestones = new Set(built.map((subticket) => subticket.milestone)).size;
    process.stdout.write(
      `\nGreg paused after ${built.length} subticket(s) across ${milestones} milestone(s). Re-run \`bun run greg\` to climb further, or \`bun run greg -- --unbounded\` to run without a cap.\n`,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      process.stdout.write(`${gregUsage}\n`);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n\n${gregUsage}\n`);
    process.exitCode = 1;
  }
}

await main();
