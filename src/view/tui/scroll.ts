import type { Line } from "../model.js";

// Where a feed pane is parked. `null` follows the live end; otherwise it is the
// **id** of the bottom-most visible line, never a distance from the end — lines
// keep arriving while a human reads, and a distance would let the text they are
// looking at slide out from under them.
export type Anchor = number | null;

// Content rows a feed may draw in `height` rows of pane. One row is always
// reserved for the status line at the bottom, whether or not it has anything
// interesting to say: Ink resolves overflow by stacking rows on top of each
// other rather than scrolling, so a pane that sometimes needs an extra row has
// to budget for it always.
export function viewportRows(height: number): number {
  return Math.max(1, height - 1);
}

// Keep the window inside the buffer: never past the newest line, never scrolled
// so far back that the top of the buffer leaves blank rows below it.
function clampEnd(end: number, total: number, viewport: number): number {
  return Math.max(Math.min(viewport, total), Math.min(total, end));
}

// Resolve an anchor to the index *after* the bottom-most visible line. An
// anchor whose line has aged out of the ring buffer pins to the oldest lines
// still held — the closest surviving spot to what the reader was looking at.
function endFor(lines: Line[], anchor: Anchor, viewport: number): number {
  if (anchor === null) return lines.length;
  const index = lines.findIndex((line) => line.id === anchor);
  return clampEnd(index < 0 ? 0 : index + 1, lines.length, viewport);
}

// Scroll `delta` lines back (positive) or forward (negative), returning the new
// anchor. Returns `null` — follow live again — whenever the window lands back
// at the newest line, so scrolling down to the bottom resumes tailing.
export function scrollAnchor(
  lines: Line[],
  anchor: Anchor,
  viewport: number,
  delta: number,
): Anchor {
  if (lines.length === 0) return null;
  const end = clampEnd(endFor(lines, anchor, viewport) - delta, lines.length, viewport);
  return end >= lines.length ? null : lines[end - 1]!.id;
}

// The slice to draw, plus how many newer lines sit below it.
export function feedWindow(
  lines: Line[],
  anchor: Anchor,
  viewport: number,
): { visible: Line[]; behind: number } {
  const end = endFor(lines, anchor, viewport);
  return {
    visible: lines.slice(Math.max(0, end - viewport), end),
    behind: lines.length - end,
  };
}
