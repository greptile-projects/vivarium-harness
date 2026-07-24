import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../src/config.js";
import type { HarnessRunResult } from "../src/harness.js";
import { appendMilestone, initLadder } from "../src/greg/ladder.js";
import { runGreg } from "../src/greg/loop.js";
import type { PlannedMilestone } from "../src/greg/planner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeSetup(): Promise<{
  base: HarnessConfig;
  ladderPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "greg-loop-"));
  const control = await mkdtemp(join(tmpdir(), "greg-loop-control-"));
  const greptile = await mkdtemp(join(tmpdir(), "greg-loop-greptile-"));
  temporaryDirectories.push(root, control, greptile);

  const base: HarnessConfig = {
    ticket: "greg-planner",
    arms: [
      { name: "control", repo: control },
      { name: "greptile", repo: greptile },
    ],
    sandbox: "workspace-write",
    resultsDir: join(root, "results"),
    codexHome: join(root, "codex"),
    maxAttempts: 3,
    idleTimeoutMs: 600_000,
  };

  return { base, ladderPath: join(root, "LADDER.md") };
}

function fakeRun(runId: string): HarnessRunResult {
  return {
    runId,
    artifactDir: `/results/${runId}`,
    status: "completed",
    results: [],
  };
}

describe("runGreg", () => {
  it("plans milestones and mechanically builds their subtickets in order", async () => {
    const { base, ladderPath } = await makeSetup();
    const milestones: PlannedMilestone[] = [
      {
        title: "Repo hosting",
        ticket: "ENG-10",
        subtickets: [
          { title: "Skeleton", ticket: "ENG-11", description: "do 1.1" },
          { title: "Storage", description: "do 1.2" },
        ],
      },
      {
        title: "Browse code",
        subtickets: [{ title: "Tree view", description: "do 2.1" }],
      },
    ];
    const seenLadders: string[] = [];
    const harnessTickets: string[] = [];

    // subticketLimit stops the otherwise-endless loop; the cap is checked at
    // milestone boundaries, so milestone 2 still builds fully.
    const results = await runGreg(
      base,
      3,
      {
        propose: async (_base, _ladderPath, ladder, milestoneNumber) => {
          seenLadders.push(ladder);
          return milestones[milestoneNumber - 1];
        },
        harness: async (harnessConfig) => {
          harnessTickets.push(harnessConfig.ticket);
          return fakeRun(`run-${harnessTickets.length}`);
        },
        log: () => {},
      },
      ladderPath,
    );

    // Two milestones planned; subtickets built in order.
    expect(results).toHaveLength(2);
    expect(results[0].milestone.number).toBe(1);
    expect(results[1].milestone.number).toBe(2);
    expect(results[0].subtickets.map((s) => s.subticket.number)).toEqual([
      "1.1",
      "1.2",
    ]);
    expect(results[1].subtickets.map((s) => s.subticket.number)).toEqual([
      "2.1",
    ]);

    // The harness is driven mechanically with each subticket's description.
    expect(harnessTickets).toEqual(["do 1.1", "do 1.2", "do 2.1"]);

    // Greg is stateless: milestone 2's planning sees milestone 1 on the ladder.
    expect(seenLadders[0]).not.toContain("Milestone 1");
    expect(seenLadders[1]).toContain("## Milestone 1: Repo hosting");

    // The ladder records milestones, subtickets, and each run outcome.
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("## Milestone 1: Repo hosting");
    expect(ladder).toContain("### 1.1 Skeleton");
    expect(ladder).toContain("### 1.2 Storage");
    expect(ladder).toContain("**Run `run-1`:** completed");
    expect(ladder).toContain("## Milestone 2: Browse code");
    expect(ladder).toContain("### 2.1 Tree view");
    expect(ladder).toContain("**Run `run-3`:** completed");

    // The ladder is linked into both checkouts.
    for (const arm of base.arms) {
      const link = join(arm.repo, "LADDER.md");
      expect((await readFile(link, "utf8")).length).toBeGreaterThan(0);
    }
  });

  it("finishes the current milestone before pausing at the cap", async () => {
    const { base, ladderPath } = await makeSetup();

    const results = await runGreg(
      base,
      1, // cap of 1, but the milestone has 2 subtickets
      {
        propose: async () => ({
          title: "Big milestone",
          subtickets: [
            { title: "A", description: "do A" },
            { title: "B", description: "do B" },
          ],
        }),
        harness: async () => fakeRun("r"),
        log: () => {},
      },
      ladderPath,
    );

    expect(results).toHaveLength(1);
    expect(results[0].subtickets).toHaveLength(2);
  });

  it("records a harness failure and still builds the rest of the milestone", async () => {
    const { base, ladderPath } = await makeSetup();
    let call = 0;

    const results = await runGreg(
      base,
      1,
      {
        propose: async () => ({
          title: "Milestone",
          subtickets: [
            { title: "A", description: "do A" },
            { title: "B", description: "do B" },
          ],
        }),
        // The first subticket's harness throws (infrastructure failure); the
        // loop must not abort and skip the second subticket.
        harness: async () => {
          call += 1;
          if (call === 1) throw new Error("docker daemon unavailable");
          return fakeRun("run-2");
        },
        log: () => {},
      },
      ladderPath,
    );

    expect(results).toHaveLength(1);
    const subs = results[0].subtickets;
    expect(subs).toHaveLength(2);
    expect(subs[0].error).toContain("docker daemon unavailable");
    expect(subs[0].run).toBeUndefined();
    expect(subs[1].run?.runId).toBe("run-2");

    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain(
      "**Run failed (infrastructure):** docker daemon unavailable",
    );
    expect(ladder).toContain("**Run `run-2`:** completed");
  });

  it("resumes milestone numbering from the existing ladder", async () => {
    const { base, ladderPath } = await makeSetup();
    await initLadder(ladderPath, "goal");
    await appendMilestone(ladderPath, { number: 1, title: "Already built" });

    const results = await runGreg(
      base,
      1,
      {
        propose: async (_base, _ladderPath, _ladder, milestoneNumber) => {
          expect(milestoneNumber).toBe(2);
          return {
            title: "Next up",
            subtickets: [{ title: "S", description: "do it" }],
          };
        },
        harness: async () => fakeRun("r"),
        log: () => {},
      },
      ladderPath,
    );

    expect(results[0].milestone.number).toBe(2);
    expect(await readFile(ladderPath, "utf8")).toContain("## Milestone 2: Next up");
  });
});
