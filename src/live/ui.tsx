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

function elapsedSeconds(state: ArmState): number {
  return ((state.endedAt ?? Date.now()) - state.startedAt) / 1000;
}

function ArmPanel({ state, frame }: { state: ArmState; frame: number }) {
  const color = STATUS_COLOR[state.status];
  const marker =
    state.status === "working" ? SPINNER[frame % SPINNER.length] : "•";
  const tokens =
    state.tokens === undefined
      ? ""
      : ` · ${state.tokens.toLocaleString()}${
          state.contextWindow
            ? `/${state.contextWindow.toLocaleString()}`
            : ""
        } tok`;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      width={48}
      marginRight={1}
    >
      <Text bold color={color}>
        {state.arm.toUpperCase()} · {state.status}
      </Text>
      <Text dimColor>
        {(state.model ?? "…").padEnd(14)} {elapsedSeconds(state).toFixed(0)}s ·{" "}
        {state.events} events{tokens}
      </Text>
      <Text>
        {marker} {state.activity}
      </Text>
      {state.answer ? (
        <Text color="green">▸ {state.answer.replace(/\s+/g, " ").slice(0, 80)}</Text>
      ) : null}
      {state.error ? <Text color="red">✗ {state.error.slice(0, 80)}</Text> : null}
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
      <Text bold>🪴 terrarium live</Text>
      <Text dimColor>{ticket.slice(0, 96)}</Text>
      <Box marginTop={1}>
        {arms.map((state) => (
          <ArmPanel key={state.arm} state={state} frame={frame} />
        ))}
      </Box>
    </Box>
  );
}
