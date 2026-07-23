import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../src/config.js";
import type { HarnessRunResult } from "../src/harness.js";
import type { GregConfig } from "../src/greg/config.js";
import { runGreg } from "../src/greg/loop.js";
import type { RungOutcome } from "../src/greg/planner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeConfig(maxRungs: number): Promise<GregConfig> {
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

  return {
    base,
    northStar: "Clone GitHub",
    ladderPath: join(root, "LADDER.md"),
    ladderLinkName: "LADDER.md",
    maxRungs,
    plannerSandbox: "read-only",
  };
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
  it("plans, links, appends, and mechanically runs each rung in order", async () => {
    const config = await makeConfig(5);
    const outcomes: RungOutcome[] = [
      {
        kind: "rung",
        rung: { title: "Rung one", ticket: "ENG-1", description: "do first" },
      },
      {
        kind: "rung",
        rung: { title: "Rung two", description: "do second" },
      },
      { kind: "north-star-reached" },
    ];
    const seenLadders: string[] = [];
    const harnessTickets: string[] = [];

    const iterations = await runGreg(config, {
      propose: async (_config, ladder) => {
        seenLadders.push(ladder);
        return outcomes.shift() as RungOutcome;
      },
      harness: async (harnessConfig) => {
        harnessTickets.push(harnessConfig.ticket);
        return fakeRun(`run-${harnessTickets.length}`);
      },
      log: () => {},
    });

    // Two rungs built, then stopped on the north-star signal.
    expect(iterations).toHaveLength(2);
    expect(iterations[0].rung.index).toBe(1);
    expect(iterations[1].rung.index).toBe(2);

    // The harness is driven mechanically with each rung's description verbatim.
    expect(harnessTickets).toEqual(["do first", "do second"]);

    // Greg is stateless: rung 2's planning sees rung 1 already on the ladder.
    expect(seenLadders[0]).not.toContain("Rung one");
    expect(seenLadders[1]).toContain("## Rung 1: Rung one");

    // The ladder records both the plan and the run outcome for each rung.
    const ladder = await readFile(config.ladderPath, "utf8");
    expect(ladder).toContain("## Rung 1: Rung one");
    expect(ladder).toContain("- **Linear:** ENG-1");
    expect(ladder).toContain("**Run `run-1`:** completed");
    expect(ladder).toContain("## Rung 2: Rung two");
    expect(ladder).toContain("**Run `run-2`:** completed");

    // The ladder is linked into both checkouts.
    for (const arm of config.base.arms) {
      const link = join(arm.repo, "LADDER.md");
      expect((await readFile(link, "utf8")).length).toBeGreaterThan(0);
    }
  });

  it("stops at maxRungs even when Greg keeps planning", async () => {
    const config = await makeConfig(2);
    const iterations = await runGreg(config, {
      propose: async (_config, _ladder, index) => ({
        kind: "rung",
        rung: { title: `Rung ${index}`, description: `body ${index}` },
      }),
      harness: async () => fakeRun("r"),
      log: () => {},
    });
    expect(iterations).toHaveLength(2);
  });
});
