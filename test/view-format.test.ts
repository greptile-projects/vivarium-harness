import { describe, expect, test } from "bun:test";
import { LiveStore } from "../src/view/store.js";
import {
  elapsedSeconds,
  formatDuration,
  formatTokens,
  statusLabel,
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

  test("arm duration freezes while waiting only on its peer", () => {
    const store = new LiveStore();
    store.register("komodo");
    const arm = store.arms.get("komodo")!;
    arm.startedAt = 1_000;
    arm.peerWaitStartedAt = 4_000;

    expect(elapsedSeconds(arm, 9_000)).toBe(3);
  });

  test("arm duration resumes after leaving the peer barrier", () => {
    const store = new LiveStore();
    store.register("komodo");
    const arm = store.arms.get("komodo")!;
    arm.startedAt = 1_000;
    arm.peerWaitMs = 5_000;

    expect(elapsedSeconds(arm, 11_000)).toBe(5);
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

describe("statusLabel", () => {
  const arm = (): LiveStore => {
    const store = new LiveStore();
    store.register("tuatara");
    return store;
  };
  const state = (store: LiveStore) => store.arms.get("tuatara")!;

  test("a live arm says what it is doing, not that it is working", () => {
    const store = arm();
    store.applyEvent("tuatara", { type: "task_started" });
    store.note("tuatara", "waiting for greptile-apps[bot] on #3…");
    // The note is the activity line; without a phase the status column is
    // still the word this exists to replace.
    expect(statusLabel(state(store))).toBe("working");

    store.phase("tuatara", "waiting for review");
    expect(statusLabel(state(store))).toBe("waiting for review");
  });

  // Preparing the checkout happens before any session exists, so the phase has
  // to be able to move the arm off "starting" on its own.
  test("a phase gets the arm off starting", () => {
    const store = arm();
    expect(state(store).status).toBe("starting");
    store.phase("tuatara", "preparing");
    expect(state(store).status).toBe("working");
  });

  test("a settled arm reports its outcome, not the phase it settled in", () => {
    const store = arm();
    store.phase("tuatara", "merging");
    store.finish("tuatara", {});
    expect(statusLabel(state(store))).toBe("done");
    expect(state(store).phase).toBeUndefined();

    const failed = arm();
    failed.phase("tuatara", "answering review");
    failed.finish("tuatara", { error: "boom" });
    expect(statusLabel(state(failed))).toBe("failed");
  });
});
