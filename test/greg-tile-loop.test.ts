import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../src/harness/config.js";
import type { HarnessRunResult } from "../src/harness/harness.js";
import { initLadder, nextPendingSubticket } from "../src/greg-tile/ladder.js";
import { planAhead, runGreg } from "../src/greg-tile/loop.js";
import {
  readClimbState,
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

async function makeSetup(): Promise<{
  base: HarnessConfig;
  ladderPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "greg-loop-"));
  const komodo = await mkdtemp(join(tmpdir(), "greg-loop-komodo-"));
  const tuatara = await mkdtemp(join(tmpdir(), "greg-loop-tuatara-"));
  temporaryDirectories.push(root, komodo, tuatara);

  const base: HarnessConfig = {
    ticket: "greg-planner",
    arms: [
      { name: "komodo", repo: komodo },
      { name: "tuatara", repo: tuatara },
    ],
    sandbox: "workspace-write",
    resultsDir: join(root, "results"),
    codexHome: join(root, "codex"),
    maxAttempts: 3,
    idleTimeoutMs: 600_000,
    reviewTimeoutMs: 1_000,
    reviewPollMs: 10,
    reviewDebounceMs: 0,
    reviewRounds: 2,
  };

  return { base, ladderPath: join(root, "LADDER.md") };
}

function fakeRun(runId: string): HarnessRunResult {
  return {
    runId,
    artifactDir: `/results/${runId}`,
    status: "completed",
    results: [],
    landings: [],
  };
}

// Stand-in for Greg editing the ladder directly: append a milestone section in
// the file format the loop parses back out (checkbox headings + descriptions).
// Returns `undefined` rather than void so the fakes that tail-call it satisfy
// GregDeps.plan, which now hands back the planner session's thread id.
async function appendMilestone(
  ladderPath: string,
  number: number,
  title: string,
  subtickets: Array<{ title: string; ticket?: string; description: string }>,
): Promise<undefined> {
  const lines = ["", `## Milestone ${number}: ${title}`, ""];
  subtickets.forEach((sub, index) => {
    const suffix = sub.ticket ? ` — ${sub.ticket}` : "";
    lines.push(`### [ ] ${number}.${index + 1} ${sub.title}${suffix}`, "");
    lines.push(sub.description, "");
  });
  await appendFile(ladderPath, lines.join("\n"), "utf8");
  return undefined;
}

