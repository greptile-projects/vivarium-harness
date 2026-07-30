import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmConfig, HarnessConfig } from "../src/harness/config.js";
import type { ArmGitHub, PullRequestRef, ReviewNote } from "../src/harness/github.js";
import { runHarness, type AttemptRunner } from "../src/harness/harness.js";
import type { ArmSession, StreamParams } from "../src/harness/session.js";

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
      { name: "komodo", repo: join(root, "komodo") },
      { name: "tuatara", repo: join(root, "tuatara"), reviewer: REVIEWER },
    ],
    sandbox: "workspace-write",
    resultsDir: join(root, "results"),
    codexHome: join(root, "codex"),
    maxAttempts: 1,
    idleTimeoutMs: 600_000,
    reviewTimeoutMs: 100,
    reviewPollMs: 10,
    reviewDebounceMs: 0,
    reviewRounds: 1,
    destination: {
      directory: join(root, "results", "rung-01", "run", "1.1"),
      subticket: { number: "1.1", milestone: 1, title: "Do the thing" },
    },
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
    async headSha() {
      return `head-${arm.name}`;
    },
    async diff() {
      return `diff --git a/${arm.name}.ts b/${arm.name}.ts\n`;
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
    async checkRuns() {
      return [];
    },
    async postComment() {},
    async merge() {
      state.merged.push(arm.name);
      return { merged: true, method: "merge", mergedAt: "2026-07-24T01:00:00Z" };
    },
  });
}

// A clock that moves. `reviewTimeoutMs` is 100 in these fixtures, so the first
// tick already exceeds it and an unanswered review times out instead of looping.
function advancingClock(): () => number {
  let clock = 0;
  return () => (clock += 1_000);
}

describe("runHarness landing", () => {
  it("keeps one MCP session per arm through build and review, then closes it", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };
    const calls = new Map<string, StreamParams[]>();
    const closed: string[] = [];

    const run = await runHarness(config, {}, undefined, {
      sessionFactory: async ({ arm }) => {
        calls.set(arm, []);
        return {
          async run(params) {
            calls.get(arm)!.push(params);
            return {
              isError: false,
              output: `done\n\nPR: ${urlFor(arm)}`,
              threadId: `thread-${arm}`,
              timedOut: false,
            };
          },
          async close() {
            closed.push(arm);
          },
        } satisfies ArmSession;
      },
      github: fakeGitHub(state, { withReview: true }),
      wait: async () => {},
      now: () => 0,
    });

    expect(run.status).toBe("completed");
    expect(calls.get("komodo")).toHaveLength(1);
    expect(calls.get("tuatara")).toHaveLength(2);
    expect(calls.get("tuatara")?.[1]?.threadId).toBe("thread-tuatara");
    expect(closed.sort()).toEqual(["komodo", "tuatara"]);
  });

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
    expect(state.synced.sort()).toEqual(["komodo", "tuatara"]);
    expect(state.merged.sort()).toEqual(["komodo", "tuatara"]);

    // The reviewed arm gets a second turn on the same thread; the komodo arm
    // gets exactly one.
    const tuatara = prompts.filter((p) => p.arm === "tuatara");
    const komodo = prompts.filter((p) => p.arm === "komodo");
    expect(komodo).toHaveLength(1);
    expect(tuatara).toHaveLength(2);
    expect(tuatara[1]?.threadId).toBe("thread-tuatara");
    // …and that second turn is the review round for its own pull request.
    expect(tuatara[1]?.prompt).toContain(urlFor("tuatara"));

    // One record: baselines and each arm's landing live in run.json — there is
    // no separate baselines.json or land.json to drift from it.
    const record = JSON.parse(
      await readFile(join(run.artifactDir, "run.json"), "utf8"),
    );
    expect(record.schemaVersion).toBe(4);
    expect(record.baselines.tuatara.sha).toBe("sha-tuatara");
    const landing = record.arms.tuatara.landing;
    expect(landing.status).toBe("merged");
    expect(landing.reviewRounds).toHaveLength(1);
    expect(landing.pullRequest.url).toBe(urlFor("tuatara"));
    expect(landing.conversation).toHaveLength(1);
  });

  // The status word in the live view. An arm sitting on a review it has not
  // received yet is "working" for as long as the reviewer takes, and that word
  // never distinguished it from an arm that was writing code.
  it("announces what each arm has moved on to", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };
    const phases: Array<[string, string]> = [];
    const runner: AttemptRunner = async (params) => ({
      isError: false,
      output: `done\n\nPR: ${urlFor(params.arm)}`,
      threadId: `thread-${params.arm}`,
      timedOut: false,
    });

    await runHarness(
      config,
      { onArmPhase: (arm, phase) => phases.push([arm, phase]) },
      undefined,
      {
        runner,
        github: fakeGitHub(state, { withReview: true }),
        wait: async () => {},
        now: () => 0,
      },
    );

    const tuatara = phases
      .filter(([arm]) => arm === "tuatara")
      .map(([, phase]) => phase);
    expect(tuatara).toEqual([
      "preparing",
      "building",
      "waiting for review",
      "answering review",
      "waiting on peer",
      "merging",
    ]);
    // The unreviewed arm runs no round it does not have. It reaches the merge
    // barrier as soon as it has built, and waits there for its peer's review —
    // which is most of the subticket, and used to read as "building".
    expect(
      phases.filter(([arm]) => arm === "komodo").map(([, phase]) => phase),
    ).toEqual(["preparing", "building", "waiting on peer", "merging"]);
  });

  it("holds both arms back when one of them fails to build", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };
    const phases: Array<[string, string]> = [];

    await runHarness(
      config,
      { onArmPhase: (arm, phase) => phases.push([arm, phase]) },
      undefined,
      {
        runner: async (params) =>
          params.arm === "komodo"
            ? { isError: true, output: "boom", timedOut: false }
            : {
                isError: false,
                output: `done\n\nPR: ${urlFor(params.arm)}`,
                threadId: "thread",
                timedOut: false,
              },
        github: fakeGitHub(state, { withReview: true }),
        wait: async () => {},
        now: () => 0,
      },
    );

    // Nothing merges, and the arm that was perfectly mergeable says so rather
    // than sitting on "working".
    expect(state.merged).toEqual([]);
    const heldBack = new Set(
      phases.filter(([, phase]) => phase === "held back").map(([arm]) => arm),
    );
    expect([...heldBack].sort()).toEqual(["komodo", "tuatara"]);
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

