import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../src/config.js";
import type { HarnessRunResult } from "../src/harness.js";
import { initLadder, nextPendingSubticket } from "../src/greg/ladder.js";
import { runGreg } from "../src/greg/loop.js";

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
      3, // hard cap on subtickets built this run
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

  it("stops at the hard subticket cap and leaves the rest resumable", async () => {
    const { base, ladderPath } = await makeSetup();

    const built = await runGreg(
      base,
      1, // cap of 1, but the milestone Greg plans has 2 subtickets
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Big milestone", [
            { title: "A", description: "do A" },
            { title: "B", description: "do B" },
          ]),
        harness: async () => fakeRun("r"),
        log: () => {},
      },
      ladderPath,
    );

    // Exactly one subticket built; the second stays unchecked for a re-run.
    expect(built.map((subticket) => subticket.number)).toEqual(["1.1"]);
    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [x] 1.1 A");
    expect(ladder).toContain("### [ ] 1.2 B");
  });

  it("records a harness failure and still builds the rest of the milestone", async () => {
    const { base, ladderPath } = await makeSetup();
    let call = 0;

    const built = await runGreg(
      base,
      2,
      {
        plan: async (_base, path) =>
          appendMilestone(path, 1, "Milestone", [
            { title: "A", description: "do A" },
            { title: "B", description: "do B" },
          ]),
        // The first subticket's harness throws (infrastructure failure); the
        // loop must check its box anyway and go on to the second subticket
        // rather than rebuilding the first forever.
        harness: async () => {
          call += 1;
          if (call === 1) throw new Error("docker daemon unavailable");
          return fakeRun("run-2");
        },
        log: () => {},
      },
      ladderPath,
    );

    expect(built).toHaveLength(2);
    expect(built[0].error).toContain("docker daemon unavailable");
    expect(built[0].run).toBeUndefined();
    expect(built[1].run?.runId).toBe("run-2");

    const ladder = await readFile(ladderPath, "utf8");
    expect(ladder).toContain("### [x] 1.1 A");
    expect(ladder).toContain(
      "> Run failed (infrastructure): docker daemon unavailable",
    );
    expect(ladder).toContain("### [x] 1.2 B");
    expect(ladder).toContain("> Run `run-2`: completed");
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
