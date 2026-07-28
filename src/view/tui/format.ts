import type { ArmState, ArmStatus } from "../store.js";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const STATUS_COLOR: Record<ArmStatus, string> = {
  starting: "yellow",
  working: "cyan",
  done: "green",
  failed: "red",
};

// The leading glyph for an arm — the one place color earns its keep.
export const STATUS_DOT: Record<ArmStatus, string> = {
  starting: "○",
  working: "●",
  done: "✔",
  failed: "✗",
};

// The status word for an arm. While it is live this is the phase the harness
// last announced — an arm sitting on a review it has not received yet is very
// much "working", and saying so for forty minutes answered nothing. Once it
// settles the outcome is the only word worth the column.
export function statusLabel(state: ArmState): string {
  if (state.status === "done" || state.status === "failed") return state.status;
  return state.phase ?? state.status;
}

export function elapsedSeconds(state: ArmState, now = Date.now()): number {
  const end = state.endedAt ?? now;
  const currentPeerWait =
    state.peerWaitStartedAt === undefined ? 0 : end - state.peerWaitStartedAt;
  return (end - state.startedAt - state.peerWaitMs - currentPeerWait) / 1000;
}

// Compact m:ss (or h:mm:ss past an hour) so long runs stay readable.
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 41230 -> "41.2k", 248900 -> "249k", 1_500_000 -> "1.5M".
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function contextRatio(state: ArmState): number | undefined {
  return state.tokens !== undefined && state.contextWindow
    ? Math.min(1, state.tokens / state.contextWindow)
    : undefined;
}

export function contextColor(ratio: number): string {
  return ratio > 0.85 ? "red" : ratio > 0.6 ? "yellow" : "green";
}

// A plain block meter. Kept ASCII-adjacent so it survives fonts that render
// partial blocks at odd widths.
export function meter(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// Collapse whitespace so a multi-line payload stays on one row.
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// `progress.log` lines lead with an absolute ISO timestamp *and* an elapsed
// offset. On disk the wall-clock stamp is what makes a line correlatable with a
// transcript; on screen it is 26 dead columns, and the offset already answers
// "when". Strip it for the log tab only — the file keeps both.
export function stripLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "");
}

export function truncate(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

// Wrap to an exact number of lines. Doing it here rather than leaning on Ink's
// own wrapping is what lets a pane know its real height before it renders — a
// block that turns out one line taller than budgeted does not scroll, it draws
// over its neighbour.
export function wrapLines(text: string, width: number, maxLines: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let current = "";

  const flush = () => {
    if (current) lines.push(current);
    current = "";
  };

  for (const word of oneLine(text).split(" ")) {
    if (!word) continue;
    if (!current) current = word;
    else if (current.length + 1 + word.length <= w) current += ` ${word}`;
    else flush(), (current = word);
    // A single word longer than the pane is chopped rather than allowed to
    // overflow the box.
    while (current.length > w) {
      lines.push(current.slice(0, w));
      current = current.slice(w);
    }
    if (lines.length > maxLines) break;
  }
  flush();

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? "";
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, w - 1))}…`;
  return kept;
}
