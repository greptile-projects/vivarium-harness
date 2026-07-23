#!/usr/bin/env bun
import { parseArgs, usage, validateConfig } from "./config.js";
import { MAX_RUNGS, runGreg } from "./greg/loop.js";

const gregUsage = `Usage:
  bun run greg [--unbounded]

Greg Tile is a stateless planner loop over the two-arm harness. Each turn he
plans one rung toward the North Star, files a Linear ticket, appends it to the
ladder (mounted into both checkouts), then mechanically runs the harness. The
North Star is a direction, not a destination, so Greg pauses after ${MAX_RUNGS} rungs
for you to reconfirm; re-running continues the climb. Pass --unbounded to run
without that cap.

${usage}`;

async function main(): Promise<void> {
  try {
    const unbounded = process.argv.slice(2).includes("--unbounded");
    // Greg adds no configuration of its own — it reuses the harness arm setup
    // and only fills the per-rung ticket. The placeholder ticket is overwritten
    // per rung by the loop.
    const base = await validateConfig(
      parseArgs(["--ticket", "greg-planner", ...process.argv.slice(2)], process.env),
    );

    // Unbounded never returns; the capped run pauses for a human to reconfirm.
    const iterations = await runGreg(base, unbounded ? Infinity : MAX_RUNGS);
    process.stdout.write(
      `\nGreg paused after ${iterations.length} rung(s). Re-run \`bun run greg\` to climb further, or \`bun run greg -- --unbounded\` to run without a cap.\n`,
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
