import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdin, useStdout } from "ink";
import { armsForDisplay } from "../../harness/arms.js";
import type { LiveModel } from "../model.js";
import {
  confirmQuitPrompt,
  needsQuitConfirm,
  popupKey,
  quitNowPopup,
  stopAfterTaskPopup,
  updateRestartPopup,
  type Popup,
} from "../quit.js";
import { stripLogTimestamp, truncate } from "./format.js";
import {
  enterFullscreen,
  restoreOnExit,
  useTerminalSize,
} from "./fullscreen.js";
import { climbFooter, climbLayout, climbRows } from "../climb.js";
import { ArmDetail, ClimbTree, Feed, Overview } from "./panes.js";
import {
  scrollAnchor,
  viewportRows,
  type Anchor,
  type Row,
} from "./scroll.js";
import {
  armTabId,
  resolveSelected,
  stepTab,
  tabForDigit,
  tabsFor,
  type Tab,
} from "./tabs.js";
import type { HarnessUpdateResult } from "../../update.js";

// Rows the chrome costs, counted against the terminal's height: the top pad,
// the title and subtitle with its trailing blank, the tab strip, the rule with
// its trailing blank, the footer, and the row we leave unused at the bottom so
// the final frame never scrolls the alternate screen. The body gets the rest —
// and must not exceed it, because Ink squeezes overflow by stacking rows on top
// of each other rather than scrolling.
const CHROME_ROWS = 9;

function Rule({ width }: { width: number }) {
  return <Text dimColor>{"─".repeat(Math.max(0, width))}</Text>;
}

