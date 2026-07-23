#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "./ui.js";
import { LiveStore, summarize } from "./store.js";
import { runArmStreaming, type CodexMsg } from "./stream.js";

interface ArmSpec {
  name: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

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

async function resolveArms(): Promise<{ arms: ArmSpec[]; demo: boolean }> {
  const control = process.env.CONTROL_REPO;
  const greptile = process.env.GREPTILE_REPO;
  const sandbox =
    (process.env.CODEX_SANDBOX as ArmSpec["sandbox"]) ?? "workspace-write";
  if (control && greptile) {
    return {
      demo: false,
      arms: [
        { name: "control", cwd: resolve(control), sandbox },
        { name: "greptile", cwd: resolve(greptile), sandbox },
      ],
    };
  }
  // Demo: two throwaway checkouts, read-only, so the live feed can be
  // exercised without the real experiment repos.
  const controlDir = await mkdtemp(join(tmpdir(), "terrarium-control-"));
  const greptileDir = await mkdtemp(join(tmpdir(), "terrarium-greptile-"));
  return {
    demo: true,
    arms: [
      { name: "control", cwd: controlDir, sandbox: "read-only" },
      { name: "greptile", cwd: greptileDir, sandbox: "read-only" },
    ],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ticket = flag(args, "--ticket");
  const useTui = args.includes("--tui")
    ? true
    : args.includes("--no-tui")
      ? false
      : Boolean(process.stdout.isTTY);

  const { arms, demo } = await resolveArms();
  const prompt =
    ticket ??
    (demo
      ? "Briefly reason about what 2+2 is, then reply with the answer."
      : "Describe this repository in one sentence.");

  const runDir = resolve(
    process.env.RESULTS_DIR ?? "results",
    `live-${new Date().toISOString().replaceAll(":", "-")}`,
  );
  await mkdir(runDir, { recursive: true });
  const logPath = join(runDir, "progress.log");
  const startedAt = Date.now();

  const store = new LiveStore();
  for (const arm of arms) store.register(arm.name);

  const tee = async (arm: string, msg: CodexMsg): Promise<void> => {
    if (NOISY.has(msg.type)) return;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const line = `${new Date().toISOString()}  +${elapsed}s  ${arm.padEnd(8)}  ${msg.type.padEnd(22)}  ${summarize(msg)}\n`;
    await appendFile(logPath, line);
    if (!useTui) process.stdout.write(line);
  };

  const app = useTui
    ? render(<App store={store} ticket={prompt} />)
    : undefined;

  if (!useTui) {
    process.stdout.write(
      `terrarium live${demo ? " (demo)" : ""} · ${arms.length} arms · log: ${logPath}\n`,
    );
  }

  await Promise.allSettled(
    arms.map(async (arm) => {
      try {
        const result = await runArmStreaming(
          {
            arm: arm.name,
            prompt,
            cwd: arm.cwd,
            sandbox: arm.sandbox,
            codexHome: process.env.CODEX_HOME,
          },
          (msg) => {
            store.applyEvent(arm.name, msg);
            void tee(arm.name, msg);
          },
        );
        store.finish(arm.name, {
          threadId: result.threadId,
          error: result.isError ? result.output || "arm reported an error" : undefined,
        });
      } catch (error) {
        store.finish(arm.name, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  if (app) {
    await app.waitUntilExit();
  } else {
    process.stdout.write("\n=== summary ===\n");
    for (const state of store.snapshot()) {
      process.stdout.write(
        `${state.arm.padEnd(8)} ${state.status.padEnd(7)} ${state.events} events · ${(state.tokens ?? 0).toLocaleString()} tok · thread ${state.threadId ?? "—"}\n`,
      );
    }
  }
  process.stdout.write(`\nprogress log: ${logPath}\n`);
}

await main();
