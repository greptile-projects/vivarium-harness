import { describe, expect, it } from "bun:test";
import type { ArmConfig, HarnessConfig } from "../src/config.js";
import type {
  ArmGitHub,
  MergeOutcome,
  PullRequestRef,
  ReviewNote,
} from "../src/github.js";
import { pullRequestUrl, slugFromRemote } from "../src/github.js";
import { landArm, landingError, prepareArm } from "../src/land.js";
import type { StreamResult } from "../src/live/stream.js";

const REVIEWER = "greptile-apps[bot]";

const control: ArmConfig = { name: "control", repo: "/tmp/control" };
const reviewed: ArmConfig = {
  name: "greptile",
  repo: "/tmp/greptile",
  reviewer: REVIEWER,
};

const config: HarnessConfig = {
  ticket: "1.1 Do the thing",
  arms: [control, reviewed],
  sandbox: "workspace-write",
  resultsDir: "/tmp/results",
  codexHome: "/tmp/codex",
  maxAttempts: 3,
  idleTimeoutMs: 600_000,
  land: true,
  reviewTimeoutMs: 300,
  reviewPollMs: 100,
  reviewRounds: 2,
};

const pr: PullRequestRef = {
  number: 7,
  url: "https://github.com/greptile-projects/vivarium-tuatara/pull/7",
  title: "1.1 Do the thing",
  headRefName: "subticket-1-1",
  state: "OPEN",
};

function note(author: string, id: string, body = "fix this"): ReviewNote {
  return {
    id,
    kind: "review-comment",
    author,
    body,
    createdAt: "2026-07-24T00:00:00Z",
  };
}

// A GitHub side that answers from a script instead of the network. `rounds` is
// what conversation() returns on successive calls, so a test can say "nothing,
// nothing, then the review arrives".
function fakeGitHub(options: {
  conversations?: ReviewNote[][];
  pullRequest?: PullRequestRef | undefined;
  merge?: MergeOutcome;
  isCheckout?: boolean;
  branch?: string;
}): ArmGitHub & { calls: string[] } {
  const conversations = options.conversations ?? [[]];
  let index = 0;
  const calls: string[] = [];
  return {
    calls,
    async isGitHubCheckout() {
      return options.isCheckout ?? true;
    },
    async syncToBaseline() {
      calls.push("sync");
      return { slug: "org/repo", branch: "main", sha: "abc1234def" };
    },
    async currentBranch() {
      return options.branch ?? "subticket-1-1";
    },
    async findPullRequest() {
      return "pullRequest" in options ? options.pullRequest : pr;
    },
    async conversation() {
      calls.push("conversation");
      const current = conversations[Math.min(index, conversations.length - 1)]!;
      index += 1;
      return current;
    },
    async merge() {
      calls.push("merge");
      return options.merge ?? { merged: true, method: "merge" };
    },
  };
}

