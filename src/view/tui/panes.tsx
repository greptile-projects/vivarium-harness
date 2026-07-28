import React from "react";
import { Box, Text } from "ink";
import { climbLayout, type ClimbRow, type ClimbTone } from "../climb.js";
import type { Line, PullRequestEntry } from "../model.js";
import type { ArmState } from "../store.js";
import {
  SPINNER,
  STATUS_COLOR,
  STATUS_DOT,
  contextColor,
  contextRatio,
  elapsedSeconds,
  formatDuration,
  formatTokens,
  meter,
  oneLine,
  statusLabel,
  truncate,
  wrapLines,
} from "./format.js";
import { feedWindow, viewportRows, type Anchor } from "./scroll.js";

// What the arm is doing *right now*, as a marker + text. Failure and the final
// answer outrank live activity — once an arm has settled, the outcome is the
// only thing worth the row.
function headline(
  state: ArmState,
  frame: number,
): { marker: string; color: string; text: string } {
  if (state.status === "failed" && state.error) {
    return { marker: "✗", color: "red", text: oneLine(state.error) };
  }
  if (state.answer) {
    return { marker: "▸", color: "green", text: oneLine(state.answer) };
  }
  if (state.status === "working") {
    return {
      marker: SPINNER[frame % SPINNER.length]!,
      color: STATUS_COLOR[state.status],
      text: state.activity,
    };
  }
  return { marker: "·", color: "gray", text: state.activity };
}

