import type { HarnessConfig } from "../config.js";
import {
  runHarness,
  type ArmEventSink,
  type AttemptRunner,
} from "../harness.js";
import { attachLive } from "../live/attach.js";
import { LiveModel } from "../live/model.js";
import { runArmStreaming } from "../live/stream.js";
import { mountLive } from "../live/tui/app.js";
import { planAhead, runGreg, type GregDeps } from "./loop.js";
import { planNextMilestone } from "./planner.js";

// What the entrypoint needs for its closing summary — common to built and
// planned.
export interface GregSubticketSummary {
  number: string;
  milestone: number;
  title: string;
}

// Wire one Greg run (the build loop, or write-ahead planning) to a live view:
// the fullscreen TUI on a terminal, or plain tee lines when piped. The loop
// itself is untouched — this only supplies its injectable deps, so the
// planner's and the builders' codex/event streams are observable instead of
// discarded (a silent multi-minute planning session is what used to look like a
// hang).
export async function runGregLive(
  base: HarnessConfig,
  limit: number,
  writeAhead: boolean,
  options: { useTui: boolean; logPath?: string },
): Promise<GregSubticketSummary[]> {
  const { useTui } = options;
  // The climb's log lines are its own tab ("ladder"), separate from the raw
  // codex feed — they are the part a human actually reads.
  const model = new LiveModel("greg tile", "starting…", "ladder");
  const sinks = attachLive(model.live, {
    ...options,
    onLine: (line) => model.appendLog(line),
  });
  const onEvent: ArmEventSink = sinks.onEvent;

  // The planner's own Codex session, surfaced as a "greg" tab.
  const plannerRunner: AttemptRunner = (params) =>
    runArmStreaming(params, (msg) => onEvent(params.arm, msg));

  // `file` is left to the loop's default (the mechanical Linear filer).
  const deps: Partial<GregDeps> = {
    plan: async (config, ladderPath, ladder, milestoneNumber) => {
      model.setPhase(`milestone ${milestoneNumber} · planning`, ["greg"]);
      try {
        await planNextMilestone(
          config,
          ladderPath,
          ladder,
          milestoneNumber,
          plannerRunner,
        );
        model.live.finish("greg", {});
      } catch (error) {
        model.live.finish("greg", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    harness: (config) => {
      model.setPhase(
        `building · ${config.ticket.replace(/\s+/g, " ").slice(0, 80)}`,
        config.arms.map((arm) => arm.name),
      );
      return runHarness(config, onEvent, sinks.onArmComplete);
    },
    log: (message) => {
      if (useTui) model.note(message);
      else process.stderr.write(`${message}\n`);
    },
  };

  const app = useTui ? mountLive(model, options) : undefined;

  let halted = true;
  try {
    const subtickets = writeAhead
      ? await planAhead(base, limit, deps)
      : await runGreg(base, limit, deps);
    halted = false;
    return subtickets;
  } finally {
    // Hand the terminal back before the entrypoint prints its summary (or the
    // error) — anything written while the alternate screen is up is lost.
    if (app) {
      model.finish(
        halted ? "halted" : writeAhead ? "planned ahead" : "paused",
      );
      await app.waitUntilExit();
    }
    await sinks.flush();
  }
}
