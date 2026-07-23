import React, { useEffect, useReducer } from "react";
import { Box, Text, useApp } from "ink";
import type { ArmState, ArmStatus, LiveStore } from "./store.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_COLOR: Record<ArmStatus, string> = {
  starting: "yellow",
  working: "cyan",
  done: "green",
  failed: "red",
};

// Leading status dot for each arm — the one place color earns its keep.
const STATUS_DOT: Record<ArmStatus, string> = {
  starting: "○",
  working: "●",
  done: "✔",
  failed: "✗",
};

function elapsedSeconds(state: ArmState): number {
  return ((state.endedAt ?? Date.now()) - state.startedAt) / 1000;
}

// Compact m:ss (or h:mm:ss past an hour) so long runs stay readable.
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 41230 -> "41.2k", 248900 -> "249k", 1_500_000 -> "1.5M".
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function contextColor(ratio: number): string {
  return ratio > 0.85 ? "red" : ratio > 0.6 ? "yellow" : "green";
}

// One arm as two calm lines: a primary status line and an indented detail
// line. No borders — alignment and dimmed metadata carry the structure.
function Arm({ state, frame }: { state: ArmState; frame: number }) {
  const color = STATUS_COLOR[state.status];

  const meta: string[] = [];
  if (state.model) meta.push(state.model);
  if (state.tokens !== undefined) meta.push(`${formatTokens(state.tokens)} tok`);

  const ratio =
    state.tokens !== undefined && state.contextWindow
      ? Math.min(1, state.tokens / state.contextWindow)
      : undefined;

  const detail =
    state.status === "failed" && state.error
      ? { marker: "✗", color: "red", text: state.error.slice(0, 88) }
      : state.answer
        ? {
            marker: "▸",
            color: "green",
            text: state.answer.replace(/\s+/g, " ").slice(0, 88),
          }
        : state.status === "working"
          ? {
              marker: SPINNER[frame % SPINNER.length],
              color,
              text: state.activity,
            }
          : { marker: " ", color: "gray", text: state.activity };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box width={2}>
          <Text color={color}>{STATUS_DOT[state.status]}</Text>
        </Box>
        <Box width={10}>
          <Text bold>{state.arm}</Text>
        </Box>
        <Box width={9}>
          <Text color={color}>{state.status}</Text>
        </Box>
        <Box width={7}>
          <Text dimColor>{formatDuration(elapsedSeconds(state))}</Text>
        </Box>
        <Text dimColor>{meta.join(" · ")}</Text>
        {ratio !== undefined ? (
          <Text color={contextColor(ratio)}> · {Math.round(ratio * 100)}%</Text>
        ) : null}
      </Box>
      <Box>
        <Box width={2} marginLeft={2}>
          <Text color={detail.color}>{detail.marker}</Text>
        </Box>
        <Text dimColor={detail.marker === " "}>{detail.text}</Text>
      </Box>
    </Box>
  );
}

export function App({ store, ticket }: { store: LiveStore; ticket: string }) {
  const [frame, tick] = useReducer((n: number) => n + 1, 0);
  const { exit } = useApp();

  useEffect(() => store.subscribe(tick), [store]);

  useEffect(() => {
    const id = setInterval(tick, 120);
    return () => clearInterval(id);
  }, []);

  const arms = store.snapshot();
  const done = arms.filter((a) => a.status === "done").length;
  const failed = arms.filter((a) => a.status === "failed").length;
  const settled = arms.length > 0 && done + failed === arms.length;
  const wall = arms.length ? Math.max(...arms.map(elapsedSeconds)) : 0;

  useEffect(() => {
    if (!settled) return;
    const id = setTimeout(() => exit(), 500);
    return () => clearTimeout(id);
  }, [settled]);

  const summaryColor = settled ? (failed ? "red" : "green") : "cyan";
  const summary = failed
    ? `${done} done · ${failed} failed`
    : `${done}/${arms.length} done`;

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Box>
        <Text bold>terrarium live</Text>
        <Text dimColor>
          {"  ·  "}
          {ticket.replace(/\s+/g, " ").slice(0, 72)}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={summaryColor}>
          {summary} · {formatDuration(wall)}
        </Text>
      </Box>
      {arms.map((state) => (
        <Arm key={state.arm} state={state} frame={frame} />
      ))}
    </Box>
  );
}
