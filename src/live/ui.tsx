import React, { useEffect, useReducer } from "react";
import { Box, Text, useApp } from "ink";
import type { ArmState, ArmStatus, LiveStore } from "./store.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PANEL_WIDTH = 48;
const BAR_WIDTH = 22;

const STATUS_COLOR: Record<ArmStatus, string> = {
  starting: "yellow",
  working: "cyan",
  done: "green",
  failed: "red",
};

const STATUS_ICON: Record<ArmStatus, string> = {
  starting: "◌",
  working: "◍",
  done: "✓",
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

// A fixed-width [████░░░░] context-usage meter. Color shifts warm as the
// window fills so a run approaching its context limit reads at a glance.
function TokenBar({
  tokens,
  contextWindow,
}: {
  tokens: number;
  contextWindow: number;
}) {
  const ratio = Math.min(1, Math.max(0, tokens / contextWindow));
  const filled = Math.round(ratio * BAR_WIDTH);
  const color = ratio > 0.85 ? "red" : ratio > 0.6 ? "yellow" : "green";
  const pct = Math.round(ratio * 100);
  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(BAR_WIDTH - filled)}</Text>
      <Text dimColor>
        {" "}
        {pct}%
      </Text>
    </Text>
  );
}

function ArmPanel({ state, frame }: { state: ArmState; frame: number }) {
  const color = STATUS_COLOR[state.status];
  const marker =
    state.status === "working"
      ? SPINNER[frame % SPINNER.length]
      : STATUS_ICON[state.status];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      width={PANEL_WIDTH}
      marginRight={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={color}>
          {STATUS_ICON[state.status]} {state.arm.toUpperCase()}
        </Text>
        <Text color={color}>{state.status}</Text>
      </Box>

      <Text dimColor>
        {(state.model ?? "…").padEnd(16)} {formatDuration(elapsedSeconds(state))}
        {" · "}
        {state.events} events
      </Text>

      {state.tokens !== undefined && state.contextWindow ? (
        <TokenBar tokens={state.tokens} contextWindow={state.contextWindow} />
      ) : state.tokens !== undefined ? (
        <Text dimColor>{state.tokens.toLocaleString()} tok</Text>
      ) : null}

      <Box marginTop={1}>
        <Text>
          <Text color={color}>{marker}</Text> {state.activity}
        </Text>
      </Box>

      {state.answer ? (
        <Text color="green">
          ▸ {state.answer.replace(/\s+/g, " ").slice(0, 80)}
        </Text>
      ) : null}
      {state.error ? <Text color="red">✗ {state.error.slice(0, 80)}</Text> : null}
    </Box>
  );
}

// Overall run line: how many arms have settled and the wall-clock spread.
function Header({ arms, ticket }: { arms: ArmState[]; ticket: string }) {
  const done = arms.filter((a) => a.status === "done").length;
  const failed = arms.filter((a) => a.status === "failed").length;
  const settled = done + failed;
  const total = arms.length;
  const allSettled = total > 0 && settled === total;
  const wall = arms.length
    ? Math.max(...arms.map((a) => elapsedSeconds(a)))
    : 0;

  const summaryColor = allSettled ? (failed ? "red" : "green") : "cyan";
  const summary = allSettled
    ? failed
      ? `settled · ${done} done · ${failed} failed`
      : `settled · ${done} done`
    : `${settled}/${total} settled`;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" width={PANEL_WIDTH * 2 + 1}>
        <Text bold>🪴 terrarium live</Text>
        <Text color={summaryColor}>
          {summary} · {formatDuration(wall)}
        </Text>
      </Box>
      <Text dimColor>{ticket.slice(0, PANEL_WIDTH * 2)}</Text>
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
  const settled =
    arms.length > 0 &&
    arms.every((a) => a.status === "done" || a.status === "failed");

  useEffect(() => {
    if (!settled) return;
    const id = setTimeout(() => exit(), 500);
    return () => clearTimeout(id);
  }, [settled]);

  return (
    <Box flexDirection="column">
      <Header arms={arms} ticket={ticket} />
      <Box marginTop={1}>
        {arms.map((state) => (
          <ArmPanel key={state.arm} state={state} frame={frame} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          <Text color="yellow">◌</Text> starting{"  "}
          <Text color="cyan">◍</Text> working{"  "}
          <Text color="green">✓</Text> done{"  "}
          <Text color="red">✗</Text> failed
        </Text>
      </Box>
    </Box>
  );
}