function TabStrip({
  tabs,
  selected,
  width,
}: {
  tabs: Tab[];
  selected: string;
  width: number;
}) {
  // One nested Text rather than a Box of Boxes: the strip must stay exactly one
  // row, and a Box row wraps to a second line on a narrow terminal — which then
  // pushes the body past the height the panes were sized for.
  return (
    <Box width={width}>
      <Text wrap="truncate-end">
        {tabs.map((tab, index) => {
          const active = tab.id === selected;
          return (
            <Text key={tab.id}>
              {index > 0 ? "   " : ""}
              <Text dimColor>{index + 1} </Text>
              <Text
                bold={active}
                underline={active}
                color={active ? "cyan" : undefined}
                dimColor={!active}
              >
                {tab.label}
              </Text>
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}

// The whole live view. Everything it shows comes from the
// model; it never reaches into the harness, so watching a run stays a display
// choice and never a second execution path.
export function LiveApp({
  model,
  resultsDir,
  onStopAfterSubticket,
  onUpdateAndRestart,
  currentTask,
  // Which tab opens first. Only set by tests/previews, which have no TTY to
  // press a key on.
  initialTab = "overview",
}: {
  model: LiveModel;
  resultsDir?: string;
  onStopAfterSubticket?: () => boolean;
  onUpdateAndRestart?: () => Promise<HarnessUpdateResult>;
  // What the loop is on right now — "subticket 45.6", "planning milestone 46".
  // Read at keypress time rather than held in state: the view asks the same
  // question minutes apart and the step underneath it moves on.
  currentTask?: () => string | undefined;
  initialTab?: string;
}) {
  const [frame, tick] = useReducer((n: number) => n + 1, 0);
  const [selectedId, setSelectedId] = useState(initialTab);
  const [anchor, setAnchor] = useState<Anchor>(null);
  // `q` was pressed with sessions still working: the view is holding on the
  // question instead of unmounting. Quitting stops the run, so the second key
  // is the whole safety.
  const [confirming, setConfirming] = useState(false);
  const [scheduledAction, setScheduledAction] = useState<
    "stop" | "restart" | undefined
  >();
  // The box over the panes: the second question every consequential answer to
  // the quit prompt now asks, and afterwards the pull's own progress.
  const [popup, setPopup] = useState<Popup | undefined>();
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const { columns, rows } = useTerminalSize(stdout);

  useEffect(() => model.subscribe(tick), [model]);

  useEffect(() => {
    const id = setInterval(tick, 120);
    return () => clearInterval(id);
  }, []);

  // Give the last frame a moment to paint, then hand the terminal back.
  useEffect(() => {
    if (!model.finished) return;
    const id = setTimeout(() => exit(), 400);
    return () => clearTimeout(id);
  }, [model.finished]);

  // The pull, once its confirmation has been answered: the box stays up and
  // becomes the progress notice, so the human who asked for it sees what came
  // back rather than the panes returning as if nothing happened.
  const startUpdate = () => {
    if (!onUpdateAndRestart) return;
    setPopup({
      kind: "notice",
      state: "pulling",
      message: "pulling harness update…",
    });
    void onUpdateAndRestart()
      .then((result) => {
        setPopup({
          kind: "notice",
          state: result.ok ? "done" : "failed",
          message: result.message,
        });
        setScheduledAction(result.ok ? "restart" : "stop");
      })
      .catch((error) => {
        setPopup({
          kind: "notice",
          state: "failed",
          message: `harness pull failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  };

  const tabs = tabsFor(model);
  const selected = resolveSelected(tabs, selectedId);

  const inner = Math.max(20, columns - 4);
  const body = Math.max(3, rows - CHROME_ROWS);

  // The rows the selected pane scrolls, or null on a pane that does not
  // scroll. Read here rather than at render time so the key handler can bound
  // a scroll against the buffer it is actually moving through — and, on the
  // climb tab, against the rows the tree actually got after the notes tail took
  // its share.
  const logLines = selected === "log" ? model.log() : null;
  const climb = selected === "climb" ? model.climb() : null;
  const climbTree = climb ? climbRows(climb) : null;
  // Both scroll by the same rules, so the key handler only needs their ids.
  const scrollRows: Row[] | null = logLines ?? climbTree;
  const scrollable = scrollRows !== null;
  const scrollHeight =
    selected === "climb"
      ? climbLayout(body, model.notes().length).treeHeight
      : body;

  useInput(
    (input, key) => {
      if (popup) {
        const answer = popupKey(popup, input);
        if (answer === "ignore") return;
        setPopup(undefined);
        if (answer !== "accept" || popup.kind !== "confirm") return;
        if (popup.action === "quit-now") exit();
        else if (popup.action === "stop-after-task") {
          if (onStopAfterSubticket?.()) setScheduledAction("stop");
        } else startUpdate();
        return;
      }
      // The question owns every key while it is up: navigating away from it
      // would leave a run half-quit, and a stray keystroke must not be the
      // thing that answers it. `y` stops every session now, `S` is the
      // climb-only graceful path (finish the subticket in flight, let the loop
      // return at its next step boundary), and `R` pulls a harness hotfix and
      // restarts at that same boundary. None of the three acts on this
      // keystroke: each opens the box that names what it would do and waits for
      // one more `y`. Only `n` — and every other key — is free, because putting
      // the question away costs nothing.
      if (confirming) {
        if (input === "y" || input === "Y") {
          setConfirming(false);
          setPopup(quitNowPopup(model.live.snapshot()));
        } else if ((input === "s" || input === "S") && onStopAfterSubticket) {
          setConfirming(false);
          setPopup(stopAfterTaskPopup(currentTask?.()));
        } else if ((input === "r" || input === "R") && onUpdateAndRestart) {
          setConfirming(false);
          setPopup(updateRestartPopup(currentTask?.()));
        } else setConfirming(false);
        return;
      }
      if (key.tab) {
        setSelectedId(stepTab(tabs, selected, key.shift ? -1 : 1));
        setAnchor(null);
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        setSelectedId(stepTab(tabs, selected, key.rightArrow ? 1 : -1));
        setAnchor(null);
        return;
      }
      const digit = tabForDigit(tabs, input);
      if (digit) {
        setSelectedId(digit);
        setAnchor(null);
        return;
      }
      // Scrolling only means anything on the two list panes; elsewhere the
      // arrows would silently do nothing, so they stay tab navigation.
      if (scrollRows) {
        const view = viewportRows(scrollHeight);
        const scroll = (delta: number) =>
          setAnchor((current) => scrollAnchor(scrollRows, current, view, delta));
        if (key.upArrow) scroll(1);
        else if (key.downArrow) scroll(-1);
        else if (key.pageUp) scroll(view);
        else if (key.pageDown) scroll(-view);
        else if (input === "g") setAnchor(null);
      }
      if (input === "q") {
        // Nothing left running: the view is a report, and closing a report
        // needs no confirming.
        if (needsQuitConfirm(model.live.snapshot())) setConfirming(true);
        else exit();
      }
    },
    { isActive: Boolean(isRawModeSupported) },
  );

  const arms = armsForDisplay(model.live.snapshot());
  const done = arms.filter((a) => a.status === "done").length;
  const failed = arms.filter((a) => a.status === "failed").length;
  const settled = arms.length > 0 && done + failed === arms.length;

  const summary = arms.length
    ? failed
      ? `${done} done · ${failed} failed`
      : `${done}/${arms.length} done`
    : model.finished
      ? "finished"
      : "starting";
  const summaryColor = model.finished
    ? failed
      ? "red"
      : "green"
    : settled
      ? "green"
      : "cyan";

  let pane: React.ReactNode;
  if (selected === "log") {
    pane = (
      <Feed
        lines={logLines ?? []}
        height={body}
        anchor={anchor}
        empty="no events yet"
        dim
        transform={stripLogTimestamp}
      />
    );
  } else if (selected === "climb") {
    // Where the experiment is: the rungs built and what each arm landed on
    // them, the rung in flight, and the few queued behind it.
    pane = (
      <ClimbTree
        rows={climbTree ?? []}
        notes={model.notes()}
        height={body}
        anchor={anchor}
        footer={climbFooter(climb ?? [])}
      />
    );
  } else if (selected.startsWith("arm:")) {
    const state = arms.find((a) => armTabId(a.arm) === selected);
    pane = state ? (
      <ArmDetail
        state={state}
        prs={model.pullRequests(state.arm)}
        frame={frame}
        width={inner}
        height={body}
      />
    ) : null;
  } else {
    pane = <Overview arms={arms} frame={frame} width={inner} height={body} />;
  }

  return (
    <Box flexDirection="column" width={columns} height={rows - 1} paddingX={2} paddingTop={1}>
      <Box>
        <Text bold>{model.title}</Text>
        <Box flexGrow={1} />
        <Text color={summaryColor}>{summary}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{truncate(model.subtitle, inner)}</Text>
      </Box>

      <TabStrip tabs={tabs} selected={selected} width={inner} />
      <Box marginBottom={1}>
        <Rule width={inner} />
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {popup ? (
          <Box
            borderStyle="round"
            borderColor={
              popup.kind === "confirm"
                ? "yellow"
                : popup.state === "failed"
                  ? "red"
                  : popup.state === "done"
                    ? "green"
                    : "yellow"
            }
            paddingX={2}
            alignSelf="center"
            marginTop={Math.max(0, Math.floor(body / 3))}
          >
            <Text bold wrap="truncate-end">
              {popup.message}
            </Text>
          </Box>
        ) : (
          pane
        )}
      </Box>

      {/* One row, always. The path is the first thing to go when the terminal
          is too narrow for both — the keys are what the human needs here. The
          pending quit takes the whole row, undimmed: it is a question, and the
          run is still going until it is answered. */}
      <Box>
        {confirming ? (
          <Text color="yellow" bold wrap="truncate-end">
            {confirmQuitPrompt(
              arms,
              onStopAfterSubticket !== undefined,
              onUpdateAndRestart !== undefined,
            )}
          </Text>
        ) : (
          <>
            <Text dimColor wrap="truncate-end">
              {scheduledAction === "restart"
                ? "updated · restart scheduled after current task · q quit now"
                : scheduledAction === "stop"
                  ? "stop scheduled after current task · q quit now"
                : `↹ tab · 1-${tabs.length} jump${scrollable ? " · ↑↓ scroll · g live" : ""} · q quit`}
            </Text>
            <Box flexGrow={1} />
            {resultsDir && columns >= 100 ? (
              <Text dimColor wrap="truncate-start">
                {resultsDir}
              </Text>
            ) : null}
          </>
        )}
      </Box>
    </Box>
  );
}

// Mount the fullscreen view and return a handle that restores the terminal.
// Callers await `waitUntilExit()` before printing anything to the normal
// buffer, so the summary always lands after the alternate screen is gone.
//
// The restore is wired to Ink's exit *here, at mount* — not inside
// `waitUntilExit`. Callers only await that handle once the run is over, but the
// view can exit long before then: `q` or Ctrl-C five minutes into a three-hour
// climb unmounts the UI immediately. Restoring on the caller's await would
// strand the terminal on the alternate screen with a hidden cursor for the rest
// of the run — the view gone, the shell unusable, nothing to type into. The
// terminal has to come back the moment the view does.
export function mountLive(
  model: LiveModel,
  // `onExit` runs once the terminal is back, so anything it prints lands on the
  // normal buffer instead of the alternate screen that is being torn down. It
  // fires on *every* exit, including the ordinary end-of-run unmount — telling
  // "the human quit early" from "the run ended" is the caller's job, and it
  // reads that off the model rather than off the keypress.
  options: {
    resultsDir?: string;
    onExit?: () => void;
    onStopAfterSubticket?: () => boolean;
    onUpdateAndRestart?: () => Promise<HarnessUpdateResult>;
    currentTask?: () => string | undefined;
  },
): { waitUntilExit: () => Promise<void> } {
  const restore = enterFullscreen(process.stdout);
  const app = render(
    <LiveApp
      model={model}
      resultsDir={options.resultsDir}
      onStopAfterSubticket={options.onStopAfterSubticket}
      onUpdateAndRestart={options.onUpdateAndRestart}
      currentTask={options.currentTask}
    />,
    { exitOnCtrlC: true },
  );
  return {
    waitUntilExit: restoreOnExit(app.waitUntilExit(), () => {
      restore();
      options.onExit?.();
    }),
  };
}
