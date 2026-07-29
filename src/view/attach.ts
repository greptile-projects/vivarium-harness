import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { HarnessSinks } from "../harness/harness.js";
import type { LandingRecord } from "../harness/land.js";
import { LiveStore, NOISY, summarize } from "./store.js";
import type { CodexMsg } from "../harness/session.js";

// The one place raw `codex/event` traffic is turned into something a human can
// watch: it updates the store the Ink panels render from, tees a readable line
// into that arm's progress.log, and echoes that line to stdout when no TUI is
// mounted. Everything that attaches a live view shares this — the wiring
// used to be copy-pasted per entrypoint, which is how the two drifted apart.
//
// Each arm gets its own log file. One combined file read fine live, where the
// label column tells the arms apart, but the artifact of this experiment is a
// *pair* of independent builds, and reading one arm's three-hour run meant
// grepping the other one out of every line first. The interleaved view
// survives where it belongs — in the log tab.
//
// Where those files go is not this module's business: it is handed targets
// (see LogTargets) and asks them per line. `harness/state.ts` spells the
// actual paths, beside the run records the feeds describe.
// Every harness sink is filled in here (they are optional on HarnessSinks so a
// caller can supply a subset; a live view never does), so callers can use them
// without a null check.
export interface LiveSinks extends Required<HarnessSinks> {
  // Loop-level lines that belong to no arm (Greg's climb notes).
  note: (message: string) => void;
  // Await pending log writes before the process exits.
  flush: () => Promise<void>;
}

// Where a feed lands *right now*. The climb re-points this as it moves between
// planning a rung and building a subticket, because the destination is a
// property of what is being written rather than of the process writing it:
// an arm's commentary belongs in that subticket's run directory, Greg's in
// that rung's plan directory. Returning undefined discards the line, which is
// what a caller with no destination yet (or no interest in files) gets.
//
// Resolved per line rather than captured once, so a feed opened before the
// first subticket exists still lands correctly once one does.
export interface LogTargets {
  // The file for this arm's feed, or undefined to discard it.
  arm?: (arm: string) => string | undefined;
  // The file for loop-level lines belonging to no arm.
  climb?: () => string | undefined;
}

export function attachLive(
  store: LiveStore,
  options: {
    useTui: boolean;
    logs?: LogTargets;
    startedAt?: number;
    // Mirror of what goes to the log files, for the TUI's log tab. Same text,
    // same moment — the tab is a window onto the files, not a second feed, and
    // it stays interleaved because live, watching both arms at once is the
    // point.
    onLine?: (line: string) => void;
    // Landing records, for the pull-request section on each arm's tab.
    onLanding?: (record: LandingRecord) => void;
  },
): LiveSinks {
  const startedAt = options.startedAt ?? Date.now();

  // Serialize appends through a promise chain (same shape as the manifest
  // writer): the sink is synchronous, so concurrent arms would otherwise
  // interleave half-written lines. Errors are swallowed per link so one failed
  // write cannot poison the rest of the log.
  let writes: Promise<void> = Promise.resolve();
  const ensured = new Set<string>();
  const append = (arm: string | undefined, line: string): void => {
    // Resolved at write time, not at attach time — the target moves as the
    // climb advances, and a line is filed where it belonged when it was said.
    const path = arm ? options.logs?.arm?.(arm) : options.logs?.climb?.();
    if (!path) return;
    writes = writes
      .then(async () => {
        if (!ensured.has(path)) {
          await mkdir(dirname(path), { recursive: true });
          ensured.add(path);
        }
        await appendFile(path, line);
      })
      .catch(() => {});
  };

  const emit = (arm: string | undefined, line: string): void => {
    append(arm, line);
    options.onLine?.(line);
    if (!options.useTui) process.stdout.write(line);
  };

  const stamp = (arm: string, kind: string, text: string): string => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const label = arm;
    return `${new Date().toISOString()}  +${elapsed}s  ${label.padEnd(8)}  ${kind.padEnd(22)}  ${text}\n`;
  };

  const tee = (arm: string, msg: CodexMsg): void => {
    if (NOISY.has(msg.type)) return;
    let line = stamp(arm, msg.type, summarize(msg));

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

    emit(arm, line);
  };

  return {
    onEvent: (arm, msg) => {
      store.applyEvent(arm, msg);
      tee(arm, msg);
    },
    // The landing phase — waiting on a review, merging — produces no
    // codex/event at all, so without this an arm looks frozen on its last
    // reasoning line for as long as review takes.
    onArmNote: (arm, text) => {
      store.note(arm, text);
      emit(arm, stamp(arm, "landing", text));
    },
    // A phase is a status word, not a line of progress: the notes around it
    // already say what happened, and teeing it too would double every
    // transition in the log.
    onArmPhase: (arm, phase) => store.phase(arm, phase),
    onLanding: (record) => options.onLanding?.(record),
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
    note: (message) => {
      for (const line of message.split("\n")) {
        if (!line.trim()) continue;
        emit(undefined, `${new Date().toISOString()}  ${line}\n`);
      }
    },
    flush: () => writes,
  };
}
