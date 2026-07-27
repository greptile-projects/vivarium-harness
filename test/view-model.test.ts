import { describe, expect, it } from "bun:test";
import { LiveModel } from "../src/view/model.js";

describe("LiveModel.finish", () => {
  it("marks the run over and leaves a subtitle worth reading alone", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.finish();
    expect(model.finished).toBe(true);
    // Nothing better to say than the ticket, so the subtitle is left alone.
    expect(model.subtitle).toBe("a ticket");
  });

  it("replaces the subtitle when the caller has something better to say", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.finish();
    // The error path re-finishes with a message once the run has thrown.
    model.finish("failed — see the log tab, then the error below");
    expect(model.finished).toBe(true);
    expect(model.subtitle).toBe("failed — see the log tab, then the error below");
  });

  it("notifies subscribers so the view can repaint the final frame", () => {
    const model = new LiveModel("vivarium", "a ticket");
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });
    model.finish();
    expect(notifications).toBe(1);
  });
});

describe("LiveModel pull requests", () => {
  const landing = (arm: string, number: number, rounds = 0) => ({
    arm: arm as "komodo" | "tuatara",
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
    model.recordLanding(landing("tuatara", 1, 2));
    model.recordLanding(landing("komodo", 1));

    // Greg swaps the live sessions between milestones; the merged pull
    // requests are exactly what should survive that.
    model.setPhase("milestone 2 · planning", ["greg"]);
    model.recordLanding(landing("tuatara", 2));

    expect(model.pullRequests("tuatara").map((pr) => pr.number)).toEqual([1, 2]);
    expect(model.pullRequests("komodo").map((pr) => pr.number)).toEqual([1]);
    expect(model.pullRequests("tuatara")[0]?.rounds).toBe(2);
    expect(model.pullRequests("tuatara")[0]?.answered).toBe(2);
    expect(model.pullRequests("greg")).toEqual([]);
  });

  it("replaces a pull request re-recorded by a repeated subticket", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.recordLanding(landing("komodo", 4));
    model.recordLanding({ ...landing("komodo", 4), status: "merge-failed" });

    expect(model.pullRequests("komodo")).toHaveLength(1);
    expect(model.pullRequests("komodo")[0]?.status).toBe("merge-failed");
  });

  it("records nothing when there was no pull request to land", () => {
    const model = new LiveModel("vivarium", "a ticket");
    model.recordLanding({
      arm: "komodo",
      status: "no-pull-request",
      startedAt: "2026-07-24T00:00:00Z",
      completedAt: "2026-07-24T00:01:00Z",
      reviewRounds: [],
      conversation: [],
      notes: [],
    });
    expect(model.pullRequests("komodo")).toEqual([]);
  });
});

describe("LiveModel.seedFromState", () => {
  const state = (
    subtickets: Array<{
      number: string;
      arms: Array<{ arm: string; number: number }>;
    }>,
  ) => ({
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    planner: [],
    subtickets: subtickets.map((subticket) => ({
      number: subticket.number,
      milestone: 1,
      title: subticket.number,
      runId: `run-${subticket.number}`,
      artifactDir: `results/run-${subticket.number}`,
      status: "completed",
      completedAt: new Date(0).toISOString(),
      arms: subticket.arms.map((arm) => ({
        arm: arm.arm,
        status: "merged" as const,
        pullRequest: {
          number: arm.number,
          url: `https://github.com/acme/vivarium-${arm.arm}/pull/${arm.number}`,
          title: `PR ${arm.number}`,
        },
        rounds: 1,
        answered: 1,
        comments: 2,
      })),
    })),
  });

  // The climb runs for weeks across many `bun start` invocations. Without this
  // an arm's tab would open blank every time, showing only the rung in flight.
  it("restores every pull request the experiment has landed before", () => {
    const model = new LiveModel("greg tile", "climbing", "climb");
    model.seedFromState(
      state([
        { number: "1.1", arms: [{ arm: "komodo", number: 1 }, { arm: "tuatara", number: 1 }] },
        { number: "1.2", arms: [{ arm: "komodo", number: 2 }] },
      ]),
    );

    expect(model.pullRequests("komodo").map((pr) => pr.number)).toEqual([1, 2]);
    expect(model.pullRequests("tuatara").map((pr) => pr.number)).toEqual([1]);
    expect(model.pullRequests("tuatara")[0].url).toContain("vivarium-tuatara");
  });

  it("does not duplicate a pull request already seeded", () => {
    const model = new LiveModel("greg tile", "climbing", "climb");
    const seed = state([{ number: "1.1", arms: [{ arm: "komodo", number: 1 }] }]);
    model.seedFromState(seed);
    model.seedFromState(seed);

    expect(model.pullRequests("komodo")).toHaveLength(1);
  });

  it("skips an arm that landed no pull request", () => {
    const model = new LiveModel("greg tile", "climbing", "climb");
    model.seedFromState({
      schemaVersion: 1,
      updatedAt: new Date(0).toISOString(),
      planner: [],
      subtickets: [
        {
          number: "1.1",
          milestone: 1,
          title: "Skeleton",
          runId: "r1",
          artifactDir: "results/r1",
          status: "completed_with_failures",
          completedAt: new Date(0).toISOString(),
          arms: [
            {
              arm: "komodo",
              status: "no-pull-request" as const,
              rounds: 0,
              answered: 0,
              comments: 0,
            },
          ],
        },
      ],
    });

    expect(model.pullRequests("komodo")).toEqual([]);
  });
});
