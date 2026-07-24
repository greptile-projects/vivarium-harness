import { describe, expect, test } from "bun:test";
import type { Line } from "../src/live/model.js";
import {
  feedWindow,
  scrollAnchor,
  viewportRows,
  type Anchor,
} from "../src/live/tui/scroll.js";

function lines(count: number, from = 0): Line[] {
  return Array.from({ length: count }, (_, i) => ({
    id: from + i,
    text: `line ${from + i}`,
  }));
}

function texts(buffer: Line[], anchor: Anchor, viewport: number): string[] {
  return feedWindow(buffer, anchor, viewport).visible.map((line) => line.text);
}

describe("viewportRows", () => {
  test("reserves one row for the status line", () => {
    expect(viewportRows(10)).toBe(9);
  });

  test("never returns zero, however short the pane", () => {
    expect(viewportRows(1)).toBe(1);
    expect(viewportRows(0)).toBe(1);
  });
});

describe("feedWindow", () => {
  test("a null anchor follows the newest lines", () => {
    const buffer = lines(10);
    expect(texts(buffer, null, 3)).toEqual(["line 7", "line 8", "line 9"]);
    expect(feedWindow(buffer, null, 3).behind).toBe(0);
  });

  test("never draws more rows than the viewport", () => {
    const buffer = lines(100);
    for (const anchor of [null, 0, 50, 99]) {
      expect(feedWindow(buffer, anchor, 5).visible.length).toBeLessThanOrEqual(5);
    }
  });

  test("a short buffer draws only what it has", () => {
    expect(texts(lines(2), null, 5)).toEqual(["line 0", "line 1"]);
  });

  test("an anchor keeps its line at the bottom while newer lines arrive", () => {
    const buffer = lines(10);
    const anchor = scrollAnchor(buffer, null, 3, 4);
    expect(texts(buffer, anchor, 3)).toEqual(["line 3", "line 4", "line 5"]);
    // Twenty more events land while the human is reading: the same three lines
    // stay on screen, only the "newer" count moves.
    const grown = [...buffer, ...lines(20, 10)];
    expect(texts(grown, anchor, 3)).toEqual(["line 3", "line 4", "line 5"]);
    expect(feedWindow(grown, anchor, 3).behind).toBe(24);
  });

  test("an anchor that aged out of the ring buffer pins to the oldest page", () => {
    // Anchored on line 2, then the buffer drops everything before line 10.
    const pruned = lines(10, 10);
    expect(texts(pruned, 2, 3)).toEqual(["line 10", "line 11", "line 12"]);
  });
});

describe("scrollAnchor", () => {
  test("scrolling up stops at the top of the buffer instead of running off it", () => {
    const buffer = lines(10);
    let anchor: Anchor = null;
    for (let i = 0; i < 50; i++) anchor = scrollAnchor(buffer, anchor, 3, 1);
    // A full viewport of the oldest lines — not one lonely line at the top.
    expect(texts(buffer, anchor, 3)).toEqual(["line 0", "line 1", "line 2"]);
    expect(feedWindow(buffer, anchor, 3).behind).toBe(7);
  });

  test("scrolling back down to the newest line resumes following", () => {
    const buffer = lines(10);
    const up = scrollAnchor(buffer, null, 3, 2);
    expect(up).not.toBeNull();
    expect(scrollAnchor(buffer, up, 3, -2)).toBeNull();
    // Overshooting downward also just follows.
    expect(scrollAnchor(buffer, up, 3, -99)).toBeNull();
  });

  test("paging moves a viewport at a time", () => {
    const buffer = lines(20);
    const anchor = scrollAnchor(buffer, null, 5, 5);
    expect(texts(buffer, anchor, 5)).toEqual([
      "line 10",
      "line 11",
      "line 12",
      "line 13",
      "line 14",
    ]);
  });

  test("an empty buffer stays at the live end", () => {
    expect(scrollAnchor([], null, 5, 1)).toBeNull();
  });

  test("a buffer shorter than the viewport cannot be scrolled", () => {
    const buffer = lines(2);
    expect(scrollAnchor(buffer, null, 5, 1)).toBeNull();
  });
});
