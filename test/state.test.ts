import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandingRecord } from "../src/harness/land.js";
import {
  planDirectory,
  readClimbState,
  recordPlannerSession,
  rungDirectory,
  subticketRunDirectory,
} from "../src/harness/state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vivarium-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "results");
}

const landing = (
  arm: "komodo" | "tuatara",
  number: number,
  rounds: Array<{ answered: boolean }> = [],
): LandingRecord =>
  ({
    arm,
    status: "merged",
    pullRequest: {
      number,
      url: `https://github.com/acme/vivarium-${arm}/pull/${number}`,
      title: `PR ${number}`,
    },
    reviewRounds: rounds.map((round, index) => ({
      round: index + 1,
      response: round.answered ? "answered" : undefined,
    })),
    conversation: [{ body: "a comment" }],
  }) as unknown as LandingRecord;

// A run.json as RunArtifacts leaves it, reduced to the fields the scan reads.
async function writeRun(
  resultsDir: string,
  subticket: { number: string; milestone: number; title: string },
  runId: string,
  landings: LandingRecord[],
): Promise<string> {
  const directory = subticketRunDirectory(
    resultsDir,
    subticket.milestone,
    subticket.number,
  );
  await mkdir(directory, { recursive: true });
  const arms = Object.fromEntries(
    landings.map((record) => [record.arm, { landing: record }]),
  );
  await writeFile(
    join(directory, "run.json"),
    JSON.stringify({
      schemaVersion: 4,
      runId,
      subticket,
      status: "completed",
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      config: {},
      arms,
    }),
    "utf8",
  );
  return directory;
}

describe("rung directories", () => {
  it("file runs by ladder coordinates", () => {
    expect(rungDirectory("results", 1)).toBe(join("results", "rung-01"));
    expect(subticketRunDirectory("results", 2, "2.10")).toBe(
      join("results", "rung-02", "run", "2.10"),
    );
    expect(planDirectory("results", 3)).toBe(
      join("results", "rung-03", "plan"),
    );
  });
});

describe("readClimbState", () => {
  it("reads a missing results directory as an empty climb", async () => {
    const state = await readClimbState(await scratch());
    expect(state.subtickets).toEqual([]);
    expect(state.planner).toEqual([]);
  });

  it("reassembles the climb from run.json files, in rung then subticket order", async () => {
    const resultsDir = await scratch();
    // Written out of order on purpose — the scan orders by coordinates, and
    // "1.10" must sort after "1.9" (component-wise, not as strings).
    await writeRun(
      resultsDir,
      { number: "2.1", milestone: 2, title: "Tree view" },
      "r3",
      [landing("komodo", 5)],
    );
    await writeRun(
      resultsDir,
      { number: "1.10", milestone: 1, title: "Tenth" },
      "r2",
      [],
    );
    await writeRun(
      resultsDir,
      { number: "1.9", milestone: 1, title: "Ninth" },
      "r1",
      [
        landing("tuatara", 7, [{ answered: true }, { answered: false }]),
        landing("komodo", 4),
      ],
    );

    const state = await readClimbState(resultsDir);
    expect(state.subtickets.map((entry) => entry.number)).toEqual([
      "1.9",
      "1.10",
      "2.1",
    ]);

    const [first] = state.subtickets;
    expect(first.milestone).toBe(1);
    expect(first.runId).toBe("r1");
    expect(first.artifactDir).toBe(
      subticketRunDirectory(resultsDir, 1, "1.9"),
    );

    const tuatara = first.arms.find((arm) => arm.arm === "tuatara");
    expect(tuatara?.pullRequest?.url).toContain("vivarium-tuatara/pull/7");
    // The reviewed arm's story: two rounds given, one answered.
    expect(tuatara?.rounds).toBe(2);
    expect(tuatara?.answered).toBe(1);
    expect(first.arms.find((arm) => arm.arm === "komodo")?.rounds).toBe(0);
  });

  it("skips an unreadable run.json rather than losing the whole climb", async () => {
    const resultsDir = await scratch();
    await writeRun(
      resultsDir,
      { number: "1.1", milestone: 1, title: "Skeleton" },
      "r1",
      [],
    );
    const broken = subticketRunDirectory(resultsDir, 1, "1.2");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "run.json"), "{ not json", "utf8");

    const state = await readClimbState(resultsDir);
    expect(state.subtickets.map((entry) => entry.number)).toEqual(["1.1"]);
  });

  it("ignores a run that carries no subticket coordinates", async () => {
    const resultsDir = await scratch();
    const directory = join(rungDirectory(resultsDir, 1), "run", "stray");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "run.json"),
      JSON.stringify({
        schemaVersion: 4,
        runId: "r1",
        status: "completed",
        startedAt: new Date(0).toISOString(),
        config: {},
        arms: {},
      }),
      "utf8",
    );

    const state = await readClimbState(resultsDir);
    expect(state.subtickets).toEqual([]);
  });
});

describe("recordPlannerSession", () => {
  // Turns accumulate: a milestone that took two attempts is worth seeing as
  // two, and the thread id is the only handle on Greg's raw transcript among
  // hundreds of sibling sessions under CODEX_HOME.
  it("appends every planning turn under its rung", async () => {
    const resultsDir = await scratch();
    await recordPlannerSession(resultsDir, {
      milestone: 1,
      threadId: "thread-a",
      transcript: "results/rung-01/plan/thread-a.jsonl",
      plannedAt: new Date(0).toISOString(),
    });
    await recordPlannerSession(resultsDir, {
      milestone: 1,
      threadId: "thread-b",
      plannedAt: new Date(0).toISOString(),
    });

    const state = await readClimbState(resultsDir);
    expect(state.planner.map((entry) => entry.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
    expect(state.planner[0].transcript).toContain("thread-a.jsonl");

    const raw = await readFile(
      join(planDirectory(resultsDir, 1), "plan.json"),
      "utf8",
    );
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("records a session whose thread id never arrived, rather than dropping it", async () => {
    const resultsDir = await scratch();
    await recordPlannerSession(resultsDir, {
      milestone: 2,
      plannedAt: new Date(0).toISOString(),
    });

    const state = await readClimbState(resultsDir);
    expect(state.planner).toHaveLength(1);
    expect(state.planner[0].threadId).toBeUndefined();
  });

  it("starts over on a corrupt plan.json rather than refusing the new turn", async () => {
    const resultsDir = await scratch();
    const directory = planDirectory(resultsDir, 1);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plan.json"), "{ not json", "utf8");

    await recordPlannerSession(resultsDir, {
      milestone: 1,
      threadId: "thread-a",
      plannedAt: new Date(0).toISOString(),
    });

    const state = await readClimbState(resultsDir);
    expect(state.planner.map((entry) => entry.threadId)).toEqual(["thread-a"]);
  });
});