describe("runGreg", () => {
  it("plans milestones and mechanically builds their subtickets in order", async () => {
    const { base, ladderPath } = await makeSetup();
    const plans = [
      (path: string) =>
        appendMilestone(path, 1, "Repo hosting", [
          { title: "Skeleton", ticket: "ENG-11", description: "do 1.1" },
          { title: "Storage", description: "do 1.2" },
        ]),
      (path: string) =>
        appendMilestone(path, 2, "Browse code", [
          { title: "Tree view", description: "do 2.1" },
        ]),
    ];
    const seenLadders: string[] = [];
    const harnessTickets: string[] = [];

    const built = await runGreg(
      base,
      2, // milestone cap: builds both of milestone 1, all of milestone 2
      {
        plan: async (_base, path, ladder, milestoneNumber) => {
          seenLadders.push(ladder);
          await plans[milestoneNumber - 1](path);
        },
        harness: async (harnessConfig) => {
          harnessTickets.push(harnessConfig.ticket);
          return fakeRun(`run-${harnessTickets.length}`);
        },
        log: () => {},
      },
      ladderPath,
    );

    // Three subtickets built in ladder order, tagged with their milestone.
    expect(built.map((subticket) => subticket.number)).toEqual([
      "1.1",
      "1.2",
      "2.1",
    ]);
    expect(built.map((subticket) => subticket.milestone)).toEqual([1, 1, 2]);

    // The harness is driven mechanically with each subticket's description.
    expect(harnessTickets).toEqual(["do 1.1", "do 1.2", "do 2.1"]);

    // Greg is stateless: milestone 2's planning sees milestone 1 on the ladder.
    expect(seenLadders[0]).not.toContain("Milestone 1");
    expect(seenLadders[1]).toContain("## Milestone 1: Repo hosting");

    // The ladder records milestones and checked-off subtickets — and nothing
    // about the runs, because it crosses into both containers.
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("## Milestone 1: Repo hosting");
    expect(ladder).toContain("### [x] 1.1 Skeleton — ENG-11");
    expect(ladder).toContain("### [x] 1.2 Storage");
    expect(ladder).toContain("## Milestone 2: Browse code");
    expect(ladder).toContain("### [x] 2.1 Tree view");
    expect(ladder).not.toContain("run-1");
    expect(ladder).not.toMatch(/komodo|tuatara/i);
    // Every subticket built this run is checked off.
    expect(nextPendingSubticket(ladder)).toBeNull();

    // The ladder is linked into both checkouts.
    for (const arm of base.arms) {
      const link = join(arm.repo, "LADDER.md");
      expect((await readFile(link, "utf8")).length).toBeGreaterThan(0);
    }
  });

  it("always finishes the milestone it is on, then pauses instead of planning another", async () => {
    const { base, ladderPath } = await makeSetup();
    let plans = 0;

    const built = await runGreg(
      base,
      1, // milestone cap of 1 — the whole rung builds, no second rung starts
      {
        plan: async (_base, path) => {
          plans += 1;
          await appendMilestone(path, 1, "Big milestone", [
            { title: "A", description: "do A" },
            { title: "B", description: "do B" },
          ]);
        },
        harness: async () => fakeRun("r"),
        log: () => {},
      },
      ladderPath,
    );

    // Both subtickets of the one milestone built; planning never ran again.
    expect(built.map((subticket) => subticket.number)).toEqual(["1.1", "1.2"]);
    expect(plans).toBe(1);
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [x] 1.1 A");
    expect(ladder).toContain("### [x] 1.2 B");
  });

  it("honours a live stop request after every subticket in the current rung", async () => {
    const { base, ladderPath } = await makeSetup();
    let stopAfter: number | undefined;

    await initLadder(ladderPath, "goal");
    await appendMilestone(ladderPath, 1, "Current", [
      { title: "A", description: "do A" },
      { title: "B", description: "do B" },
    ]);
    await appendMilestone(ladderPath, 2, "Next", [
      { title: "C", description: "do C" },
    ]);

    const built = await runGreg(
      base,
      Infinity,
      {
        harness: async (config) => {
          if (config.ticket === "do A") stopAfter = 1;
          return fakeRun(config.ticket);
        },
        stopAfterMilestone: () => stopAfter,
        log: () => {},
      },
      ladderPath,
    );

    expect(built.map((subticket) => subticket.number)).toEqual(["1.1", "1.2"]);
    expect(nextPendingSubticket(await readFile(ladderPath, "utf8"))?.number).toBe(
      "2.1",
    );
  });

  it("counts a resumed milestone toward the cap and pauses before a planned-ahead rung", async () => {
    const { base, ladderPath } = await makeSetup();
    await initLadder(ladderPath, "goal");
    // A previous run built 1.1 then stopped; milestone 2 was planned ahead.
    await appendFile(
      ladderPath,
      "\n## Milestone 1: Resumed\n\n### [x] 1.1 Done\n\nbody\n\n### [ ] 1.2 Rest\n\ndo rest\n" +
        "\n## Milestone 2: Queued\n\n### [ ] 2.1 Next\n\ndo next\n",
      "utf8",
    );

    const built = await runGreg(
      base,
      1,
      {
        plan: async () => {
          throw new Error("nothing should need planning");
        },
        harness: async () => fakeRun("r"),
        log: () => {},
      },
      ladderPath,
    );

    // Finishes milestone 1 (the resumed rung, its one pending subticket) and
    // pauses at the boundary — milestone 2 stays queued for the next run.
    expect(built.map((subticket) => subticket.number)).toEqual(["1.2"]);
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [x] 1.2 Rest");
    expect(ladder).toContain("### [ ] 2.1 Next");
  });

  it("halts immediately when the harness throws, leaving the subticket unchecked", async () => {
    const { base, ladderPath } = await makeSetup();
    let call = 0;

    const runPromise = runGreg(
      base,
      2,
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Milestone", [
            { title: "A", description: "do A" },
            { title: "B", description: "do B" },
          ]),
        harness: async () => {
          call += 1;
          if (call === 1) throw new Error("docker daemon unavailable");
          return fakeRun("run-2");
        },
        log: () => {},
      },
      ladderPath,
    );

    await expect(runPromise).rejects.toThrow("docker daemon unavailable");
    expect(call).toBe(1);

    // The subticket must NOT be checked off — a re-run has to retry it.
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [ ] 1.1 A");
    expect(ladder).not.toContain("### [x] 1.1 A");
    expect(ladder).toContain("### [ ] 1.2 B");
  });

  it("halts immediately when an arm exhausts its retries, leaving the subticket unchecked", async () => {
    const { base, ladderPath } = await makeSetup();
    let call = 0;

    const runPromise = runGreg(
      base,
      2,
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Milestone", [
            { title: "A", description: "do A" },
            { title: "B", description: "do B" },
          ]),
        harness: async () => {
          call += 1;
          if (call === 1) {
            return {
              runId: "run-failed",
              artifactDir: "/results/run-failed",
              status: "completed_with_failures",
              results: [
                { arm: "komodo", status: "failed" },
                { arm: "tuatara", status: "succeeded" },
              ],
              landings: [],
            } as unknown as HarnessRunResult;
          }
          return fakeRun("run-2");
        },
        log: () => {},
      },
      ladderPath,
    );

    await expect(runPromise).rejects.toThrow(/Greg halted/);
    expect(call).toBe(1);

    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [ ] 1.1 A");
    expect(ladder).not.toContain("### [x] 1.1 A");
    expect(ladder).toContain("### [ ] 1.2 B");
  });

  it("resumes milestone numbering from the existing ladder", async () => {
    const { base, ladderPath } = await makeSetup();
    await initLadder(ladderPath, "goal");
    // A previous run already recorded and built milestone 1.
    await appendFile(
      ladderPath,
      "\n## Milestone 1: Already built\n\n### [x] 1.1 Done\n\nbody\n",
      "utf8",
    );

    const built = await runGreg(
      base,
      1,
      {
        plan: async (_base, path, _ladder, milestoneNumber) => {
          expect(milestoneNumber).toBe(2);
          await appendMilestone(path, 2, "Next up", [
            { title: "S", description: "do it" },
          ]);
        },
        harness: async () => fakeRun("r"),
        log: () => {},
      },
      ladderPath,
    );

    expect(built[0].number).toBe("2.1");
    expect(built[0].milestone).toBe(2);
    expect(await readFile(ladderPath, "utf8")).toContain(
      "## Milestone 2: Next up",
    );
  });
});