function deps(
  github: ArmGitHub,
  reply: (prompt: string) => Promise<StreamResult>,
) {
  let clock = 0;
  return {
    github,
    reply,
    note: () => {},
    // The fake clock advances only when the landing phase waits, so a poll
    // loop cannot spin forever in a test.
    wait: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const succeeded = (output: string) =>
  ({ status: "succeeded", output }) as const;

const answer = async (): Promise<StreamResult> => ({
  output: "replied to every comment",
  isError: false,
  timedOut: false,
});

describe("prepareArm", () => {
  it("resets the checkout to the shared baseline", async () => {
    const github = fakeGitHub({});
    const baseline = await prepareArm(control, config, {
      github,
      note: () => {},
    });

    expect(github.calls).toEqual(["sync"]);
    expect(baseline?.sha).toBe("abc1234def");
  });

  it("skips anything that is not a GitHub checkout", async () => {
    const github = fakeGitHub({ isCheckout: false });
    const baseline = await prepareArm(control, config, {
      github,
      note: () => {},
    });

    expect(baseline).toBeUndefined();
    expect(github.calls).toEqual([]);
  });
});

describe("landArm", () => {
  it("merges an unreviewed arm's pull request straight away", async () => {
    const github = fakeGitHub({});
    const prompts: string[] = [];
    const record = await landArm(
      control,
      config,
      succeeded(`done\n\nPR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(record.status).toBe("merged");
    expect(record.pullRequest?.number).toBe(7);
    // No reviewer, so the arm is never sent back to answer anything.
    expect(prompts).toEqual([]);
    expect(record.reviewRounds).toEqual([]);
    expect(landingError(record)).toBeUndefined();
  });

  it("sends the reviewed arm back to answer, without handing it the comments", async () => {
    const github = fakeGitHub({
      conversations: [
        [],
        [note(REVIEWER, "c1", "this leaks a connection")],
        // Round 2: only the arm's own reply is new, so the round times out.
        [
          note(REVIEWER, "c1", "this leaks a connection"),
          note("vivarium-tuatara-bot", "c2", "fixed, see 3f21a"),
        ],
      ],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      config,
      succeeded(`opened it\n\nPR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(record.status).toBe("merged");
    expect(prompts).toHaveLength(1);
    // The whole point: the arm is told where its review is, not what it says.
    expect(prompts[0]).toContain(pr.url);
    expect(prompts[0]).not.toContain("this leaks a connection");
    expect(prompts[0]).toContain("fetch it yourself");

    const [first, second] = record.reviewRounds;
    expect(first?.found.map((entry) => entry.id)).toEqual(["c1"]);
    expect(first?.response).toBe("replied to every comment");
    // The second round waited for a *new* reviewer comment and got none.
    expect(second?.timedOut).toBe(true);
    // Both sides of the conversation are kept for the record.
    expect(record.conversation.map((entry) => entry.author)).toContain(
      "vivarium-tuatara-bot",
    );
  });

  it("merges unreviewed when the review never arrives", async () => {
    const github = fakeGitHub({ conversations: [[]] });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      config,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(record.status).toBe("merged");
    expect(prompts).toEqual([]);
    expect(record.reviewRounds).toHaveLength(1);
    expect(record.reviewRounds[0]?.timedOut).toBe(true);
    expect(github.calls).toContain("merge");
  });

  it("fails the arm when the session opened no pull request", async () => {
    const github = fakeGitHub({ pullRequest: undefined });
    const record = await landArm(
      control,
      config,
      succeeded("I decided a pull request was unnecessary"),
      deps(github, answer),
    );

    expect(record.status).toBe("no-pull-request");
    expect(github.calls).not.toContain("merge");
    expect(landingError(record)).toMatch(/no pull request/);
  });

  it("fails the arm when the merge does not go through", async () => {
    const github = fakeGitHub({
      merge: { merged: false, error: "not mergeable" },
    });
    const record = await landArm(
      control,
      config,
      succeeded(`PR: ${pr.url}`),
      deps(github, answer),
    );

    expect(record.status).toBe("merge-failed");
    expect(landingError(record)).toMatch(/could not be merged/);
  });

  it("lands nothing for a failed session, or when landing is off", async () => {
    const github = fakeGitHub({});
    const failed = await landArm(
      control,
      config,
      { status: "failed", output: undefined },
      deps(github, answer),
    );
    expect(failed.status).toBe("not-attempted");

    const demo = await landArm(
      control,
      { ...config, land: false },
      succeeded(`PR: ${pr.url}`),
      deps(github, answer),
    );
    expect(demo.status).toBe("skipped");
    expect(github.calls).toEqual([]);
  });
});

describe("reading the pull request out of the arm's answer", () => {
  it("takes the last GitHub pull request URL it finds", () => {
    expect(
      pullRequestUrl(
        "I looked at https://github.com/org/repo/pull/1 for reference.\n\nPR: https://github.com/org/repo/pull/9",
      ),
    ).toBe("https://github.com/org/repo/pull/9");
    expect(pullRequestUrl("no link here")).toBeUndefined();
    expect(pullRequestUrl(undefined)).toBeUndefined();
  });

  it("reads owner/name from either remote form", () => {
    expect(slugFromRemote("https://github.com/org/repo.git")).toBe("org/repo");
    expect(slugFromRemote("git@github.com:org/repo.git")).toBe("org/repo");
    expect(slugFromRemote("/local/path")).toBeUndefined();
  });
});
