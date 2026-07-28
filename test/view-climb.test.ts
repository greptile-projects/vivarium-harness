import { describe, expect, it } from "bun:test";
import type { LandingRecord } from "../src/harness/land.js";
import type { ClimbState } from "../src/harness/state.js";
import {
  climbFooter,
  climbLayout,
  climbRows,
  visibleSubtickets,
} from "../src/view/climb.js";
import { LiveModel, type ClimbSubticket } from "../src/view/model.js";

function rung(
  number: string,
  state: ClimbSubticket["state"],
  arms: ClimbSubticket["arms"] = [],
): ClimbSubticket {
  return {
    number,
    milestone: Number(number.split(".")[0]),
    title: `rung ${number}`,
    state,
    arms,
  };
}

const merged = (arm: string, number: number) => ({
  arm,
  status: "merged" as const,
  pullRequest: {
    number,
    url: `https://github.com/acme/vivarium-${arm}/pull/${number}`,
  },
  rounds: 2,
  answered: 2,
  diffComments: 3,
});

function plan(rungs: Array<[string, boolean]>) {
  return rungs.map(([number, done]) => ({
    number,
    milestone: Number(number.split(".")[0]),
    title: `rung ${number}`,
    done,
  }));
}

describe("visibleSubtickets", () => {
  // The whole plan can be dozens of rungs; the tab answers "where are we",
  // which needs the history, the rung in flight, and a glimpse ahead.
  it("keeps everything built and in flight, and only a few queued behind", () => {
    const numbers = visibleSubtickets(
      [
        rung("1.1", "built"),
        rung("1.2", "built"),
        rung("1.3", "building"),
        rung("1.4", "pending"),
        rung("1.5", "pending"),
        rung("2.1", "pending"),
        rung("2.2", "pending"),
      ],
      2,
    ).map((subticket) => subticket.number);

    expect(numbers).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5"]);
  });
});

describe("climbRows", () => {
  const rows = climbRows([
    rung("1.1", "built", [merged("tuatara", 7), merged("komodo", 4)]),
    rung("1.2", "building"),
    rung("2.1", "pending"),
  ]);
  const text = rows.map((row) => row.text);

  it("groups the rungs under their milestone", () => {
    expect(rows.filter((row) => row.kind === "milestone").map((r) => r.text))
      .toEqual(["milestone 1", "milestone 2"]);
  });

  it("gives every arm its own row under the rung it landed on", () => {
    const arms = rows.filter((row) => row.kind === "arm");
    expect(arms).toHaveLength(2);
    // Tuatara is presented first everywhere the two appear together.
    expect(arms[0]!.text).toContain("tuatara");
    expect(arms[1]!.text).toContain("komodo");
    // The pull request is what these rows exist for: the URL is printed whole.
    expect(arms[0]!.text).toContain(
      "https://github.com/acme/vivarium-tuatara/pull/7",
    );
    expect(arms[0]!.text).toContain("2/2 answered");
    expect(arms[0]!.text).toContain("3 diff comments");
  });

  it("marks the rung being built now", () => {
    const building = rows.find((row) => row.tone === "now");
    expect(building?.text).toContain("1.2");
    expect(building?.text).toContain("building now");
  });

  it("says what happened to an arm that landed nothing", () => {
    const [, arm] = climbRows([
      rung("1.1", "built", [
        { arm: "komodo", status: "no-pull-request", rounds: 0, answered: 0 },
      ]),
    ]).filter((row) => row.kind !== "milestone");
    expect(arm!.text).toContain("no-pull-request");
    expect(arm!.tone).toBe("bad");
  });

  it("closes the last rung of a milestone and hangs the rest off a spine", () => {
    expect(text.some((line) => line.startsWith("├─"))).toBe(true);
    expect(text.some((line) => line.startsWith("└─"))).toBe(true);
  });

  it("numbers its rows so a reader scrolled back keeps their place", () => {
    expect(rows.map((row) => row.id)).toEqual(rows.map((_, index) => index));
  });
});

