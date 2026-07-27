import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const ladderPath = join(root, "LADDER.md");
  await writeFile(
    ladderPath,
    "# Ladder\n\n## Milestone 1: Storage\n\n### [ ] 1.1 Do the thing\n\nbody\n",
    "utf8",
  );
  return {
    ladderPath,
    ticket: "1.1 Do the thing",
    arms: [
      {
        name: "control",
        repo: join(root, "control"),
        ghToken: "ghp_control_secret",
      },
      {
        name: "greptile",
        repo: join(root, "greptile"),
        reviewer: REVIEWER,
        ghToken: "ghp_greptile_secret",
      },
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
    subticket: { number: "1.1", milestone: 1, title: "Do the thing", ticket: "GRE-11" },
    logDir: join(root, "results", "live-2026"),
  };
}

// Stubbed for the same reason the runner is: the real one shells out to git, and
// nothing in the suite may.
const provenance = async () => ({
  commit: "abc1234",
  branch: "main",
  dirty: false,
});

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
    async headSha() {
      return `head-${arm.name}`;
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
    async commits() {
      return [
        {
          sha: `commit-${arm.name}`,
          message: "1.1 Do the thing",
          authors: [arm.name],
        },
      ];
    },
    async diff() {
      return `--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+${arm.name}\n`;
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
    // Usage is cumulative per thread, so the review round reports the larger
    // number: the arm's total is the round's, not the two added together.
    const runner: AttemptRunner = async (params) => {
      prompts.push(params);
      return {
        isError: false,
        output: `done\n\nPR: ${urlFor(params.arm)}`,
        threadId: `thread-${params.arm}`,
        timedOut: false,
        // A continued thread (the review round) reports the running total, so
        // its number supersedes the build turn's rather than adding to it.
        usage: {
          totalTokens: params.threadId ? 5_000 : 1_000,
          contextWindow: 400_000,
        },
      };
    };

    const run = await runHarness(config, {}, undefined, {
      runner,
      github: fakeGitHub(state, { withReview: true }),
      wait: async () => {},
      now: () => 0,
      provenance,
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
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.baselines.greptile.sha).toBe("sha-greptile");
    expect(manifest.arms.greptile.landing.status).toBe("merged");
    expect(manifest.arms.greptile.landing.reviewRounds).toHaveLength(1);

    // What the run was: which rung, which harness, what the landing phase was
    // allowed, and where the progress logs went. None of it was derivable from
    // the artifacts before.
    expect(manifest.config.subticket).toEqual({
      number: "1.1",
      milestone: 1,
      title: "Do the thing",
      ticket: "GRE-11",
    });
    expect(manifest.config.harness).toEqual({
      commit: "abc1234",
      branch: "main",
      dirty: false,
    });
    expect(manifest.config.reviewRounds).toBe(1);
    expect(manifest.config.reviewTimeoutMs).toBe(100);
    expect(manifest.config.land).toBe(true);
    expect(manifest.config.logDir).toContain("live-2026");

    // What it cost. The reviewed arm's total is its review round's cumulative
    // snapshot, not the build turn's plus the round's.
    expect(manifest.arms.greptile.tokens).toBe(5_000);
    expect(manifest.arms.control.tokens).toBe(1_000);

    // No token reaches the record, in the manifest or in config.json.
    const configJson = await readFile(
      join(run.artifactDir, "config.json"),
      "utf8",
    );
    expect(configJson).not.toContain("ghp_greptile_secret");
    expect(configJson).not.toContain("ghp_control_secret");
    expect(JSON.stringify(manifest)).not.toContain("ghp_");
    expect(JSON.parse(configJson).arms[0].ghTokenPresent).toBe(true);

    // The ladder as the arms could read it while working — it is mounted into
    // both checkouts, and the real file is rewritten in place and gitignored.
    expect(await readFile(join(run.artifactDir, "ladder.md"), "utf8")).toContain(
      "## Milestone 1: Storage",
    );

    const land = JSON.parse(
      await readFile(join(run.artifactDir, "greptile", "land.json"), "utf8"),
    );
    expect(land.pullRequest.url).toBe(urlFor("greptile"));
    expect(land.conversation).toHaveLength(1);
    expect(land.commits[0].sha).toBe("commit-greptile");

    // The patch lands beside land.json rather than inside it — a JSON-encoded
    // patch is not something anyone can close-read.
    expect(land.diff).toBeUndefined();
    expect(land.diffFile).toContain("pull-request.diff");
    expect(await readFile(land.diffFile, "utf8")).toContain("+greptile");
    expect(JSON.stringify(manifest.arms.greptile.landing)).not.toContain(
      "@@ -1 +1 @@",
    );
    // Both halves of the round: what the arm was told, and what it spent.
    expect(land.reviewRounds[0].prompt).toContain("has been reviewed");
    expect(land.reviewRounds[0].usage.totalTokens).toBe(5_000);
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
      provenance,
    });

    // A subticket's deliverable is a merged pull request, so this is a failed
    // run — the ladder must not check the box.
    expect(run.status).toBe("completed_with_failures");
    expect(state.merged).toEqual([]);
    expect(run.results.every((result) => result.status === "failed")).toBe(true);
    expect(run.results[0]?.error).toMatch(/no pull request/);
  });
});
