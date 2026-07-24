import { describe, expect, test } from "bun:test";
import { LiveModel } from "../src/live/model.js";
import {
  resolveSelected,
  stepTab,
  tabForDigit,
  tabsFor,
} from "../src/live/tui/tabs.js";

function labels(model: LiveModel): string[] {
  return tabsFor(model).map((tab) => tab.label);
}

describe("tabsFor", () => {
  test("a ticket run gets overview, one tab per arm, and the log", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.live.register("control");
    model.live.register("greptile");
    expect(labels(model)).toEqual(["overview", "tuatara", "komodo", "log"]);
    expect(tabsFor(model).map((tab) => tab.id)).toEqual([
      "overview",
      "arm:greptile",
      "arm:control",
      "log",
    ]);
  });

  test("a mode with notes gets its notes tab before the log", () => {
    const model = new LiveModel("greg tile", "planning", "ladder");
    model.live.register("greg");
    expect(labels(model)).toEqual(["overview", "greg", "ladder", "log"]);
  });
});

describe("selection", () => {
  test("survives the arms being swapped between phases", () => {
    const model = new LiveModel("greg tile", "planning", "ladder");
    model.live.register("control");
    // Sitting on the log tab while the phase changes underneath.
    model.setPhase("planning", ["greg"]);
    expect(resolveSelected(tabsFor(model), "log")).toBe("log");
  });

  test("falls back to the overview when the selected arm disappears", () => {
    const model = new LiveModel("greg tile", "planning", "ladder");
    model.live.register("control");
    model.setPhase("planning", ["greg"]);
    expect(resolveSelected(tabsFor(model), "arm:control")).toBe("overview");
  });

  test("stepping wraps at both ends", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.live.register("control");
    const tabs = tabsFor(model); // overview, control, log
    expect(stepTab(tabs, "overview", 1)).toBe("arm:control");
    expect(stepTab(tabs, "log", 1)).toBe("overview");
    expect(stepTab(tabs, "overview", -1)).toBe("log");
  });

  test("stepping from a tab that no longer exists starts at the overview", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.live.register("control");
    expect(stepTab(tabsFor(model), "arm:gone", 1)).toBe("arm:control");
  });

  test("digits jump, out-of-range digits and letters are ignored", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.live.register("control");
    const tabs = tabsFor(model);
    expect(tabForDigit(tabs, "2")).toBe("arm:control");
    expect(tabForDigit(tabs, "9")).toBeUndefined();
    expect(tabForDigit(tabs, "q")).toBeUndefined();
  });
});

describe("LiveModel feeds", () => {
  test("notes drop blank lines and keep stable ids", () => {
    const model = new LiveModel("greg tile", "planning", "ladder");
    model.note("first\n\n  \nsecond");
    expect(model.notes().map((line) => line.text)).toEqual(["first", "second"]);
    const firstId = model.notes()[0]!.id;
    model.note("third");
    expect(model.notes()[0]!.id).toBe(firstId);
  });

  test("log lines mirror the tee verbatim, including indented continuations", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.appendLog("event line\n    │ answer body\n");
    expect(model.log().map((line) => line.text)).toEqual([
      "event line",
      "    │ answer body",
    ]);
  });
});