describe("runHarness environment lifecycle", () => {
  it("uses runtime sandbox names and destroys the environment after landing", async () => {
    const config = await makeConfig();
    const runtime: HarnessConfig = {
      ...config,
      arms: config.arms.map((arm) => ({
        ...arm,
        sandboxName: `runtime-${arm.name}`,
      })) as [ArmConfig, ArmConfig],
    };
    const state = { synced: [] as string[], merged: [] as string[] };
    const execPrefixes: Array<string[] | undefined> = [];
    let cleaned = 0;

    await runHarness(config, {}, undefined, {
      environment: async () => ({
        config: runtime,
        async cleanup() {
          cleaned += 1;
        },
      }),
      github: fakeGitHub(state),
      runner: async (params) => {
        execPrefixes.push(params.exec);
        return {
          isError: false,
          output: `done\n\nPR: ${urlFor(params.arm)}`,
          threadId: `thread-${params.arm}`,
          timedOut: false,
        };
      },
      now: advancingClock(),
      wait: async () => {},
    });

    expect(execPrefixes).toContainEqual([
      "sbx",
      "exec",
      "-i",
      "-w",
      "/workspace",
      "-e",
      "GH_TOKEN=proxy-managed",
      "-e",
      "GITHUB_TOKEN=proxy-managed",
      "runtime-komodo",
    ]);
    expect(execPrefixes).toContainEqual([
      "sbx",
      "exec",
      "-i",
      "-w",
      "/workspace",
      "-e",
      "GH_TOKEN=proxy-managed",
      "-e",
      "GITHUB_TOKEN=proxy-managed",
      "runtime-tuatara",
    ]);
    expect(cleaned).toBe(1);
  });

  it("destroys the environment when preparation throws", async () => {
    const config = await makeConfig();
    let cleaned = 0;

    await expect(
      runHarness(config, {}, undefined, {
        environment: async () => ({
          config,
          async cleanup() {
            cleaned += 1;
          },
        }),
        github: () => ({
          async isGitHubCheckout() {
            return true;
          },
          async syncToBaseline() {
            throw new Error("fetch failed");
          },
          async currentBranch() {
            return undefined;
          },
          async findPullRequest() {
            return undefined;
          },
          async conversation() {
            return [];
          },
          async checkRuns() {
            return [];
          },
          async postComment() {},
          async headSha() {
            return undefined;
          },
          async diff() {
            return "";
          },
          async merge() {
            return { merged: false };
          },
        }),
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(cleaned).toBe(1);
  });

  it("keeps a completed landing successful when cleanup fails", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };
    const notes: string[] = [];

    const run = await runHarness(
      config,
      { onArmNote: (_arm, note) => notes.push(note) },
      undefined,
      {
        environment: async () => ({
          config,
          async cleanup() {
            throw new Error("docker network is still busy");
          },
        }),
        github: fakeGitHub(state),
        runner: async (params) => ({
          isError: false,
          output: `done\n\nPR: ${urlFor(params.arm)}`,
          threadId: `thread-${params.arm}`,
          timedOut: false,
        }),
        now: advancingClock(),
        wait: async () => {},
      },
    );

    expect(run.status).toBe("completed");
    expect(state.merged.sort()).toEqual(["komodo", "tuatara"]);
    expect(notes).toContain(
      "ephemeral cleanup failed after the run settled: docker network is still busy",
    );
    expect(
      await readFile(join(run.artifactDir, "cleanup-error.txt"), "utf8"),
    ).toBe("docker network is still busy\n");
    const record = JSON.parse(
      await readFile(join(run.artifactDir, "run.json"), "utf8"),
    );
    expect(record.status).toBe("completed");
    expect(record.cleanupError).toBe("docker network is still busy");
  });

  it("does not retry successful work when transcript export fails", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };
    let attempts = 0;

    const run = await runHarness(config, {}, undefined, {
      environment: async () => ({
        config,
        async captureTranscript() {
          throw new Error("docker exec find failed");
        },
        async cleanup() {},
      }),
      github: fakeGitHub(state),
      runner: async (params) => {
        attempts += 1;
        return {
          isError: false,
          output: `done\n\nPR: ${urlFor(params.arm)}`,
          threadId: `thread-${params.arm}`,
          timedOut: false,
        };
      },
      now: advancingClock(),
      wait: async () => {},
    });

    expect(run.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(state.merged.sort()).toEqual(["komodo", "tuatara"]);
    expect(
      run.results.every(
        (result) =>
          result.status === "succeeded" &&
          result.transcriptStatus === "copy-failed" &&
          result.transcriptError === "docker exec find failed",
      ),
    ).toBe(true);
  });

  it("preserves the primary run error when cleanup also fails", async () => {
    const config = await makeConfig();

    await expect(
      runHarness(config, {}, undefined, {
        environment: async () => ({
          config,
          async cleanup() {
            throw new Error("cleanup failed too");
          },
        }),
        github: () => ({
          async isGitHubCheckout() {
            return true;
          },
          async syncToBaseline() {
            throw new Error("fetch failed first");
          },
          async currentBranch() {
            return undefined;
          },
          async findPullRequest() {
            return undefined;
          },
          async conversation() {
            return [];
          },
          async checkRuns() {
            return [];
          },
          async postComment() {},
          async headSha() {
            return undefined;
          },
          async diff() {
            return "";
          },
          async merge() {
            return { merged: false };
          },
        }),
      }),
    ).rejects.toThrow("fetch failed first");
  });
});

