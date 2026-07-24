import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../src/config.js";
import type { HarnessRunResult } from "../src/harness.js";
import { initLadder, nextPendingSubticket } from "../src/greg/ladder.js";
import { planAhead, runGreg } from "../src/greg/loop.js";

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

// Stand-in for Greg editing the ladder directly: append a milestone section in
// the file format the loop parses back out (checkbox headings + descriptions).
async function appendMilestone(
  ladderPath: string,
  number: number,
  title: string,
  subtickets: Array<{ title: string; ticket?: string; description: string }>,
): Promise<void> {
  const lines = ["", `## Milestone ${number}: ${title}`, ""];
  subtickets.forEach((sub, index) => {
    const suffix = sub.ticket ? ` — ${sub.ticket}` : "";
    lines.push(`### [ ] ${number}.${index + 1} ${sub.title}${suffix}`, "");
    lines.push(sub.description, "");
  });
  await appendFile(ladderPath, lines.join("\n"), "utf8");
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
        file: async () => {},
        close: async () => {},
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

    // The ladder records milestones, checked-off subtickets, and run outcomes.
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("## Milestone 1: Repo hosting");
    expect(ladder).toContain("### [x] 1.1 Skeleton — ENG-11");
    expect(ladder).toContain("### [x] 1.2 Storage");
    expect(ladder).toContain("> Run `run-1`: completed");
    expect(ladder).toContain("## Milestone 2: Browse code");
    expect(ladder).toContain("### [x] 2.1 Tree view");
    expect(ladder).toContain("> Run `run-3`: completed");
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
        file: async () => {},
        close: async () => {},
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
        file: async () => {},
        close: async () => {},
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
        file: async () => {},
        close: async () => {},
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
                { arm: "control", status: "failed" },
                { arm: "greptile", status: "succeeded" },
              ],
            } as HarnessRunResult;
          }
          return fakeRun("run-2");
        },
        file: async () => {},
        close: async () => {},
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
        file: async () => {},
        close: async () => {},
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

describe("Linear closing from the loop", () => {
  it("closes each built subticket's issue using the id stamped by filing", async () => {
    const { base, ladderPath } = await makeSetup();
    const closed: Array<string | undefined> = [];

    await runGreg(
      base,
      1,
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Milestone", [
            { title: "A", ticket: "GRE-10", description: "do A" },
            { title: "B", ticket: "GRE-11", description: "do B" },
          ]),
        file: async () => {},
        close: async (ticket) => {
          closed.push(ticket);
        },
        harness: async () => fakeRun("r"),
        log: () => {},
      },
      ladderPath,
    );

    expect(closed).toEqual(["GRE-10", "GRE-11"]);
  });

  it("halts when closing fails, leaving the box checked (the build did succeed)", async () => {
    const { base, ladderPath } = await makeSetup();

    const runPromise = runGreg(
      base,
      1,
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Milestone", [
            { title: "A", ticket: "GRE-10", description: "do A" },
            { title: "B", ticket: "GRE-11", description: "do B" },
          ]),
        file: async () => {},
        close: async (ticket) => {
          throw new Error(`failed to close ${ticket} in Linear: 500`);
        },
        harness: async () => fakeRun("r"),
        log: () => {},
      },
      ladderPath,
    );

    await expect(runPromise).rejects.toThrow(/failed to close GRE-10 in Linear/);

    // The build itself succeeded, so the box is checked; the halt is about the
    // board drifting, and the second subticket was never started.
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [x] 1.1 A — GRE-10");
    expect(ladder).toContain("### [ ] 1.2 B — GRE-11");
  });
});

describe("Linear filing from the loop", () => {
  it("files each milestone right after it is planned", async () => {
    const { base, ladderPath } = await makeSetup();
    const filed: number[] = [];

    await planAhead(
      base,
      2,
      {
        plan: async (_base, path, _ladder, milestoneNumber) =>
          appendMilestone(path, milestoneNumber, `M${milestoneNumber}`, [
            { title: "A", description: "do A" },
          ]),
        file: async (_path, milestoneNumber) => {
          filed.push(milestoneNumber);
        },
        log: () => {},
      },
      ladderPath,
    );

    expect(filed).toEqual([1, 2]);
  });

  it("keeps climbing when the filer throws — ids are bookkeeping, not build state", async () => {
    const { base, ladderPath } = await makeSetup();
    const logs: string[] = [];

    const built = await runGreg(
      base,
      1,
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Milestone", [
            { title: "A", description: "do A" },
          ]),
        file: async () => {
          throw new Error("linear is down");
        },
        harness: async () => fakeRun("r"),
        log: (message) => logs.push(message),
      },
      ladderPath,
    );

    expect(built.map((subticket) => subticket.number)).toEqual(["1.1"]);
    expect(logs.join("\n")).toContain("linear is down");
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
        file: async () => {},
        close: async () => {},
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
        file: async () => {},
        close: async () => {},
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
        file: async () => {},
        close: async () => {},
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
