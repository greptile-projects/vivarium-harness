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
import {
  armLogPath,
  climbLogPath,
  plannerLogPath,
  readClimbState,
} from "./harness/state.js";

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
  writeAhead: boolean,
  options: { useTui: boolean },
): Promise<GregSubticketSummary[]> {
  const { useTui } = options;
  const model = new LiveModel("greg tile", "starting…");

  // Everything the experiment has landed before this process started. The
  // ladder deliberately carries none of it (it crosses into both arm microVMs),
  // so the rung directories under results/ are the only place a climb's
  // history survives — and without this the arm tabs would open blank on every
  // restart of a run that is meant to span weeks.
  const initialLadder = await readLadder(LADDER_PATH);
  model.seedFromState(
    await readClimbState(
      base.resultsDir,
      new Set(
        parseSubtickets(initialLadder)
          .filter((subticket) => subticket.done)
          .map((subticket) => subticket.number),
      ),
    ),
  );

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

  // Where the per-arm feed is going right now. The climb owns this because it
  // is the only layer that knows which rung is being planned and which
  // subticket is being built; `attachLive` just asks. Undefined until the
  // first phase begins — nothing is written before there is a place for it to
  // belong, which is also what keeps a run that dies during setup from
  // leaving an empty directory behind.
  let armLog: ((arm: string) => string | undefined) | undefined;

  const sinks = attachLive(model.live, {
    ...options,
    logs: {
      arm: (arm) => armLog?.(arm),
      climb: () => climbLogPath(base.resultsDir),
    },
    onLine: (line) => model.appendLog(line),
    onLanding: (record) => model.recordLanding(record),
  });
  const onEvent: ArmEventSink = sinks.onEvent;

  // Quitting the view stops every Codex session this loop owns — Greg's
  // planning session as much as the builders'.
  const controller = new AbortController();
  // What the loop is on right now, named for the stop-request note — "subticket
  // 6.2" while the harness builds it, "planning milestone 7" during Greg's
  // turn. Undefined until the first step starts, when a stop request would have
  // nothing to finish.
  let currentStep: string | undefined;
  let stopRequested = false;

  // The planner's own Codex session, surfaced as a "greg" tab.
  const plannerRunner: AttemptRunner = (params) =>
    runArmStreaming({ ...params, signal: controller.signal }, (msg) =>
      onEvent(params.arm, msg),
    );

  const deps: Partial<GregDeps> = {
    plan: async (config, ladderPath, ladder, milestoneNumber) => {
      currentStep = `planning milestone ${milestoneNumber}`;
      // Greg's turn belongs to the rung he is planning, not to any run under
      // it — the transcript of this same turn lands in that directory too.
      armLog = () => plannerLogPath(base.resultsDir, milestoneNumber);
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
      // The loop has already filed this subticket's artifacts under its ladder
      // coordinates; the feed follows them into the same directory rather than
      // into a parallel tree keyed by when the process happened to start.
      const directory = config.destination?.directory;
      armLog = directory ? (arm) => armLogPath(directory, arm) : undefined;
      await refreshLadder();
      const building = model
        .climb()
        .find((subticket) => subticket.state === "building");
      currentStep = building
        ? `subticket ${building.number}`
        : "the current subticket";
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
    // results/climb.log — one continuous narrative across every invocation,
    // since these lines belong to no rung and no arm (attachLive echoes them
    // to stdout itself when no view is mounted, and mirrors them to the log
    // tab).
    log: (message) => {
      if (useTui) model.note(message);
      sinks.note(message);
    },
    stopRequested: () => stopRequested,
  };

  const app = useTui
    ? mountLive(model, {
        resultsDir: base.resultsDir,
        onExit: () =>
          onViewClosed(model, controller, {
            // Ask the same live target that writes the feed, so the quit
            // notice cannot drift from planning to a stale subticket path.
            // Harness feeds retain the arm placeholder; Greg's target ignores
            // it and returns the exact rung plan/progress.log path.
            feedPath: armLog?.("<arm>"),
          }),
        onStopAfterSubticket: () => {
          if (stopRequested || currentStep === undefined) {
            return false;
          }
          stopRequested = true;
          const message = `stop scheduled after ${currentStep}`;
          model.note(message);
          sinks.note(message);
          return true;
        },
      })
    : undefined;

  let halted = true;
  try {
    const subtickets = writeAhead
      ? await planAhead(base, Infinity, deps)
      : await runGreg(base, Infinity, deps);
    halted = false;
    return subtickets;
  } finally {
    // Hand the terminal back before the entrypoint prints its summary (or the
    // error) — anything written while the alternate screen is up is lost.
    if (app) {
      model.finish(
        halted ? "halted" : writeAhead ? "planned ahead" : "stopped",
      );
      await app.waitUntilExit();
    }
    await sinks.flush();
  }
}