// The confound this barrier exists to kill. Landing is the only irreversible
// thing the harness does and it is per-arm, so without a gate one arm can
// permanently merge a rung the other never built — after which the two mains
// differ by a subticket and neither recovery works (re-run and the merged arm
// re-solves a solved ticket in seconds and "wins"; check the box by hand and
// the failed arm never builds that feature at all).
describe("landing barrier", () => {
  it("merges nothing when the reviewed arm cannot answer actionable review", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };
    const runner: AttemptRunner = async (params) =>
      params.arm === "tuatara" && params.threadId !== undefined
        ? Promise.reject(new Error("persistent session transport failed"))
        : {
            output: `PR: ${urlFor(params.arm)}`,
            isError: false,
            timedOut: false,
            threadId: `thread-${params.arm}`,
          };

    const run = await runHarness(config, {}, undefined, {
      runner,
      github: fakeGitHub(state, { withReview: true }),
      wait: async () => {},
      now: () => 0,
    });

    expect(state.merged).toEqual([]);
    expect(
      run.landings.find((record) => record.arm === "tuatara")?.status,
    ).toBe("review-failed");
    expect(
      run.landings
        .find((record) => record.arm === "tuatara")
        ?.reviewRounds.at(-1)?.error,
    ).toContain("transport failed");
    expect(
      run.landings.find((record) => record.arm === "komodo")?.status,
    ).toBe("blocked");
    expect(run.status).toBe("completed_with_failures");
  });

  it("merges nothing when one arm's session fails", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };

    // komodo fails outright; tuatara succeeds and reports a pull request.
    const runner: AttemptRunner = async (params: StreamParams) =>
      params.arm === "komodo"
        ? { output: "could not finish", isError: true, timedOut: false }
        : {
            output: `PR: ${urlFor("tuatara")}`,
            isError: false,
            timedOut: false,
            threadId: "t-1",
          };

    const run = await runHarness(config, {}, undefined, {
      runner,
      github: fakeGitHub(state),
      wait: async () => {},
      // Must advance: a reviewer arm polls until now() - start >= timeout.
      now: advancingClock(),
    });

    // The whole point: the healthy arm did NOT merge.
    expect(state.merged).toEqual([]);
    expect(run.status).toBe("completed_with_failures");

    const tuatara = run.landings.find((record) => record.arm === "tuatara");
    const komodo = run.landings.find((record) => record.arm === "komodo");
    expect(tuatara?.status).toBe("blocked");
    expect(komodo?.status).toBe("not-attempted");

    // A blocked arm is a failed arm, so Greg halts and the box stays unchecked.
    expect(run.results.every((result) => result.status === "failed")).toBe(true);
  });

  it("merges nothing when one arm opens no pull request", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };

    const runner: AttemptRunner = async (params: StreamParams) => ({
      // Both sessions report success, but komodo's checkout has no PR.
      output:
        params.arm === "komodo" ? "all done!" : `PR: ${urlFor("tuatara")}`,
      isError: false,
      timedOut: false,
      threadId: `t-${params.arm}`,
    });

    const run = await runHarness(config, {}, undefined, {
      runner,
      github: (arm: ArmConfig) =>
        fakeGitHub(state, { pullRequest: arm.name !== "komodo" })(arm),
      wait: async () => {},
      // Must advance: a reviewer arm polls until now() - start >= timeout.
      now: advancingClock(),
    });

    expect(state.merged).toEqual([]);
    expect(
      run.landings.find((record) => record.arm === "komodo")?.status,
    ).toBe("no-pull-request");
    expect(
      run.landings.find((record) => record.arm === "tuatara")?.status,
    ).toBe("blocked");
    expect(run.status).toBe("completed_with_failures");
  });

  it("merges both arms when both are ready", async () => {
    const config = await makeConfig();
    const state = { synced: [] as string[], merged: [] as string[] };

    const runner: AttemptRunner = async (params: StreamParams) => ({
      output: `PR: ${urlFor(params.arm)}`,
      isError: false,
      timedOut: false,
      threadId: `t-${params.arm}`,
    });

    const run = await runHarness(config, {}, undefined, {
      runner,
      github: fakeGitHub(state),
      wait: async () => {},
      // Must advance: a reviewer arm polls until now() - start >= timeout.
      now: advancingClock(),
    });

    expect(state.merged.sort()).toEqual(["komodo", "tuatara"]);
    expect(run.status).toBe("completed");
    expect(
      run.landings.every((record) => record.status === "merged"),
    ).toBe(true);
  });
});
