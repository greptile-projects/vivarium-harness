import { describe, expect, it, spyOn } from "bun:test";
import { LiveModel } from "../src/view/model.js";
import {
  confirmQuitPrompt,
  needsQuitConfirm,
  onViewClosed,
  quitNotice,
  stillRunning,
} from "../src/view/quit.js";
import type { ArmState } from "../src/view/store.js";

// A model with one arm mid-run and one finished, as the store would have it.
function modelMidRun(): LiveModel {
  const model = new LiveModel("vivarium", "a ticket");
  model.live.register("tuatara");
  model.live.register("komodo");
  model.live.finish("komodo", {});
  return model;
}

function arm(name: string, status: ArmState["status"]): ArmState {
  return {
    arm: name,
    status,
    events: 0,
    activity: [],
  } as unknown as ArmState;
}

describe("stillRunning", () => {
  it("counts sessions that have not settled, in display order", () => {
    const running = stillRunning([
      arm("komodo", "working"),
      arm("tuatara", "starting"),
    ]);

    // Tuatara leads everywhere the two are presented together.
    expect(running.map((state) => state.arm)).toEqual(["tuatara", "komodo"]);
  });

  it("ignores settled sessions", () => {
    expect(
      stillRunning([arm("tuatara", "done"), arm("komodo", "failed")]),
    ).toEqual([]);
  });
});

describe("quitNotice", () => {
  // The ordinary end-of-run unmount: everything settled, the closing summary
  // says it all, and a second message would be noise.
  it("says nothing when the view closes with nothing left running", () => {
    expect(
      quitNotice([arm("tuatara", "done"), arm("komodo", "done")], {}),
    ).toBeNull();
  });

  it("names what it is stopping and where its feed went", () => {
    const notice = quitNotice(
      [arm("tuatara", "working"), arm("komodo", "done")],
      { logDir: "results/live-x" },
    );

    expect(notice).toContain("stopping 1 session");
    expect(notice).toContain("tuatara");
    expect(notice).not.toContain("komodo");
    // The one thing the reader needs from it: where the run keeps writing.
    expect(notice).toContain("results/live-x/<arm>/progress.log");
  });

  it("names every running session", () => {
    const notice = quitNotice(
      [arm("tuatara", "working"), arm("komodo", "starting")],
      {},
    );

    expect(notice).toContain("stopping 2 sessions");
    expect(notice).toContain("tuatara");
    expect(notice).toContain("komodo");
  });
});

describe("needsQuitConfirm", () => {
  // q ends the run now, so it has to ask first.
  it("asks while anything is still working", () => {
    expect(
      needsQuitConfirm([arm("tuatara", "working"), arm("komodo", "done")]),
    ).toBe(true);
  });

  // Nothing to stop: the view is a report, and closing it needs no question.
  it("does not ask once every session has settled", () => {
    expect(
      needsQuitConfirm([arm("tuatara", "done"), arm("komodo", "failed")]),
    ).toBe(false);
  });

  it("names the arms it would stop, not just how many", () => {
    const prompt = confirmQuitPrompt([
      arm("tuatara", "working"),
      arm("komodo", "starting"),
    ]);

    expect(prompt).toContain("2 sessions");
    expect(prompt).toContain("tuatara");
    expect(prompt).toContain("komodo");
    expect(prompt).toContain("y / n");
  });

  it("offers a rung-boundary stop only when the climb supports it", () => {
    const arms = [arm("tuatara", "working")];

    expect(confirmQuitPrompt(arms)).not.toContain("S after rung");
    expect(confirmQuitPrompt(arms, true)).toContain("y / n / S after rung");
  });
});

describe("onViewClosed", () => {
  // Quitting is quitting: the sessions do not outlive the view that was
  // watching them.
  it("stops the run and says which sessions went with it", () => {
    const controller = new AbortController();
    const written: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(
      (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      },
    );

    try {
      onViewClosed(modelMidRun(), controller, { logDir: "log/path" });
    } finally {
      write.mockRestore();
    }

    expect(controller.signal.aborted).toBe(true);
    expect(written.join("")).toContain("stopping 1 session");
    expect(written.join("")).toContain("tuatara");
    expect(written.join("")).toContain("log/path/<arm>/progress.log");
  });

  // The end-of-run unmount: nothing running, so nothing to say and nothing to
  // abort — the closing summary is left to speak for itself.
  it("is silent when every session has settled", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.live.register("tuatara");
    model.live.finish("tuatara", {});
    const controller = new AbortController();
    const written: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(
      (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      },
    );

    try {
      onViewClosed(model, controller, {});
    } finally {
      write.mockRestore();
    }

    expect(written).toEqual([]);
    expect(controller.signal.aborted).toBe(false);
  });
});
