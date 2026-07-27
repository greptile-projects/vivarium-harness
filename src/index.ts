#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { armsForDisplay } from "./harness/arms.js";
import {
  MAX_MILESTONES,
  RESULTS_DIR,
  parseArgs,
  parseRunMode,
  usage,
  validateConfig,
} from "./harness/config.js";
import { runGregLive } from "./climb.js";
import { landingSummary } from "./harness/land.js";
import { runTicketLive } from "./ticket.js";

// The single entrypoint. Default behaviour is the experiment itself: Greg
// plans the next rung onto the ladder and the two arms build its subtickets,
// on and on. Everything else here is an option on that one loop — building a
// single ad-hoc ticket, or planning without building — not a separate command
// with its own contract.

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${usage}\n`);
      return;
    }

    const mode = parseRunMode(argv, Boolean(process.stdout.isTTY));
    const { json, useTui, planOnly, abortOnQuit } = mode;

    // Every mode writes its human-readable feed under the same directory —
    // one progress.log per arm, plus ladder.log for the climb's own lines.
    // Created only once a run is actually about to start, so a config error
    // does not leave an empty live-<ts> directory behind.
    const logDir = resolve(
      RESULTS_DIR,
      `live-${new Date().toISOString().replaceAll(":", "-")}`,
    );
    const logs = `${logDir}/<arm>/progress.log`;

    if (mode.kind !== "ladder") {
      const config = await validateConfig(parseArgs(argv, process.env));
      await mkdir(logDir, { recursive: true });

      if (!useTui) {
        process.stdout.write(
          `vivarium · one ticket · ${config.arms.length} arms · logs: ${logs}\n`,
        );
      }

      const { run, store } = await runTicketLive(config, {
        useTui,
        logDir,
        abortOnQuit,
      });

      // The summary prints in every non-JSON mode, including the TUI: the
      // fullscreen view gives the terminal back on exit, so this is all the
      // human is left holding.
      if (json) {
        process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      } else {
        process.stdout.write(`\n=== ${run.status} ===\n`);
        for (const state of armsForDisplay(store.snapshot())) {
          const label = state.arm;
          process.stdout.write(
            `${label.padEnd(8)} ${state.status.padEnd(7)} ${state.events} events · ${(state.tokens ?? 0).toLocaleString()} tok · thread ${state.threadId ?? "—"}\n`,
          );
          // What the arm actually landed — the pull request is the deliverable,
          // so it belongs in the last thing the human is left holding.
          const landing = run.landings.find(
            (record) => record.arm === state.arm,
          );
          if (landing && landing.status !== "skipped") {
            process.stdout.write(
              `         ${landingSummary(landing)}${landing.pullRequest ? `\n         ${landing.pullRequest.url}` : ""}\n`,
            );
          }
        }
      }
      process.stdout.write(
        `\nartifacts:     ${run.artifactDir}\nprogress logs: ${logs}\n`,
      );

      if (run.status === "completed_with_failures") {
        process.exitCode = 1;
      }
      return;
    }

    // Ladder mode. Greg adds no configuration of its own — it reuses the arm
    // setup and fills the ticket per subticket, so the placeholder below is
    // only there to satisfy the shared parser.
    const base = await validateConfig(
      parseArgs(["--ticket", "greg-planner", ...argv], process.env),
    );
    await mkdir(logDir, { recursive: true });
    const limit = mode.unbounded ? Infinity : MAX_MILESTONES;

    const subtickets = await runGregLive(base, limit, planOnly, {
      useTui,
      logDir,
      abortOnQuit,
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