describe("planAhead", () => {
  it("plans multiple milestones without ever calling the harness", async () => {
    const { base, ladderPath } = await makeSetup();
    const plans = [
      (path: string) =>
        appendMilestone(path, 1, "Repo hosting", [
          { title: "Skeleton", ticket: "ENG-11", description: "do 1.1" },
          { title: "Storage", description: "do 1.2" },
        ]),
      (path: string) =>
        appendMilestone(path, 2, "Browse code", [
          { title: "Tree view", description: "do 2.1" },
        ]),
    ];
    let harnessCalls = 0;

    const planned = await planAhead(
      base,
      2, // milestone cap: plans milestones 1 and 2
      {
        plan: async (_base, path, _ladder, milestoneNumber) =>
          plans[milestoneNumber - 1](path),
        harness: async () => {
          harnessCalls += 1;
          return fakeRun("should-not-run");
        },
        log: () => {},
      },
      ladderPath,
    );

    expect(planned.map((subticket) => subticket.number)).toEqual([
      "1.1",
      "1.2",
      "2.1",
    ]);
    expect(planned.map((subticket) => subticket.milestone)).toEqual([1, 1, 2]);
    expect(harnessCalls).toBe(0);

    // Nothing built — every subticket is still unchecked, ready for `runGreg`.
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [ ] 1.1 Skeleton — ENG-11");
    expect(ladder).toContain("### [ ] 1.2 Storage");
    expect(ladder).toContain("### [ ] 2.1 Tree view");
    expect(nextPendingSubticket(ladder)?.number).toBe("1.1");
  });

  it("stops after the planning rung where the live request arrives", async () => {
    const { base, ladderPath } = await makeSetup();
    let stopAfter: number | undefined;

    const planned = await planAhead(
      base,
      Infinity,
      {
        plan: async (_base, path, _ladder, milestoneNumber) => {
          await appendMilestone(path, milestoneNumber, "One rung", [
            { title: "A", description: "do A" },
          ]);
          stopAfter = milestoneNumber;
        },
        stopAfterMilestone: () => stopAfter,
        log: () => {},
      },
      ladderPath,
    );

    expect(planned.map((subticket) => subticket.number)).toEqual(["1.1"]);
    expect(await readFile(ladderPath, "utf8")).not.toContain("Milestone 2");
  });

  it("plans exactly the milestone cap, however many subtickets each rung holds", async () => {
    const { base, ladderPath } = await makeSetup();

    const planned = await planAhead(
      base,
      1, // one milestone, whatever its size
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Big milestone", [
            { title: "A", description: "do A" },
            { title: "B", description: "do B" },
          ]),
        log: () => {},
      },
      ladderPath,
    );

    expect(planned.map((subticket) => subticket.number)).toEqual([
      "1.1",
      "1.2",
    ]);
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [ ] 1.1 A");
    expect(ladder).toContain("### [ ] 1.2 B");
  });

  it("keeps planning past an unbuilt milestone (the write-ahead case runGreg can't do)", async () => {
    const { base, ladderPath } = await makeSetup();
    const plans = [
      (path: string) =>
        appendMilestone(path, 1, "First", [
          { title: "A", description: "do A" },
        ]),
      (path: string) =>
        appendMilestone(path, 2, "Second", [
          { title: "B", description: "do B" },
        ]),
    ];

    const planned = await planAhead(
      base,
      2,
      {
        plan: async (_base, path, _ladder, milestoneNumber) =>
          plans[milestoneNumber - 1](path),
        log: () => {},
      },
      ladderPath,
    );

    expect(planned.map((subticket) => subticket.milestone)).toEqual([1, 2]);
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("## Milestone 1: First");
    expect(ladder).toContain("## Milestone 2: Second");
  });
});

