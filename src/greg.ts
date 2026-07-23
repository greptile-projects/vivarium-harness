#!/usr/bin/env bun
import { parseArgs, usage, validateConfig } from "./config.js";
import { runGreg } from "./greg/loop.js";

const gregUsage = `Usage:
  bun run greg

Greg Tile is a stateless planner loop over the two-arm harness. Each turn he
plans one rung toward the North Star, files a Linear ticket, appends it to the
ladder (mounted into both checkouts), then mechanically runs the harness. He
keeps climbing until he reports the North Star is reached.

${usage}`;

async function main(): Promise<void> {
  try {
    // Greg adds no configuration of its own — it reuses the harness arm setup
    // and only fills the per-rung ticket. The placeholder ticket is overwritten
    // per rung by the loop.
    const base = await validateConfig(
      parseArgs(["--ticket", "greg-planner", ...process.argv.slice(2)], process.env),
    );
    const iterations = await runGreg(base);

    const withFailures = iterations.filter(
      (iteration) => iteration.run.status === "completed_with_failures",
    ).length;
    process.stdout.write(
      `\nGreg climbed ${iterations.length} rung(s); ${withFailures} run(s) completed with failures.\n`,
    );
    if (withFailures > 0) {
      process.exitCode = 1;
    }
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
