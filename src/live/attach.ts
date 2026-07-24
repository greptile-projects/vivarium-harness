import { appendFile } from "node:fs/promises";
import { armDisplayName } from "../arms.js";
import type { ArmCompleteSink, ArmEventSink } from "../harness.js";
import { LiveStore, NOISY, summarize } from "./store.js";
import type { CodexMsg } from "./stream.js";

// The one place raw `codex/event` traffic is turned into something a human can
// watch: it updates the store the Ink panels render from, tees a readable line
// into `progress.log`, and echoes that line to stdout when no TUI is mounted.
// Both run modes (one ticket, or Greg's climb) share this — the wiring used to
// be copy-pasted per entrypoint, which is how the two drifted apart.
export interface LiveSinks {
  onEvent: ArmEventSink;
  onArmComplete: ArmCompleteSink;
  // Await pending log writes before the process exits.
  flush: () => Promise<void>;
}

export function attachLive(
  store: LiveStore,
  options: {
    useTui: boolean;
    logPath?: string;
    startedAt?: number;
    // Mirror of what goes to progress.log, for the TUI's log tab. Same text,
    // same moment — the tab is a window onto the file, not a second feed.
    onLine?: (line: string) => void;
  },
): LiveSinks {
  const startedAt = options.startedAt ?? Date.now();

  // Serialize appends through a promise chain (same shape as the manifest
  // writer): the sink is synchronous, so concurrent arms would otherwise
  // interleave half-written lines. Errors are swallowed per link so one failed
  // write cannot poison the rest of the log.
  let writes: Promise<void> = Promise.resolve();
  const append = (line: string): void => {
    const path = options.logPath;
    if (!path) return;
    writes = writes.then(() => appendFile(path, line)).catch(() => {});
  };

  const tee = (arm: string, msg: CodexMsg): void => {
    if (NOISY.has(msg.type)) return;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const label = armDisplayName(arm);
    let line = `${new Date().toISOString()}  +${elapsed}s  ${label.padEnd(8)}  ${msg.type.padEnd(22)}  ${summarize(msg)}\n`;

    // The summary column truncates long payloads to keep the log scannable,
    // but the model's actual reply is worth keeping whole: when it outgrows
    // the summary, append it in full as indented continuation lines.
    if (
      msg.type === "agent_message" &&
      typeof msg.message === "string" &&
      msg.message.length > 60
    ) {
      const full = msg.message
        .trimEnd()
        .split("\n")
        .map((text) => `    │ ${text}`)
        .join("\n");
      line += `${full}\n`;
    }

    append(line);
    options.onLine?.(line);
    if (!options.useTui) process.stdout.write(line);
  };

  return {
    onEvent: (arm, msg) => {
      store.applyEvent(arm, msg);
      tee(arm, msg);
    },
    // Retire each arm's panel the moment that arm settles, rather than waiting
    // for every arm — otherwise a fast arm shows "working" until the slowest
    // one completes.
    onArmComplete: (result) => {
      store.finish(result.arm, {
        threadId: result.threadId,
        error:
          result.status === "failed" ? result.error ?? "arm failed" : undefined,
      });
    },
    flush: () => writes,
  };
}
