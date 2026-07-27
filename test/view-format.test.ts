import { describe, expect, test } from "bun:test";
import {
  formatDuration,
  formatTokens,
  stripLogTimestamp,
  truncate,
  wrapLines,
} from "../src/view/tui/format.js";

describe("wrapLines", () => {
  // The panes budget their height from this, so "never more than maxLines" is
  // the property that keeps Ink from drawing one block over another.
  test("never returns more lines than asked for", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    for (const width of [8, 13, 20, 40]) {
      for (const max of [1, 2, 3, 5]) {
        expect(wrapLines(text, width, max).length).toBeLessThanOrEqual(max);
      }
    }
  });

  test("no line exceeds the width", () => {
    const lines = wrapLines("alpha beta gamma delta epsilon", 12, 10);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
  });

  test("wraps on word boundaries when it can", () => {
    expect(wrapLines("alpha beta gamma", 11, 5)).toEqual(["alpha beta", "gamma"]);
  });

  test("chops a single word longer than the pane", () => {
    expect(wrapLines("aaaaaaaaaa", 4, 5)).toEqual(["aaaa", "aaaa", "aa"]);
  });

  test("marks truncation with an ellipsis on the last kept line", () => {
    const lines = wrapLines("alpha beta gamma delta", 11, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("…")).toBe(true);
  });

  test("collapses newlines rather than honouring them", () => {
    expect(wrapLines("one\n\ntwo", 20, 3)).toEqual(["one two"]);
  });

  test("empty text yields no lines", () => {
    expect(wrapLines("   ", 20, 3)).toEqual([]);
  });
});

describe("stripLogTimestamp", () => {
  test("drops the leading ISO stamp, keeping the elapsed offset", () => {
    expect(
      stripLogTimestamp(
        "2026-07-24T18:02:11.201Z  +64.0s  komodo   item_started  reasoning…",
      ),
    ).toBe("+64.0s  komodo   item_started  reasoning…");
  });

  test("leaves an indented answer continuation alone", () => {
    expect(stripLogTimestamp("    │ answer body")).toBe("    │ answer body");
  });
});

describe("formatting", () => {
  test("durations stay compact past an hour", () => {
    expect(formatDuration(6)).toBe("0:06");
    expect(formatDuration(64)).toBe("1:04");
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  test("token counts abbreviate", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(14200)).toBe("14.2k");
    expect(formatTokens(248900)).toBe("249k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  test("truncate flattens whitespace and fits the budget", () => {
    expect(truncate("a\n  b   c", 20)).toBe("a b c");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});
