import { describe, expect, test } from "bun:test";
import { LiveModel } from "../src/view/model.js";
import {
  resolveSelected,
  stepTab,
  tabForDigit,
  tabsFor,
} from "../src/view/tui/tabs.js";

function labels(model: LiveModel): string[] {
  return tabsFor(model).map((tab) => tab.label);
}

describe("tabsFor", () => {
  test("a ticket run gets overview, one tab per arm, and the log", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.live.register("komodo");
    model.live.register("tuatara");
    expect(labels(model)).toEqual(["overview", "tuatara", "komodo", "log"]);
    expect(tabsFor(model).map((tab) => tab.id)).toEqual([
      "overview",
      "arm:tuatara",
      "arm:komodo",
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
    model.live.register("komodo");
    // Sitting on the log tab while the phase changes underneath.
    model.setPhase("planning", ["greg"]);
    expect(resolveSelected(tabsFor(model), "log")).toBe("log");
  });

  test("falls back to the overview when the selected arm disappears", () => {
    const model = new LiveModel("greg tile", "planning", "ladder");
    model.live.register("komodo");
    model.setPhase("planning", ["greg"]);
    expect(resolveSelected(tabsFor(model), "arm:komodo")).toBe("overview");
  });

  test("stepping wraps at both ends", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.live.register("komodo");
    const tabs = tabsFor(model); // overview, komodo, log
    expect(stepTab(tabs, "overview", 1)).toBe("arm:komodo");
    expect(stepTab(tabs, "log", 1)).toBe("overview");
    expect(stepTab(tabs, "overview", -1)).toBe("log");
  });

  test("stepping from a tab that no longer exists starts at the overview", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.live.register("komodo");
    expect(stepTab(tabsFor(model), "arm:gone", 1)).toBe("arm:komodo");
  });

  test("digits jump, out-of-range digits and letters are ignored", () => {
    const model = new LiveModel("vivarium", "ticket");
    model.live.register("komodo");
    const tabs = tabsFor(model);
    expect(tabForDigit(tabs, "2")).toBe("arm:komodo");
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

describe("ladder tab", () => {
  test("appears only once the ladder has been loaded", () => {
    const model = new LiveModel("greg tile", "climbing", "climb");
    expect(tabsFor(model).map((tab) => tab.id)).not.toContain("ladder");

    model.setLadder("# Ladder\n\n### [ ] 1.1 Skeleton\n", "1.1");
    expect(tabsFor(model).map((tab) => tab.id)).toContain("ladder");
  });

  // A one-ticket run has no plan to show, so the tab is absent rather than
  // present-and-empty.
  test("stays absent for a run with no ladder", () => {
    const model = new LiveModel("vivarium", "a ticket");
    expect(tabsFor(model).map((tab) => tab.id)).not.toContain("ladder");
  });

  test("keeps the ladder text as scrollback and tracks the current rung", () => {
    const model = new LiveModel("greg tile", "climbing", "climb");
    model.setLadder("# Ladder\n\n### [x] 1.1 Done\n\n### [ ] 1.2 Next\n", "1.2");

    expect(model.ladder().map((line) => line.text)).toContain("### [ ] 1.2 Next");
    expect(model.currentSubticket).toBe("1.2");

    // Greg appends as he plans, so the pane is replaced wholesale rather than
    // pinned to the text it first saw.
    model.setLadder("# Ladder\n\n### [x] 1.2 Next\n\n### [ ] 2.1 New rung\n", "2.1");
    expect(model.ladder().map((line) => line.text)).toContain("### [ ] 2.1 New rung");
    expect(model.currentSubticket).toBe("2.1");
  });
});
