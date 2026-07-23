#!/usr/bin/env bun
import { gregUsage, parseGregConfig } from "./greg/config.js";
import { runGreg } from "./greg/loop.js";

async function main(): Promise<void> {
  try {
    const config = await parseGregConfig(process.argv.slice(2));
    const iterations = await runGreg(config);

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
