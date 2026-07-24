#!/usr/bin/env bun
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { armDisplayName, armsForDisplay } from "./arms.js";
import {
  IDLE_TIMEOUT_MS,
  MAX_MILESTONES,
  RESULTS_DIR,
  parseArgs,
  parseRunMode,
  usage,
  validateConfig,
  type HarnessConfig,
} from "./config.js";
import { runGregLive } from "./greg/main.js";
import { runTicketLive } from "./live/run.js";

// The single entrypoint. Default behaviour is the experiment itself: Greg
// plans the next rung onto the ladder and the two arms build its subtickets,
// on and on. Everything else here is an option on that one loop — building a
// single ad-hoc ticket, planning without building, or a throwaway smoke run —
// not a separate command with its own contract.

// Two throwaway checkouts so the harness and the live feed can be exercised
// without touching the experiment's repos. Read-only and single-attempt: this
// is a smoke test of the plumbing, never a real run.
async function demoConfig(ticket: string | undefined): Promise<HarnessConfig> {
  const control = await mkdtemp(join(tmpdir(), "vivarium-control-"));
  const greptile = await mkdtemp(join(tmpdir(), "vivarium-greptile-"));
  return {
    ticket:
      ticket ??
      "Smoke: reply with the single word DONE, make no changes, do not open a PR.",
    arms: [
      { name: "control", repo: control },
      { name: "greptile", repo: greptile },
    ],
    sandbox: "read-only",
    resultsDir: RESULTS_DIR,
    codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    maxAttempts: 1,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  };
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${usage}\n`);
      return;
    }

    const mode = parseRunMode(argv, Boolean(process.stdout.isTTY));
    const { json, useTui, planOnly, abortOnQuit } = mode;

    // Every mode writes its human-readable feed to the same place. Created
    // only once a run is actually about to start, so a config error does not
    // leave an empty live-<ts> directory behind.
    const liveDir = resolve(
      RESULTS_DIR,
      `live-${new Date().toISOString().replaceAll(":", "-")}`,
    );
    const logPath = join(liveDir, "progress.log");

    if (mode.kind !== "ladder") {
      const config =
        mode.kind === "demo"
          ? await demoConfig(mode.ticket)
          : await validateConfig(parseArgs(argv, process.env));
      await mkdir(liveDir, { recursive: true });

      if (!useTui) {
        process.stdout.write(
          `vivarium${mode.kind === "demo" ? " (demo)" : ""} · one ticket · ${config.arms.length} arms · log: ${logPath}\n`,
        );
      }

      // The demo is a look at the live view, so it does not close itself when
      // the arms settle — the final frame stays until the human quits it. A
      // real ticket run still unmounts straight into the summary.
      const { run, store } = await runTicketLive(config, {
        useTui,
        logPath,
        hold: mode.kind === "demo",
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
          const label = armDisplayName(state.arm);
          process.stdout.write(
            `${label.padEnd(8)} ${state.status.padEnd(7)} ${state.events} events · ${(state.tokens ?? 0).toLocaleString()} tok · thread ${state.threadId ?? "—"}\n`,
          );
        }
      }
      process.stdout.write(
        `\nartifacts:    ${run.artifactDir}\nprogress log: ${logPath}\n`,
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
    await mkdir(liveDir, { recursive: true });
    const limit = mode.unbounded ? Infinity : MAX_MILESTONES;

    const subtickets = await runGregLive(base, limit, planOnly, {
      useTui,
      logPath,
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
    process.stdout.write(`progress log: ${logPath}\n`);
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
