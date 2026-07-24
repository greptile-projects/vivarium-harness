#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { styledCharsFromTokens, tokenize } from "@alcalzone/ansi-tokenize";
import React from "react";
import { render } from "ink";
import { LiveModel } from "../src/live/model.js";
import { LiveApp } from "../src/live/tui/app.js";

const columns = 118;
const rows = 31;
const chunks: string[] = [];

const stdout = new Writable({
  write(chunk, _encoding, callback) {
    chunks.push(String(chunk));
    callback();
  },
}) as NodeJS.WriteStream;
stdout.columns = columns;
stdout.rows = rows;
stdout.isTTY = false;

const stdin = new PassThrough() as NodeJS.ReadStream;
stdin.isTTY = false;

const model = new LiveModel(
  "vivarium",
  "building rung 4.2 · deterministic replay for failed runs",
  "ladder",
);
// Register in the opposite order to prove that the presentation layer always
// puts Tuatara first.
model.setPhase(model.subtitle, ["control", "greptile"]);
model.note("rung 4 · make every run reproducible");
model.note("4.2 · deterministic replay for failed runs");

const event = (arm: string, message: Record<string, unknown>) =>
  model.live.applyEvent(arm, message as never);

event("greptile", {
  type: "session_configured",
  model: "gpt-5.4",
  thread_id: "019c-vivarium-tuatara",
});
event("greptile", { type: "task_started", model_context_window: 258_400 });
event("greptile", { type: "mcp_startup_complete" });
event("greptile", {
  type: "item_started",
  item: { type: "CommandExecution", command: "bun test test/replay.test.ts" },
});
event("greptile", {
  type: "token_count",
  info: { total_token_usage: { total_tokens: 68_240 } },
});
event("greptile", {
  type: "item_started",
  item: { type: "FileChange" },
});

event("control", {
  type: "session_configured",
  model: "gpt-5.4",
  thread_id: "019c-vivarium-komodo",
});
event("control", { type: "task_started", model_context_window: 258_400 });
event("control", { type: "mcp_startup_complete" });
event("control", {
  type: "item_started",
  item: { type: "Reasoning" },
});
event("control", {
  type: "token_count",
  info: { total_token_usage: { total_tokens: 51_890 } },
});

for (const state of model.live.snapshot()) {
  state.startedAt -= state.arm === "greptile" ? 64_000 : 61_000;
}

const app = render(<LiveApp model={model} logPath="results/live-…/progress.log" />, {
  stdout,
  stdin,
  debug: true,
  patchConsole: false,
  exitOnCtrlC: false,
});

await Bun.sleep(40);
const frame = chunks.at(-1);
app.unmount();
app.cleanup();

if (!frame) throw new Error("Ink produced no frame");

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const colors: Record<number, string> = {
  30: "#6e7681",
  31: "#ff7b72",
  32: "#3fb950",
  33: "#d29922",
  34: "#58a6ff",
  35: "#bc8cff",
  36: "#56d4dd",
  37: "#f0f6fc",
  90: "#8b949e",
  91: "#ffa198",
  92: "#56d364",
  93: "#e3b341",
  94: "#79c0ff",
  95: "#d2a8ff",
  96: "#76e3ea",
  97: "#ffffff",
};

function cssFor(styles: { code: string }[]): string {
  const codes = styles.flatMap((style) => {
    const match = style.code.match(/\[([\d;]+)m/);
    return match ? match[1]!.split(";").map(Number) : [];
  });
  const declarations = [`fill:${colors[codes.findLast((code) => colors[code]) ?? -1] ?? "#c9d1d9"}`];
  if (codes.includes(1)) declarations.push("font-weight:700");
  if (codes.includes(2)) declarations.push("opacity:.58");
  if (codes.includes(4)) declarations.push("text-decoration:underline");
  return declarations.join(";");
}

function lineToSvg(line: string, y: number): string {
  const chars = styledCharsFromTokens(tokenize(line));
  const runs: { text: string; css: string }[] = [];
  for (const char of chars) {
    const css = cssFor(char.styles);
    const previous = runs.at(-1);
    if (previous?.css === css) previous.text += char.value;
    else runs.push({ text: char.value, css });
  }
  return `<text x="48" y="${y}" xml:space="preserve">${runs
    .map((run) => `<tspan style="${run.css}">${escapeXml(run.text)}</tspan>`)
    .join("")}</text>`;
}

const terminalLines = frame.split("\n").slice(0, rows);
const width = 1140;
const height = 690;
const text = terminalLines
  .map((line, index) => lineToSvg(line, 79 + index * 19))
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity=".5"/>
    </filter>
  </defs>
  <rect width="1140" height="690" fill="#05070b"/>
  <rect x="22" y="22" width="1096" height="646" rx="16" fill="#0d1117" stroke="#30363d" filter="url(#shadow)"/>
  <path d="M22 64h1096" stroke="#30363d"/>
  <circle cx="48" cy="43" r="6" fill="#ff5f56"/>
  <circle cx="69" cy="43" r="6" fill="#ffbd2e"/>
  <circle cx="90" cy="43" r="6" fill="#27c93f"/>
  <text x="570" y="48" text-anchor="middle" fill="#6e7681" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="13">vivarium — live experiment</text>
  <g font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="14">${text}</g>
</svg>
`;

await mkdir("docs/assets", { recursive: true });
await writeFile("docs/assets/vivarium-live.svg", svg);
process.stdout.write("wrote docs/assets/vivarium-live.svg\n");
