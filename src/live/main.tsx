#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "./ui.js";
import { LiveStore, summarize } from "./store.js";
import type { CodexMsg } from "./stream.js";
import {
  runHarness,
  type ArmCompleteSink,
  type ArmEventSink,
} from "../harness.js";
import {
  parseArgs,
  validateConfig,
  RESULTS_DIR,
  IDLE_TIMEOUT_MS,
  type HarnessConfig,
} from "../config.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  // Treat a missing value or a following flag as "not provided" rather than
  // silently consuming the next flag as the value.
  return value && !value.startsWith("--") ? value : undefined;
}

// Events worth surfacing as transitions; deltas and raw items stay in the
// stream but out of the human-readable tee.
const NOISY = new Set([
  "agent_message_content_delta",
  "raw_response_item",
  "raw_response_completed",
  "item_completed",
  "user_message",
]);

// The live view and the durable artifacts come from a single runHarness call.
// With the experiment repos configured we run them; otherwise we fall back to
// two throwaway checkouts so the feed can be exercised standalone.
async function buildConfig(
  ticket: string | undefined,
): Promise<{ config: HarnessConfig; demo: boolean }> {
  if (process.env.CONTROL_REPO && process.env.GREPTILE_REPO) {
    const config = await validateConfig(
      parseArgs(
        ["--ticket", ticket ?? "Describe this repository in one sentence."],
        process.env,
      ),
    );
    return { config, demo: false };
  }

  const control = await mkdtemp(join(tmpdir(), "vivarium-control-"));
  const greptile = await mkdtemp(join(tmpdir(), "vivarium-greptile-"));
  return {
    demo: true,
    config: {
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
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useTui = args.includes("--tui")
    ? true
    : args.includes("--no-tui")
      ? false
      : Boolean(process.stdout.isTTY);

  const { config, demo } = await buildConfig(flag(args, "--ticket"));

  const store = new LiveStore();
  for (const arm of config.arms) store.register(arm.name);

  const liveDir = resolve(
    config.resultsDir,
    `live-${new Date().toISOString().replaceAll(":", "-")}`,
  );
  await mkdir(liveDir, { recursive: true });
  const logPath = join(liveDir, "progress.log");
  const startedAt = Date.now();

  const tee = async (arm: string, msg: CodexMsg): Promise<void> => {
    if (NOISY.has(msg.type)) return;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const line = `${new Date().toISOString()}  +${elapsed}s  ${arm.padEnd(8)}  ${msg.type.padEnd(22)}  ${summarize(msg)}\n`;
    await appendFile(logPath, line);
    if (!useTui) process.stdout.write(line);
  };

  const onEvent: ArmEventSink = (arm, msg) => {
    store.applyEvent(arm, msg);
    void tee(arm, msg);
  };

  // Retire each arm's panel as soon as that arm settles, rather than waiting
  // for every arm to finish — otherwise a fast arm shows "working" until the
  // slowest one completes.
  const onArmComplete: ArmCompleteSink = (result) => {
    store.finish(result.arm, {
      threadId: result.threadId,
      error:
        result.status === "failed" ? result.error ?? "arm failed" : undefined,
    });
  };

  const app = useTui ? render(<App store={store} ticket={config.ticket} />) : undefined;
  if (!useTui) {
    process.stdout.write(
      `vivarium live${demo ? " (demo)" : ""} · ${config.arms.length} arms · log: ${logPath}\n`,
    );
  }

  // Single run: durable artifacts under runHarness, live events via onEvent.
  const run = await runHarness(config, onEvent, onArmComplete);

  if (app) {
    await app.waitUntilExit();
  } else {
    process.stdout.write(`\n=== ${run.status} ===\n`);
    for (const state of store.snapshot()) {
      process.stdout.write(
        `${state.arm.padEnd(8)} ${state.status.padEnd(7)} ${state.events} events · ${(state.tokens ?? 0).toLocaleString()} tok · thread ${state.threadId ?? "—"}\n`,
      );
    }
  }
  process.stdout.write(`\nartifacts:    ${run.artifactDir}\nprogress log: ${logPath}\n`);
}

await main();
