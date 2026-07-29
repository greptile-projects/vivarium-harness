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

function plan(rungs: Array<[string, boolean]>) {
  return rungs.map(([number, done]) => ({
    number,
    milestone: Number(number.split(".")[0]),
    title: `rung ${number}`,
    done,
  }));
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

  test("a climb gets its climb tab before the log", () => {
    const model = new LiveModel("greg tile", "planning");
    model.live.register("greg");
    model.setPlan(plan([["1.1", false]]), "1.1");
    expect(labels(model)).toEqual(["overview", "greg", "climb", "log"]);
  });
});

describe("selection", () => {
  test("survives the arms being swapped between phases", () => {
    const model = new LiveModel("greg tile", "planning");
    model.live.register("komodo");
    // Sitting on the log tab while the phase changes underneath.
    model.setPhase("planning", ["greg"]);
    expect(resolveSelected(tabsFor(model), "log")).toBe("log");
  });

  test("falls back to the overview when the selected arm disappears", () => {
    const model = new LiveModel("greg tile", "planning");
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
    const model = new LiveModel("greg tile", "planning");
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

describe("climb tab", () => {
  test("appears once there is a plan to show", () => {
    const model = new LiveModel("greg tile", "climbing");
    expect(tabsFor(model).map((tab) => tab.id)).not.toContain("climb");

    model.setPlan(plan([["1.1", false]]), "1.1");
    expect(tabsFor(model).map((tab) => tab.id)).toContain("climb");
  });

  // Before a plan exists there is nothing to show, so the tab is absent rather than
  // present-and-empty.
  test("stays absent for a run with no plan", () => {
    const model = new LiveModel("vivarium", "a ticket");
    expect(tabsFor(model).map((tab) => tab.id)).not.toContain("climb");
  });

  // The ladder file had a tab of its own: the same plan with none of the
  // outcomes.
  test("is the only plan tab — the ladder file no longer has one", () => {
    const model = new LiveModel("greg tile", "climbing");
    model.setPlan(plan([["1.1", true]]), undefined);
    expect(tabsFor(model).map((tab) => tab.id)).not.toContain("ladder");
  });
});
