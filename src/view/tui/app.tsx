import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdin, useStdout } from "ink";
import { armsForDisplay } from "../../harness/arms.js";
import type { LiveModel } from "../model.js";
import { confirmQuitPrompt, needsQuitConfirm } from "../quit.js";
import {
  elapsedSeconds,
  formatDuration,
  stripLogTimestamp,
  truncate,
} from "./format.js";
import {
  enterFullscreen,
  restoreOnExit,
  useTerminalSize,
} from "./fullscreen.js";
import { ArmDetail, Feed, Overview } from "./panes.js";
import { scrollAnchor, viewportRows, type Anchor } from "./scroll.js";
import {
  armTabId,
  resolveSelected,
  stepTab,
  tabForDigit,
  tabsFor,
  type Tab,
} from "./tabs.js";

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

// The whole live view, for both run modes. Everything it shows comes from the
// model; it never reaches into the harness, so watching a run stays a display
// choice and never a second execution path.
export function LiveApp({
  model,
  logDir,
  // Which tab opens first. Only set by tests/previews, which have no TTY to
  // press a key on.
  initialTab = "overview",
}: {
  model: LiveModel;
  logDir?: string;
  initialTab?: string;
}) {
  const [frame, tick] = useReducer((n: number) => n + 1, 0);
  const [selectedId, setSelectedId] = useState(initialTab);
  const [anchor, setAnchor] = useState<Anchor>(null);
  // `q` was pressed with sessions still working: the view is holding on the
  // question instead of unmounting. Quitting stops the run, so the second key
  // is the whole safety.
  const [confirming, setConfirming] = useState(false);
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

  const tabs = tabsFor(model);
  const selected = resolveSelected(tabs, selectedId);

  const inner = Math.max(20, columns - 4);
  const body = Math.max(3, rows - CHROME_ROWS);

  // The lines the selected pane scrolls, or null on a pane that does not
  // scroll. Read here rather than at render time so the key handler can bound
  // a scroll against the buffer it is actually moving through.
  const feedLines =
    selected === "log"
      ? model.log()
      : selected === "notes"
        ? model.notes()
        : selected === "ladder"
          ? model.ladder()
          : null;
  const scrollable = feedLines !== null;

  useInput(
    (input, key) => {
      // The question owns every key while it is up: navigating away from it
      // would leave a run half-quit, and a stray keystroke must not be the
      // thing that answers it. Only `y` proceeds; anything else is "no".
      if (confirming) {
        if (input === "y" || input === "Y") exit();
        else setConfirming(false);
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
      if (feedLines) {
        const view = viewportRows(body);
        const scroll = (delta: number) =>
          setAnchor((current) => scrollAnchor(feedLines, current, view, delta));
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
  const wall = arms.length ? Math.max(...arms.map(elapsedSeconds)) : 0;
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
        lines={feedLines ?? []}
        height={body}
        anchor={anchor}
        empty="no events yet"
        dim
        transform={stripLogTimestamp}
      />
    );
  } else if (selected === "notes") {
    pane = (
      <Feed
        lines={feedLines ?? []}
        height={body}
        anchor={anchor}
        empty="nothing logged yet"
      />
    );
  } else if (selected === "ladder") {
    // The plan as written, with the rung being built now called out — the whole
    // reason to open this tab mid-climb is "where are we".
    const current = model.currentSubticket;
    pane = (
      <Feed
        lines={feedLines ?? []}
        height={body}
        anchor={anchor}
        empty="no ladder yet"
        highlight={
          current
            ? (text) => new RegExp(`^###\\s+\\[.\\]\\s+${current}\\s`).test(text)
            : undefined
        }
        footer={
          current ? `LADDER.md · building ${current}` : "LADDER.md"
        }
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
        <Text dimColor>{"   "}{formatDuration(wall)}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{truncate(model.subtitle, inner)}</Text>
      </Box>

      <TabStrip tabs={tabs} selected={selected} width={inner} />
      <Box marginBottom={1}>
        <Rule width={inner} />
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {pane}
      </Box>

      {/* One row, always. The path is the first thing to go when the terminal
          is too narrow for both — the keys are what the human needs here. The
          pending quit takes the whole row, undimmed: it is a question, and the
          run is still going until it is answered. */}
      <Box>
        {confirming ? (
          <Text color="yellow" bold wrap="truncate-end">
            {confirmQuitPrompt(arms)}
          </Text>
        ) : (
          <>
            <Text dimColor wrap="truncate-end">
              {`↹ tab · 1-${tabs.length} jump${scrollable ? " · ↑↓ scroll · g live" : ""} · q quit`}
            </Text>
            <Box flexGrow={1} />
            {logDir && columns >= 100 ? (
              <Text dimColor wrap="truncate-start">
                {logDir}
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
  options: { logDir?: string; onExit?: () => void },
): { waitUntilExit: () => Promise<void> } {
  const restore = enterFullscreen(process.stdout);
  const app = render(<LiveApp model={model} logDir={options.logDir} />, {
    exitOnCtrlC: true,
  });
  return {
    waitUntilExit: restoreOnExit(app.waitUntilExit(), () => {
      restore();
      options.onExit?.();
    }),
  };
}