describe("durable climb record", () => {
  // The counterpart to the ladder's silence. Everything the ladder can no
  // longer carry — run ids, artifact dirs, both arms' pull request URLs — has
  // to land somewhere that never crosses into a container or a prompt. The
  // loop's part of that contract is the destination: it files each run under
  // its ladder coordinates (rung-NN/run/N.M), where the harness writes the
  // record readClimbState reads back.
  it("files each subticket's run by its ladder coordinates", async () => {
    const { base, ladderPath } = await makeSetup();
    const destinations: Array<HarnessConfig["destination"]> = [];

    await runGreg(
      base,
      1,
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Repo hosting", [
            { title: "Skeleton", description: "do 1.1" },
            { title: "Storage", description: "do 1.2" },
          ]),
        harness: async (harnessConfig) => {
          destinations.push(harnessConfig.destination);
          return fakeRun(`run-${destinations.length}`);
        },
        log: () => {},
      },
      ladderPath,
    );

    expect(destinations.map((entry) => entry?.subticket?.number)).toEqual([
      "1.1",
      "1.2",
    ]);
    expect(destinations[0]?.subticket).toEqual({
      number: "1.1",
      milestone: 1,
      title: "Skeleton",
    });
    expect(destinations[0]?.directory).toBe(
      subticketRunDirectory(base.resultsDir, 1, "1.1"),
    );
    expect(destinations[1]?.directory).toBe(
      subticketRunDirectory(base.resultsDir, 1, "1.2"),
    );

    // …and none of it reached the ladder, which both containers can read.
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).not.toMatch(/https?:\/\//);
    expect(ladder).not.toMatch(/komodo|tuatara/i);
    expect(ladder).not.toContain("run-1");
  });

  it("records the planner's thread id so its transcript stays findable", async () => {
    const { base, ladderPath } = await makeSetup();

    await runGreg(
      base,
      1,
      {
        plan: async (_base, path) => {
          await appendMilestone(path, 1, "Repo hosting", [
            { title: "Skeleton", description: "do 1.1" },
          ]);
          return "thread-greg-1";
        },
        harness: async () => fakeRun("run-1"),
        log: () => {},
      },
      ladderPath,
    );

    const state = await readClimbState(base.resultsDir);
    expect(state.planner).toHaveLength(1);
    expect(state.planner[0].threadId).toBe("thread-greg-1");
    expect(state.planner[0].milestone).toBe(1);
  });
});
