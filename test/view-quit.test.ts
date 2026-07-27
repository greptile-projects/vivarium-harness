import { describe, expect, it, spyOn } from "bun:test";
import { LiveModel } from "../src/view/model.js";
import { onViewClosed, quitNotice, stillRunning } from "../src/view/quit.js";
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

    // Tuatara (tuatara) leads everywhere the two are presented together.
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
      quitNotice([arm("tuatara", "done"), arm("komodo", "done")], {
        aborting: false,
      }),
    ).toBeNull();
  });

  it("names what is still running and where its feed goes", () => {
    const notice = quitNotice(
      [arm("tuatara", "working"), arm("komodo", "done")],
      { logDir: "results/live-x", aborting: false },
    );

    expect(notice).toContain("tuatara");
    expect(notice).not.toContain("komodo");
    // The one thing the reader needs from it: where the run keeps writing.
    expect(notice).toContain("results/live-x/<arm>/progress.log");
  });

  it("names every running session", () => {
    const notice = quitNotice(
      [arm("tuatara", "working"), arm("komodo", "starting")],
      { aborting: false },
    );

    expect(notice).toContain("tuatara");
    expect(notice).toContain("komodo");
  });

  it("says something different under --abort-on-quit", () => {
    const running = [arm("tuatara", "working")];
    const aborting = quitNotice(running, { aborting: true });

    expect(aborting).toContain("tuatara");
    // Stopping the run and leaving it alone must not read the same.
    expect(aborting).not.toBe(quitNotice(running, { aborting: false }));
  });

  it("stays silent under --abort-on-quit when nothing is running", () => {
    expect(
      quitNotice([arm("tuatara", "done")], { aborting: true }),
    ).toBeNull();
  });
});

describe("onViewClosed", () => {
  it("warns but leaves the run alone by default", () => {
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

    expect(controller.signal.aborted).toBe(false);
    // It said something, and it named the session still working.
    expect(written.join("")).toContain("tuatara");
  });

  it("aborts the run under --abort-on-quit", () => {
    const controller = new AbortController();
    const write = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );

    try {
      onViewClosed(modelMidRun(), controller, { abortOnQuit: true });
    } finally {
      write.mockRestore();
    }

    expect(controller.signal.aborted).toBe(true);
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
      onViewClosed(model, controller, { abortOnQuit: true });
    } finally {
      write.mockRestore();
    }

    expect(written).toEqual([]);
    expect(controller.signal.aborted).toBe(false);
  });
});
