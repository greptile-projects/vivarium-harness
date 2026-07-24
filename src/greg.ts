#!/usr/bin/env bun
import { parseArgs, usage, validateConfig } from "./config.js";
import { MAX_SUBTICKETS, runGreg } from "./greg/loop.js";

const gregUsage = `Usage:
  bun run greg [--unbounded]

Greg Tile is a stateless planner loop over the two-arm harness. Each turn he
plans one milestone (a rung) and its subtickets (1.1, 1.2, …), files them in
Linear, appends them to the ladder (mounted into both checkouts), then
mechanically runs the harness on each subticket. The North Star is a direction,
not a destination, so Greg pauses after ${MAX_SUBTICKETS} subtickets for you to
reconfirm; re-running continues the climb. Pass --unbounded to run without that
cap.

${usage}`;

async function main(): Promise<void> {
  try {
    const unbounded = process.argv.slice(2).includes("--unbounded");
    // Greg adds no configuration of its own — it reuses the harness arm setup
    // and only fills the per-subticket ticket. The placeholder ticket is
    // overwritten per subticket by the loop.
    const base = await validateConfig(
      parseArgs(["--ticket", "greg-planner", ...process.argv.slice(2)], process.env),
    );

    // Unbounded never returns; the capped run pauses for a human to reconfirm.
    const milestones = await runGreg(base, unbounded ? Infinity : MAX_SUBTICKETS);
    const subtickets = milestones.reduce(
      (total, milestone) => total + milestone.subtickets.length,
      0,
    );
    process.stdout.write(
      `\nGreg paused after ${subtickets} subticket(s) across ${milestones.length} milestone(s). Re-run \`bun run greg\` to climb further, or \`bun run greg -- --unbounded\` to run without a cap.\n`,
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
