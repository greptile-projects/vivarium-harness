#!/usr/bin/env bun
import { parseArgs, usage, validateConfig } from "./config.js";
import { MILESTONES_PER_RUN, runGreg } from "./greg/loop.js";

const gregUsage = `Usage:
  bun run greg [--unbounded]        # climb the next rung
  bun run continue [--unbounded]    # same thing — climb the next rung

Greg Tile is a stateless planner loop over the two-arm harness. Each turn he
plans one milestone (a rung) and its subtickets (1.1, 1.2, …), files them in
Linear, appends them to the ladder (mounted into both checkouts), then
mechanically runs the harness on each subticket. The North Star is a direction,
not a destination, so one run climbs a single rung (one whole milestone) and
stops — run \`bun run continue\` to climb the next. Pass --unbounded to climb
every rung without stopping.

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

    // One rung per run, unless --unbounded climbs every rung without stopping.
    const built = await runGreg(base, unbounded ? Infinity : MILESTONES_PER_RUN);
    const milestones = new Set(built.map((subticket) => subticket.milestone)).size;
    process.stdout.write(
      `\nGreg climbed ${milestones} rung(s) — ${built.length} subticket(s) built. ` +
        `Run \`bun run continue\` to climb the next rung, or ` +
        `\`bun run greg -- --unbounded\` to climb without stopping.\n`,
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