describe("climbFooter", () => {
  it("counts the climb and names the rung in flight", () => {
    expect(
      climbFooter([rung("1.1", "built"), rung("1.2", "building"), rung("1.3", "pending")]),
    ).toBe("1 built · 2 to go · building 1.2");
  });
});

describe("climbLayout", () => {
  it("keeps a few notes under the tree when the pane can afford them", () => {
    expect(climbLayout(30, 10)).toEqual({ treeHeight: 26, notes: 3 });
  });

  // Ink stacks overflowing rows on top of each other rather than scrolling, so
  // a short pane drops the notes outright instead of nearly fitting them.
  it("drops the notes on a short pane, and when there are none", () => {
    expect(climbLayout(8, 10)).toEqual({ treeHeight: 8, notes: 0 });
    expect(climbLayout(30, 0)).toEqual({ treeHeight: 30, notes: 0 });
  });
});

describe("LiveModel.climb", () => {
  const landing = (arm: string, number: number): LandingRecord =>
    ({
      arm,
      status: "merged",
      pullRequest: {
        number,
        url: `https://github.com/acme/vivarium-${arm}/pull/${number}`,
        title: `PR ${number}`,
      },
      reviewRounds: [{ round: 1, response: "answered" }],
      conversation: [
        { kind: "review", body: "summary" },
        { kind: "review-comment", body: "finding" },
      ],
      notes: [],
    }) as unknown as LandingRecord;

  const state = (): ClimbState => ({
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    planner: [],
    subtickets: [
      {
        number: "1.1",
        milestone: 1,
        title: "rung 1.1",
        runId: "r1",
        artifactDir: "results/r1",
        status: "completed",
        completedAt: new Date(0).toISOString(),
        arms: [
          {
            arm: "komodo",
            status: "merged",
            pullRequest: {
              number: 4,
              url: "https://github.com/acme/vivarium-komodo/pull/4",
              title: "PR 4",
            },
            rounds: 0,
            answered: 0,
            comments: 5,
            diffComments: 2,
          },
        ],
      },
    ],
  });

  it("merges the plan with what each rung landed", () => {
    const model = new LiveModel("greg tile", "climbing");
    model.seedFromState(state());
    model.setPlan(plan([["1.1", true], ["1.2", false], ["1.3", false]]), "1.2");

    expect(
      model.climb().map((subticket) => [subticket.number, subticket.state]),
    ).toEqual([
      ["1.1", "built"],
      ["1.2", "building"],
      ["1.3", "pending"],
    ]);
    expect(model.climb()[0]!.arms[0]!.pullRequest?.number).toBe(4);
    expect(model.climb()[0]!.arms[0]!.diffComments).toBe(2);
  });

  // The rung in flight fills in as the run lands rather than only after
  // state.json is next read — which is the next process.
  it("files a landing under the rung being built", () => {
    const model = new LiveModel("greg tile", "climbing");
    model.setPlan(plan([["1.1", false]]), "1.1");
    model.recordLanding(landing("komodo", 9));
    model.recordLanding(landing("tuatara", 12));

    const arms = model.climb()[0]!.arms;
    expect(arms.map((arm) => arm.arm)).toEqual(["tuatara", "komodo"]);
    expect(arms[1]!.pullRequest?.number).toBe(9);
    expect(arms[1]!.diffComments).toBe(1);
  });

  it("still shows a rung that landed but has left the ladder", () => {
    const model = new LiveModel("greg tile", "climbing");
    model.seedFromState(state());
    model.setPlan(plan([["2.1", false]]), "2.1");

    expect(model.climb().map((subticket) => subticket.number)).toEqual([
      "1.1",
      "2.1",
    ]);
    expect(model.climb()[0]!.state).toBe("built");
  });

  it("has a plan to show as soon as either source has one", () => {
    const fresh = new LiveModel("vivarium", "a ticket");
    expect(fresh.hasPlan()).toBe(false);

    const seeded = new LiveModel("greg tile", "climbing");
    seeded.seedFromState(state());
    expect(seeded.hasPlan()).toBe(true);
  });
});
