import type { HarnessConfig } from "./harness/config.js";
import {
  runHarness,
  type ArmEventSink,
  type AttemptRunner,
} from "./harness/harness.js";
import { attachLive } from "./view/attach.js";
import { LiveModel } from "./view/model.js";
import { onViewClosed } from "./view/quit.js";
import { runArmStreaming } from "./harness/session.js";
import { mountLive } from "./view/tui/app.js";
import {
  LADDER_PATH,
  planAhead,
  runGreg,
  type GregDeps,
} from "./greg-tile/loop.js";
import {
  nextPendingSubticket,
  parseSubtickets,
  readLadder,
} from "./greg-tile/ladder.js";
import { planNextMilestone } from "./greg-tile/planner.js";
import { readClimbState, statePath } from "./harness/state.js";

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
  options: { useTui: boolean; logDir?: string },
): Promise<GregSubticketSummary[]> {
  const { useTui } = options;
  const model = new LiveModel("greg tile", "starting…");

  // Everything the experiment has landed before this process started. The
  // ladder deliberately carries none of it (it crosses into both containers),
  // so results/state.json is the only place a climb's history survives — and
  // without this the arm tabs would open blank on every restart of a run that
  // is meant to span weeks.
  model.seedFromState(await readClimbState(statePath(base.resultsDir)));

  // Re-read the plan and mark the rung about to be built. The one being built
  // is by definition the first unchecked box, so this needs no extra bookkeeping
  // from the loop. Called again after each phase because Greg appends to the
  // file as he plans and the loop checks boxes as it builds. Only the four
  // fields the view shows cross over — the ticket bodies stay in the file.
  const refreshLadder = async (): Promise<void> => {
    try {
      const ladder = await readLadder(LADDER_PATH);
      model.setPlan(
        parseSubtickets(ladder).map((subticket) => ({
          number: subticket.number,
          milestone: subticket.milestone,
          title: subticket.title,
          done: subticket.done,
        })),
        nextPendingSubticket(ladder)?.number,
      );
    } catch {
      // A ladder we cannot read is not worth failing a climb over; the tab
      // simply keeps whatever it last showed.
    }
  };
  await refreshLadder();
  const sinks = attachLive(model.live, {
    ...options,
    onLine: (line) => model.appendLog(line),
    onLanding: (record) => model.recordLanding(record),
  });
  const onEvent: ArmEventSink = sinks.onEvent;

  // Quitting the view stops every Codex session this loop owns — Greg's
  // planning session as much as the builders'.
  const controller = new AbortController();
  let currentMilestone: number | undefined;
  let stopAfterMilestone: number | undefined;

  // The planner's own Codex session, surfaced as a "greg" tab.
  const plannerRunner: AttemptRunner = (params) =>
    runArmStreaming({ ...params, signal: controller.signal }, (msg) =>
      onEvent(params.arm, msg),
    );

  const deps: Partial<GregDeps> = {
    plan: async (config, ladderPath, ladder, milestoneNumber) => {
      currentMilestone = milestoneNumber;
      model.setPhase(`milestone ${milestoneNumber} · planning`, ["greg"]);
      // Greg's session runs outside the harness, so nothing else would ever
      // give his panel a phase — and "working" for a five-minute planning turn
      // is the same silence this replaces everywhere else.
      model.live.phase("greg", "planning");
      try {
        const threadId = await planNextMilestone(
          config,
          ladderPath,
          ladder,
          milestoneNumber,
          plannerRunner,
        );
        model.live.finish("greg", {});
        // Greg just appended a rung — show it.
        await refreshLadder();
        return threadId;
      } catch (error) {
        model.live.finish("greg", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    harness: async (config) => {
      await refreshLadder();
      const building = model
        .climb()
        .find((subticket) => subticket.state === "building");
      currentMilestone = building?.milestone;
      const description = (building?.title ?? "current rung")
        .replace(/\s+/g, " ")
        .slice(0, 60);
      model.setPhase(
        `building · ${description}`,
        config.arms.map((arm) => arm.name),
      );
      const run = await runHarness(config, sinks, controller.signal);
      // The box is checked now, so the highlight moves to the next rung.
      await refreshLadder();
      return run;
    },
    // The climb's own lines: under the tree on the climb tab, and always into
    // ladder.log beside the per-arm feeds (attachLive echoes them to stdout
    // itself when no view is mounted, and mirrors them into the log tab).
    log: (message) => {
      if (useTui) model.note(message);
      sinks.note(message);
    },
    stopAfterMilestone: () => stopAfterMilestone,
  };

  const app = useTui
    ? mountLive(model, {
        ...options,
        onExit: () => onViewClosed(model, controller, options),
        onStopAfterRung: () => {
          if (stopAfterMilestone !== undefined || currentMilestone === undefined) {
            return;
          }
          stopAfterMilestone = currentMilestone;
          const message = `stop scheduled after milestone ${currentMilestone}`;
          model.note(message);
          sinks.note(message);
        },
      })
    : undefined;

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