// One arm on the overview: a name/status line, a dim stats line, and the
// headline. Three short lines with air around them instead of one dense row —
// the full detail is one keystroke away in the arm's own tab.
export function ArmCard({
  state,
  frame,
  width,
  // Rows this card may occupy: 4 for the full card, 3 without the blank line
  // between cards, 2 to also drop the stats line. Below that only the name and
  // status survive.
  rows,
}: {
  state: ArmState;
  frame: number;
  width: number;
  rows: number;
}) {
  const color = STATUS_COLOR[state.status];
  const ratio = contextRatio(state);
  const line = headline(state, frame);

  const stats: string[] = [];
  if (state.model) stats.push(state.model);
  if (state.tokens !== undefined) stats.push(`${formatTokens(state.tokens)} tok`);
  if (ratio !== undefined) stats.push(`${Math.round(ratio * 100)}% context`);

  return (
    <Box flexDirection="column" marginBottom={rows >= 4 ? 1 : 0}>
      <Box>
        {/* Fixed-width marker columns: the status glyphs measure at different
            widths, so a bare space would leave the names ragged. */}
        <Box width={2} flexShrink={0}>
          <Text color={color}>{STATUS_DOT[state.status]}</Text>
        </Box>
        <Text bold>{state.arm}</Text>
        <Box flexGrow={1} />
        <Text color={color}>{statusLabel(state)}</Text>
        <Text dimColor>{"   "}{formatDuration(elapsedSeconds(state))}</Text>
      </Box>
      {rows >= 3 ? (
        <Box paddingLeft={2}>
          <Text dimColor>{stats.join("  ·  ") || "—"}</Text>
        </Box>
      ) : null}
      {rows >= 2 ? (
        <Box paddingLeft={2}>
          <Box width={2} flexShrink={0}>
            <Text color={line.color}>{line.marker}</Text>
          </Box>
          <Text dimColor={line.marker === "·"}>
            {truncate(line.text, Math.max(20, width - 6))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function Overview({
  arms,
  frame,
  width,
  height,
}: {
  arms: ArmState[];
  frame: number;
  width: number;
  height: number;
}) {
  if (arms.length === 0) {
    return (
      <Text dimColor>no session running — see the log tab for what happened</Text>
    );
  }
  // Shed a row per card at a time rather than letting the last arm fall off the
  // bottom: every arm stays visible, in less detail.
  const rows = Math.max(1, Math.min(4, Math.floor(height / arms.length)));
  return (
    <Box flexDirection="column">
      {arms.map((state) => (
        <ArmCard
          key={state.arm}
          state={state}
          frame={frame}
          width={width}
          rows={rows}
        />
      ))}
    </Box>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={10}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

// What an arm has actually landed, one row per pull request. The URL is
// printed whole and the title is what gets cut: these rows exist to be opened,
// and a truncated link is not a link. Merged pull requests are the arm's real
// output — the tab used to show three hours of reasoning and no sign of what
// came out of it.
export function PullRequests({
  prs,
  width,
  rows,
}: {
  prs: PullRequestEntry[];
  width: number;
  rows: number;
}) {
  const visible = prs.slice(-rows);
  // Pad the numbers so the URLs line up in a column — #9 and #12 side by side
  // otherwise leave the links ragged.
  const digits = Math.max(
    ...visible.map((pr) => String(pr.number).length),
  );
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {visible.map((pr) => {
        const merged = pr.status === "merged";
        // Comments here means comments *on the diff*. The full conversation
        // also carries the description, each review's summary body and
        // reactions, which made a two-finding review read as "6 comments".
        const parts: string[] = [];
        if (pr.rounds) parts.push(`${pr.answered}/${pr.rounds} answered`);
        if (pr.diffComments !== undefined) {
          parts.push(
            `${pr.diffComments} diff comment${pr.diffComments === 1 ? "" : "s"}`,
          );
        }
        const detail = parts.join(" · ");
        const head = `${merged ? "✓" : "✗"} #${String(pr.number).padEnd(digits)}  `;
        const room = Math.max(0, width - head.length - pr.url.length - 5);
        return (
          <Box key={pr.url}>
            <Text color={merged ? "green" : "red"}>{head}</Text>
            <Text>{pr.url}</Text>
            {detail && room > 12 ? (
              <Text dimColor>{`   ${truncate(detail, room)}`}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

// Activity rows an arm's tab keeps. See the trail in `ArmDetail`.
export const ACTIVITY_ROWS = 10;

// One arm, in full: the numbers it is burning, what it has been doing lately,
// what it landed, and its answer or error verbatim.
export function ArmDetail({
  state,
  prs = [],
  frame,
  width,
  height,
}: {
  state: ArmState;
  prs?: PullRequestEntry[];
  frame: number;
  width: number;
  height: number;
}) {
  const ratio = contextRatio(state);
  const spinner = state.status === "working" ? SPINNER[frame % SPINNER.length]! : " ";

  // Budget the pane's rows explicitly, tallest-priority first: the four field
  // rows always, then the answer (the outcome is what a human came for), then
  // however much activity trail still fits. A section that cannot fit its
  // label, its blank line and one row of content is dropped outright — Ink
  // resolves overflow by drawing rows over each other, so "it mostly fits" is
  // not a state worth reaching.
  const answerText = state.error ?? state.answer;
  const answerWidth = Math.max(20, width - 2);
  let rowsLeft = Math.max(0, height - 4);

  // Pull requests are budgeted before the answer: they are the durable output
  // of the arm, and there are never many of them.
  const pullRequests =
    prs.length > 0 && rowsLeft >= 3
      ? prs.slice(-Math.min(prs.length, Math.max(1, Math.floor((rowsLeft - 2) / 2)), 6))
      : [];
  if (pullRequests.length) rowsLeft -= 2 + pullRequests.length;

  const answer =
    answerText && rowsLeft >= 3
      ? wrapLines(
          answerText,
          answerWidth,
          Math.min(Math.max(1, Math.ceil((rowsLeft - 2) / 2)), 10),
        )
      : [];
  if (answer.length) rowsLeft -= 2 + answer.length;

  // The trail is a *recent*-activity list, not a transcript: past ten lines it
  // is scrollback nobody reads, and on a tall terminal it used to swallow the
  // whole pane. The full history is in the arm's progress.log.
  const trail =
    rowsLeft >= 3
      ? state.recent.slice(-Math.min(ACTIVITY_ROWS, rowsLeft - 2))
      : ([] as string[]);

  return (
    <Box flexDirection="column">
      <Field label="status">
        <Text color={STATUS_COLOR[state.status]}>{statusLabel(state)}</Text>
        <Text dimColor>
          {"   "}
          {formatDuration(elapsedSeconds(state))}
          {"   "}
          {state.events} events
        </Text>
      </Field>
      <Field label="model">
        <Text>{state.model ?? "—"}</Text>
      </Field>
      <Field label="context">
        {ratio === undefined ? (
          <Text dimColor>—</Text>
        ) : (
          <Box>
            <Text color={contextColor(ratio)}>{meter(ratio, 20)}</Text>
            <Text dimColor>
              {"  "}
              {formatTokens(state.tokens ?? 0)} / {formatTokens(state.contextWindow ?? 0)}
              {"  "}
              {Math.round(ratio * 100)}%
            </Text>
          </Box>
        )}
      </Field>
      <Field label="thread">
        <Text dimColor>{state.threadId ?? "—"}</Text>
      </Field>

      {pullRequests.length > 0 ? (
        <>
          <Box marginTop={1}>
            <Text dimColor>
              pull requests merged
              {prs.length > pullRequests.length
                ? ` (last ${pullRequests.length} of ${prs.length})`
                : ""}
            </Text>
          </Box>
          <PullRequests
            prs={pullRequests}
            width={Math.max(20, width - 2)}
            rows={pullRequests.length}
          />
        </>
      ) : null}

      {trail.length > 0 ? (
        <>
          <Box marginTop={1}>
            <Text dimColor>activity</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {trail.map((entry, index) => {
              const last = index === trail.length - 1;
              return (
                <Box key={`${index}-${entry}`}>
                  <Box width={2} flexShrink={0}>
                    <Text color={STATUS_COLOR[state.status]}>
                      {last ? spinner : " "}
                    </Text>
                  </Box>
                  <Text dimColor={!last}>
                    {truncate(entry, Math.max(20, width - 6))}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </>
      ) : null}

      {answer.length > 0 ? (
        <>
          <Box marginTop={1}>
            <Text dimColor>{state.error ? "error" : "answer"}</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {answer.map((line, index) => (
              <Text key={index} color={state.error ? "red" : undefined}>
                {line}
              </Text>
            ))}
          </Box>
        </>
      ) : null}
    </Box>
  );
}

const CLIMB_COLOR: Record<ClimbTone, string | undefined> = {
  good: "green",
  bad: "red",
  now: "cyan",
  dim: undefined,
  plain: undefined,
};

// The climb, as a tree: every rung already built with what each arm landed on
// it, the rung in flight, and the few queued behind it. It tails like a feed —
// the newest rows are the ones you came for — and scrolls back into the
// history. The climb's own log lines sit underneath, the last few of them,
// beside the rung they are about.
export function ClimbTree({
  rows,
  notes,
  height,
  anchor,
  footer,
}: {
  rows: ClimbRow[];
  notes: Line[];
  height: number;
  anchor: Anchor;
  footer: string;
}) {
  const layout = climbLayout(height, notes.length);
  if (rows.length === 0) {
    return <Text dimColor>no plan yet — Greg has not written a rung</Text>;
  }

  const { visible, behind } = feedWindow(
    rows,
    anchor,
    viewportRows(layout.treeHeight),
  );

  return (
    <Box flexDirection="column">
      {visible.map((row) => (
        <Text
          key={row.id}
          color={CLIMB_COLOR[row.tone]}
          bold={row.kind === "milestone" || row.tone === "now"}
          dimColor={row.tone === "dim" || row.kind === "milestone"}
          wrap="truncate-end"
        >
          {row.text}
        </Text>
      ))}
      <Text
        color={behind > 0 ? "yellow" : undefined}
        dimColor={behind === 0}
        wrap="truncate-end"
      >
        {behind > 0
          ? `↓ ${behind} newer row${behind === 1 ? "" : "s"} · g to follow`
          : footer}
      </Text>
      {layout.notes > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {notes.slice(-layout.notes).map((line) => (
            <Text key={line.id} dimColor wrap="truncate-end">
              {line.text}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

// A tail-following list: notes (Greg's climb) and the raw event feed both use
// it. `anchor` says where the window is parked — `null` follows the live end.
// The pane draws `height - 1` lines and one status row, always: the status row
// is not optional padding, it is what keeps the pane inside the rows it was
// given whether or not it is scrolled back.
export function Feed({
  lines,
  height,
  anchor,
  empty,
  dim = false,
  transform,
}: {
  lines: Line[];
  height: number;
  anchor: Anchor;
  empty: string;
  // The raw event feed is reference material and reads dim.
  dim?: boolean;
  transform?: (text: string) => string;
}) {
  if (lines.length === 0) return <Text dimColor>{empty}</Text>;

  const { visible, behind } = feedWindow(lines, anchor, viewportRows(height));

  return (
    <Box flexDirection="column">
      {visible.map((line) => (
        <Text key={line.id} dimColor={dim} wrap="truncate-end">
          {transform ? transform(line.text) : line.text}
        </Text>
      ))}
      <Text
        color={behind > 0 ? "yellow" : undefined}
        dimColor={behind === 0}
        wrap="truncate-end"
      >
        {behind > 0
          ? `↓ ${behind} newer line${behind === 1 ? "" : "s"} · g to follow`
          : `live · ${lines.length} line${lines.length === 1 ? "" : "s"}`}
      </Text>
    </Box>
  );
}
