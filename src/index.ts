#!/usr/bin/env bun
import { parseArgs, usage, validateConfig } from "./config.js";
import { runHarness } from "./harness.js";

async function main(): Promise<void> {
  try {
    const config = await validateConfig(parseArgs(process.argv.slice(2)));
    const run = await runHarness(config);
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    if (run.status === "completed_with_failures") {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      process.stdout.write(`${usage}\n`);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n\n${usage}\n`);
    process.exitCode = 1;
  }
}

await main();
