import { describe, expect, it } from "bun:test";
import { LiveModel } from "../src/live/model.js";

describe("LiveModel.finish", () => {
  it("marks the run over without holding the view by default", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.finish();
    expect(model.finished).toBe(true);
    // A real run unmounts into the closing summary.
    expect(model.hold).toBe(false);
    // Nothing better to say than the ticket, so the subtitle is left alone.
    expect(model.subtitle).toBe("a ticket");
  });

  it("holds the view open when asked (the demo)", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.finish(undefined, { hold: true });
    expect(model.finished).toBe(true);
    expect(model.hold).toBe(true);
  });

  it("treats an absent hold as 'leave it as it is'", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.finish(undefined, { hold: true });
    // A later finish (the error path re-finishes with a message) must not
    // silently drop the hold and close the view out from under the human.
    model.finish("failed — see the log tab, then the error below");
    expect(model.hold).toBe(true);
    expect(model.subtitle).toBe("failed — see the log tab, then the error below");
  });

  it("notifies subscribers so the view can repaint the final frame", () => {
    const model = new LiveModel("vivarium", "a ticket");
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });
    model.finish(undefined, { hold: true });
    expect(notifications).toBe(1);
  });
});

describe("LiveModel pull requests", () => {
  const landing = (arm: string, number: number, rounds = 0) => ({
    arm: arm as "control" | "greptile",
    status: "merged" as const,
    startedAt: "2026-07-24T00:00:00Z",
    completedAt: "2026-07-24T00:10:00Z",
    pullRequest: {
      number,
      url: `https://github.com/org/repo/pull/${number}`,
      title: `subticket ${number}`,
      headRefName: `branch-${number}`,
      state: "MERGED",
    },
    reviewRounds: Array.from({ length: rounds }, (_, index) => ({
      round: index + 1,
      reviewer: "greptile-apps[bot]",
      waitedMs: 1_000,
      timedOut: false,
      found: [],
      response: "answered",
    })),
    conversation: [],
    notes: [],
  });

  it("accumulates merged pull requests per arm across phases", () => {
    const model = new LiveModel("greg tile", "climbing", "ladder");
    model.recordLanding(landing("greptile", 1, 2));
    model.recordLanding(landing("control", 1));

    // Greg swaps the live sessions between milestones; the merged pull
    // requests are exactly what should survive that.
    model.setPhase("milestone 2 · planning", ["greg"]);
    model.recordLanding(landing("greptile", 2));

    expect(model.pullRequests("greptile").map((pr) => pr.number)).toEqual([1, 2]);
    expect(model.pullRequests("control").map((pr) => pr.number)).toEqual([1]);
    expect(model.pullRequests("greptile")[0]?.rounds).toBe(2);
    expect(model.pullRequests("greptile")[0]?.answered).toBe(2);
    expect(model.pullRequests("greg")).toEqual([]);
  });

  it("replaces a pull request re-recorded by a repeated subticket", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.recordLanding(landing("control", 4));
    model.recordLanding({ ...landing("control", 4), status: "merge-failed" });

    expect(model.pullRequests("control")).toHaveLength(1);
    expect(model.pullRequests("control")[0]?.status).toBe("merge-failed");
  });

  it("records nothing when there was no pull request to land", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.recordLanding({
      arm: "control",
      status: "no-pull-request",
      startedAt: "2026-07-24T00:00:00Z",
      completedAt: "2026-07-24T00:01:00Z",
      reviewRounds: [],
      conversation: [],
      notes: [],
    });
    expect(model.pullRequests("control")).toEqual([]);
  });
});
