#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "./ui.js";
import { LiveStore, summarize } from "./store.js";
import type { CodexMsg } from "./stream.js";
import { runHarness, type ArmEventSink } from "../harness.js";
import { parseArgs, validateConfig, type HarnessConfig } from "../config.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
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

  const control = await mkdtemp(join(tmpdir(), "terrarium-control-"));
  const greptile = await mkdtemp(join(tmpdir(), "terrarium-greptile-"));
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
      resultsDir: process.env.RESULTS_DIR ?? "results",
      codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
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

  const app = useTui ? render(<App store={store} ticket={config.ticket} />) : undefined;
  if (!useTui) {
    process.stdout.write(
      `terrarium live${demo ? " (demo)" : ""} · ${config.arms.length} arms · log: ${logPath}\n`,
    );
  }

  // Single run: durable artifacts under runHarness, live events via onEvent.
  const run = await runHarness(config, onEvent);
  for (const result of run.results) {
    store.finish(result.arm, {
      threadId: result.threadId,
      error:
        result.status === "failed" ? result.error ?? "arm failed" : undefined,
    });
  }

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
