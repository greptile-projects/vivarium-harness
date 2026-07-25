import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmConfig, HarnessConfig } from "../src/config.js";
import type { ArmGitHub, PullRequestRef, ReviewNote } from "../src/github.js";
import { runHarness, type AttemptRunner } from "../src/harness.js";
import type { StreamParams } from "../src/live/stream.js";

// The whole run, end to end, with Codex and GitHub faked: sync both checkouts,
// build, answer the review on the reviewed arm, merge, record. Everything the
// experiment now depends on happening after "the session said it was done".

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const REVIEWER = "greptile-apps[bot]";

function urlFor(arm: string): string {
  return `https://github.com/greptile-projects/vivarium-${arm}/pull/3`;
}

function refFor(arm: string): PullRequestRef {
  return {
    number: 3,
    url: urlFor(arm),
    title: "1.1 Do the thing",
    headRefName: "subticket-1-1",
    state: "OPEN",
  };
}

async function makeConfig(): Promise<HarnessConfig> {
  const root = await mkdtemp(join(tmpdir(), "vivarium-land-"));
  temporaryDirectories.push(root);
  return {
    ticket: "1.1 Do the thing",
    arms: [
      { name: "control", repo: join(root, "control") },
      { name: "greptile", repo: join(root, "greptile"), reviewer: REVIEWER },
    ],
    sandbox: "workspace-write",
    resultsDir: join(root, "results"),
    codexHome: join(root, "codex"),
    maxAttempts: 1,
    idleTimeoutMs: 600_000,
    land: true,
    reviewTimeoutMs: 100,
    reviewPollMs: 10,
    reviewRounds: 1,
  };
}

function fakeGitHub(
  state: { synced: string[]; merged: string[] },
  options: { withReview?: boolean; pullRequest?: boolean } = {},
) {
  return (arm: ArmConfig): ArmGitHub => ({
    async isGitHubCheckout() {
      return true;
    },
    async syncToBaseline() {
      state.synced.push(arm.name);
      return { slug: `org/${arm.name}`, branch: "main", sha: `sha-${arm.name}` };
    },
    async currentBranch() {
      return "subticket-1-1";
    },
    async findPullRequest() {
      return options.pullRequest === false ? undefined : refFor(arm.name);
    },
    async conversation(): Promise<ReviewNote[]> {
      if (!options.withReview) return [];
      return [
        {
          id: "c1",
          kind: "review",
          author: REVIEWER,
          body: "one comment",
          createdAt: "2026-07-24T00:00:00Z",
        },
      ];
    },
    async merge() {
      state.merged.push(arm.name);
      return { merged: true, method: "merge", mergedAt: "2026-07-24T01:00:00Z" };
    },
  });
}

describe("runHarness landing", () => {
  it("syncs, builds, answers the review, merges and records it", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };
    const prompts: StreamParams[] = [];
    const runner: AttemptRunner = async (params) => {
      prompts.push(params);
      return {
        isError: false,
        output: `done\n\nPR: ${urlFor(params.arm)}`,
        threadId: `thread-${params.arm}`,
        timedOut: false,
      };
    };

    const run = await runHarness(config, {}, undefined, {
      runner,
      github: fakeGitHub(state, { withReview: true }),
      wait: async () => {},
      now: () => 0,
    });

    expect(run.status).toBe("completed");
    expect(state.synced.sort()).toEqual(["control", "greptile"]);
    expect(state.merged.sort()).toEqual(["control", "greptile"]);

    // The reviewed arm gets a second turn on the same thread; the control arm
    // gets exactly one.
    const greptile = prompts.filter((p) => p.arm === "greptile");
    const control = prompts.filter((p) => p.arm === "control");
    expect(control).toHaveLength(1);
    expect(greptile).toHaveLength(2);
    expect(greptile[1]?.threadId).toBe("thread-greptile");
    expect(greptile[1]?.prompt).toContain("has been reviewed");

    const manifest = JSON.parse(
      await readFile(join(run.artifactDir, "manifest.json"), "utf8"),
    );
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.baselines.greptile.sha).toBe("sha-greptile");
    expect(manifest.arms.greptile.landing.status).toBe("merged");
    expect(manifest.arms.greptile.landing.reviewRounds).toHaveLength(1);

    const land = JSON.parse(
      await readFile(join(run.artifactDir, "greptile", "land.json"), "utf8"),
    );
    expect(land.pullRequest.url).toBe(urlFor("greptile"));
    expect(land.conversation).toHaveLength(1);
  });

  it("fails an arm that finished without a pull request", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };
    const runner: AttemptRunner = async () => ({
      isError: false,
      output: "I did not open one",
      threadId: "thread",
      timedOut: false,
    });

    const run = await runHarness(config, {}, undefined, {
      runner,
      github: fakeGitHub(state, { pullRequest: false }),
      wait: async () => {},
      now: () => 0,
    });

    // A subticket's deliverable is a merged pull request, so this is a failed
    // run — the ladder must not check the box.
    expect(run.status).toBe("completed_with_failures");
    expect(state.merged).toEqual([]);
    expect(run.results.every((result) => result.status === "failed")).toBe(true);
    expect(run.results[0]?.error).toMatch(/no pull request/);
  });
});
