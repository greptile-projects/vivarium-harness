#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_MILESTONES,
  RESULTS_DIR,
  parseArgs,
  parseRunMode,
  usage,
  validateConfig,
} from "./harness/config.js";
import { runGregLive } from "./climb.js";

// The single entrypoint, and it runs the experiment itself: Greg plans the
// next rung onto the ladder and the two arms build its subtickets, on and on.
// Every flag is an option on that one loop — planning without building,
// lifting the pause — not a separate command with its own contract.

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${usage}\n`);
      return;
    }

    const mode = parseRunMode(argv, Boolean(process.stdout.isTTY));
    const { json, useTui, planOnly } = mode;

    // Every mode writes its human-readable feed under the same directory —
    // one progress.log per arm, plus ladder.log for the climb's own lines.
    // Created only once a run is actually about to start, so a config error
    // does not leave an empty live-<ts> directory behind.
    const logDir = resolve(
      RESULTS_DIR,
      `live-${new Date().toISOString().replaceAll(":", "-")}`,
    );
    const logs = `${logDir}/<arm>/progress.log`;

    const base = await validateConfig(parseArgs(argv, process.env));
    await mkdir(logDir, { recursive: true });
    const limit = mode.unbounded ? Infinity : MAX_MILESTONES;

    const subtickets = await runGregLive(base, limit, planOnly, {
      useTui,
      logDir,
    });
    const milestones = new Set(
      subtickets.map((subticket) => subticket.milestone),
    ).size;

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ mode: planOnly ? "plan-only" : "build", milestones, subtickets }, null, 2)}\n`,
      );
    } else if (planOnly) {
      process.stdout.write(
        `\nPlanned ${subtickets.length} subticket(s) across ${milestones} milestone(s) without building any. Run \`bun start\` to build them, or \`bun start -- --plan-only\` to plan further ahead.\n`,
      );
    } else {
      process.stdout.write(
        `\nPaused after ${subtickets.length} subticket(s) across ${milestones} milestone(s). Run \`bun start\` to climb further, or add --unbounded to run without a cap.\n`,
      );
    }
    process.stdout.write(`progress logs: ${logs}\n`);
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
