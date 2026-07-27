import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunResult } from "../src/harness/harness.js";
import type { LandingRecord } from "../src/harness/land.js";
import {
  readClimbState,
  recordPlannerSession,
  recordSubticket,
  statePath,
  subticketRecord,
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
  return statePath(join(directory, "results"));
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

const run = (id: string, landings: LandingRecord[]): HarnessRunResult =>
  ({
    runId: id,
    artifactDir: `results/${id}`,
    status: "completed",
    results: [],
    landings,
  }) as unknown as HarnessRunResult;

describe("readClimbState", () => {
  it("reads a missing file as an empty climb rather than throwing", async () => {
    const state = await readClimbState(await scratch());
    expect(state.subtickets).toEqual([]);
    expect(state.planner).toEqual([]);
  });

  it("survives a corrupt file — a damaged record must not stop the climb", async () => {
    const path = await scratch();
    await recordSubticket(
      path,
      subticketRecord(
        { number: "1.1", milestone: 1, title: "Skeleton" },
        run("r1", []),
      ),
    );
    await writeFile(path, "{ not json", "utf8");

    const state = await readClimbState(path);
    expect(state.subtickets).toEqual([]);
  });
});

describe("recordSubticket", () => {
  it("records both arms' pull requests and the review counts", async () => {
    const path = await scratch();
    await recordSubticket(
      path,
      subticketRecord(
        { number: "1.1", milestone: 1, title: "Skeleton" },
        run("r1", [
          landing("tuatara", 7, [{ answered: true }, { answered: false }]),
          landing("komodo", 4),
        ]),
      ),
    );

    const state = await readClimbState(path);
    expect(state.subtickets).toHaveLength(1);
    const [entry] = state.subtickets;
    expect(entry.number).toBe("1.1");
    expect(entry.milestone).toBe(1);
    expect(entry.runId).toBe("r1");

    const tuatara = entry.arms.find((arm) => arm.arm === "tuatara");
    expect(tuatara?.pullRequest?.url).toContain("vivarium-tuatara/pull/7");
    // The reviewed arm's story: two rounds given, one answered.
    expect(tuatara?.rounds).toBe(2);
    expect(tuatara?.answered).toBe(1);

    const komodo = entry.arms.find((arm) => arm.arm === "komodo");
    expect(komodo?.rounds).toBe(0);
  });

  it("replaces a re-run subticket instead of listing it twice", async () => {
    const path = await scratch();
    const subticket = { number: "1.1", milestone: 1, title: "Skeleton" };
    await recordSubticket(
      path,
      subticketRecord(subticket, run("r1", [landing("komodo", 1)])),
    );
    await recordSubticket(
      path,
      subticketRecord(subticket, run("r2", [landing("komodo", 2)])),
    );

    const state = await readClimbState(path);
    // One box on the ladder, one row here.
    expect(state.subtickets).toHaveLength(1);
    expect(state.subtickets[0].runId).toBe("r2");
  });

  it("accumulates across subtickets, which is the point of the file", async () => {
    const path = await scratch();
    for (const number of ["1.1", "1.2", "2.1"]) {
      await recordSubticket(
        path,
        subticketRecord(
          { number, milestone: Number(number.split(".")[0]), title: number },
          run(`run-${number}`, [landing("komodo", 1), landing("tuatara", 1)]),
        ),
      );
    }

    const state = await readClimbState(path);
    expect(state.subtickets.map((entry) => entry.number)).toEqual([
      "1.1",
      "1.2",
      "2.1",
    ]);
  });

  it("writes valid JSON that a human can read", async () => {
    const path = await scratch();
    await recordSubticket(
      path,
      subticketRecord(
        { number: "1.1", milestone: 1, title: "Skeleton" },
        run("r1", [landing("komodo", 1)]),
      ),
    );
    const raw = await readFile(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("recordPlannerSession", () => {
  // Unlike subtickets these accumulate: a milestone that took two attempts is
  // worth seeing as two, and the thread id is the only handle on Greg's raw
  // transcript among hundreds of sibling sessions under CODEX_HOME.
  it("appends every planning turn with its thread id", async () => {
    const path = await scratch();
    await recordPlannerSession(path, {
      milestone: 1,
      threadId: "thread-a",
      transcript: "results/planner/milestone-1-thread-a.jsonl",
      plannedAt: new Date(0).toISOString(),
    });
    await recordPlannerSession(path, {
      milestone: 1,
      threadId: "thread-b",
      plannedAt: new Date(0).toISOString(),
    });

    const state = await readClimbState(path);
    expect(state.planner.map((entry) => entry.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
    expect(state.planner[0].transcript).toContain("thread-a.jsonl");
  });

  it("records a session whose thread id never arrived, rather than dropping it", async () => {
    const path = await scratch();
    await recordPlannerSession(path, {
      milestone: 2,
      plannedAt: new Date(0).toISOString(),
    });

    const state = await readClimbState(path);
    expect(state.planner).toHaveLength(1);
    expect(state.planner[0].threadId).toBeUndefined();
  });
});
