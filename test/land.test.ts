import { describe, expect, it } from "bun:test";
import type { ArmConfig, HarnessConfig } from "../src/harness/config.js";
import type {
  ArmGitHub,
  MergeOutcome,
  PullRequestRef,
  ReviewNote,
} from "../src/harness/github.js";
import { pullRequestUrl, slugFromRemote } from "../src/harness/github.js";
import {
  blockArm,
  landingError,
  mergeArm,
  prepareArm,
  reviewArm,
} from "../src/harness/land.js";
import { reviewPrompt } from "../src/harness/prompts.js";
import type { StreamResult } from "../src/harness/session.js";

const REVIEWER = "greptile-apps[bot]";

const komodo: ArmConfig = { name: "komodo", repo: "/tmp/komodo" };
const reviewed: ArmConfig = {
  name: "tuatara",
  repo: "/tmp/tuatara",
  reviewer: REVIEWER,
};

const config: HarnessConfig = {
  ticket: "1.1 Do the thing",
  arms: [komodo, reviewed],
  sandbox: "workspace-write",
  resultsDir: "/tmp/results",
  codexHome: "/tmp/codex",
  maxAttempts: 3,
  idleTimeoutMs: 600_000,
  reviewTimeoutMs: 300,
  reviewPollMs: 100,
  reviewDebounceMs: 0,
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
  // Successive branch heads, so a test can model an arm that pushes a fix
  // (the sha moves) or one that only argues (it does not).
  heads?: string[];
}): ArmGitHub & { calls: string[] } {
  const conversations = options.conversations ?? [[]];
  const heads = options.heads ?? [];
  let index = 0;
  let headIndex = 0;
  const calls: string[] = [];
  return {
    calls,
    async headSha() {
      calls.push("headSha");
      if (heads.length === 0) return undefined;
      const current = heads[Math.min(headIndex, heads.length - 1)]!;
      headIndex += 1;
      return current;
    },
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

// Review then merge with no barrier — what the harness does per arm once its
// peer is also ready. Composed here so each test exercises the same two
// production functions the harness calls.
const landArm = async (
  arm: ArmConfig,
  cfg: HarnessConfig,
  session: { status: "succeeded" | "failed"; output?: string },
  d: ReturnType<typeof deps>,
) => mergeArm(await reviewArm(arm, cfg, session, d), d);

describe("prepareArm", () => {
  it("resets the checkout to the shared baseline", async () => {
    const github = fakeGitHub({});
    const baseline = await prepareArm({
      github,
      note: () => {},
    });

    expect(github.calls).toEqual(["sync"]);
    expect(baseline?.sha).toBe("abc1234def");
  });

  it("skips anything that is not a GitHub checkout", async () => {
    const github = fakeGitHub({ isCheckout: false });
    const baseline = await prepareArm({
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
      komodo,
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

  it("debounces a review into one arm prompt after reviewer activity goes quiet", async () => {
    const first = note(REVIEWER, "c1", "first finding");
    const second = note(REVIEWER, "c2", "second finding");
    const github = fakeGitHub({
      conversations: [
        [],
        [first],
        [first, second],
        [first, second],
      ],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      {
        ...config,
        reviewRounds: 1,
        reviewDebounceMs: 100,
      },
      succeeded(`opened it\n\nPR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(prompts).toHaveLength(1);
    expect(record.reviewRounds[0]?.found.map((entry) => entry.id)).toEqual([
      "c1",
      "c2",
    ]);
    expect(record.reviewRounds[0]?.waitedMs).toBe(300);
  });

  // The commit the review was written against has to be pinned before the arm
  // can move the branch — an amend or force-push otherwise erases the only diff
  // that shows what the review changed, and GitHub marks the comments outdated.
  it("pins the branch head on both sides of an answered review round", async () => {
    const github = fakeGitHub({
      conversations: [
        [],
        [note(REVIEWER, "c1", "this leaks a connection")],
        [
          note(REVIEWER, "c1", "this leaks a connection"),
          note("vivarium-tuatara-bot", "c2", "fixed"),
        ],
      ],
      heads: ["sha-reviewed", "sha-after-fix"],
    });
    const record = await landArm(
      reviewed,
      config,
      succeeded(`opened it\n\nPR: ${pr.url}`),
      deps(github, async () => answer()),
    );

    const [first] = record.reviewRounds;
    expect(first?.reviewedSha).toBe("sha-reviewed");
    expect(first?.respondedSha).toBe("sha-after-fix");
    // Captured either side of the reply, never after the fact.
    const order = github.calls.filter((call) => call === "headSha");
    expect(order).toHaveLength(2);
  });

  it("records an equal pair when the arm argues but pushes nothing", async () => {
    const github = fakeGitHub({
      conversations: [
        [],
        [note(REVIEWER, "c1", "rename this")],
        [note(REVIEWER, "c1", "rename this"), note("vivarium-tuatara-bot", "c2", "disagree")],
      ],
      // The branch never moves: the arm replied and changed nothing.
      heads: ["sha-unchanged"],
    });
    const record = await landArm(
      reviewed,
      config,
      succeeded(`opened it\n\nPR: ${pr.url}`),
      deps(github, async () => answer()),
    );

    const [first] = record.reviewRounds;
    expect(first?.reviewedSha).toBe(first?.respondedSha);
  });

  // An absent sha otherwise reads exactly like a run made before these were
  // captured — and an analysis would score the gap as "the arm changed
  // nothing", which is the opposite of unknown.
  it("says so in the record when the branch head cannot be read", async () => {
    const github = fakeGitHub({
      conversations: [
        [],
        [note(REVIEWER, "c1", "fix this")],
        [note(REVIEWER, "c1", "fix this"), note("vivarium-tuatara-bot", "c2", "done")],
      ],
      // No heads configured: every lookup comes back undefined.
      heads: [],
    });
    const record = await landArm(
      reviewed,
      config,
      succeeded(`opened it\n\nPR: ${pr.url}`),
      deps(github, async () => answer()),
    );

    // The round still counts — the arm did answer, and the rung is not failed
    // over a bookkeeping read.
    expect(record.status).toBe("merged");
    expect(record.reviewRounds[0]?.response).toBe("replied to every comment");
    expect(record.reviewRounds[0]?.reviewedSha).toBeUndefined();
    expect(
      record.notes.some(
        (line) =>
          line.includes("could not read the branch head") &&
          line.includes("reviewedSha") &&
          line.includes("respondedSha"),
      ),
    ).toBe(true);
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
      komodo,
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
      komodo,
      config,
      succeeded(`PR: ${pr.url}`),
      deps(github, answer),
    );

    expect(record.status).toBe("merge-failed");
    expect(landingError(record)).toMatch(/could not be merged/);
  });

  it("lands nothing for a failed session, or a non-GitHub checkout", async () => {
    const github = fakeGitHub({});
    const failed = await landArm(
      komodo,
      config,
      { status: "failed", output: undefined },
      deps(github, answer),
    );
    expect(failed.status).toBe("not-attempted");

    const notACheckout = fakeGitHub({ isCheckout: false });
    const skipped = await landArm(
      komodo,
      config,
      succeeded(`PR: ${pr.url}`),
      deps(notACheckout, answer),
    );
    expect(skipped.status).toBe("skipped");
    expect(github.calls).toEqual([]);
    expect(notACheckout.calls).toEqual([]);
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

// The accidental run recorded `rounds: 1, answered: 1` for the reviewed arm
// while the pull request showed no reply from it at all, and its Codex
// transcript showed the review turn never ran. `response` was being set to
// `answer.output` unconditionally, so a round whose session errored on spawn
// still counted as answered — `answered` could never disagree with `rounds`.
describe("a review round that the arm failed to answer", () => {
  it("is recorded as unanswered, with the failure kept", async () => {
    const github = fakeGitHub({
      conversations: [[note(REVIEWER, "c1")]],
      heads: ["head-before", "head-after"],
    });
    const record = await landArm(
      reviewed,
      config,
      succeeded(`PR: ${pr.url}`),
      deps(github, async () => ({
        output: "session died before it could start",
        isError: true,
        timedOut: false,
      })),
    );

    expect(record.reviewRounds).toHaveLength(1);
    const [round] = record.reviewRounds;
    // The round happened — the reviewer did comment.
    expect(round.timedOut).toBe(false);
    // But the arm said nothing, and the record must not imply otherwise.
    expect(round.response).toBeUndefined();
    expect(round.error).toContain("session died");
    expect(record.status).toBe("review-failed");
    expect(github.calls).not.toContain("merge");
    expect(landingError(record)).toContain("could not answer required review");
  });

  it("converts a thrown review turn into the same fail-closed result", async () => {
    const github = fakeGitHub({
      conversations: [[note(REVIEWER, "c1")]],
      heads: ["head-before", "head-after"],
    });
    const record = await landArm(
      reviewed,
      config,
      succeeded(`PR: ${pr.url}`),
      deps(github, async () => {
        throw new Error("watchdog aborted review turn");
      }),
    );

    expect(record.status).toBe("review-failed");
    expect(record.reviewRounds.at(-1)?.response).toBeUndefined();
    expect(record.reviewRounds.at(-1)?.error).toContain("watchdog aborted");
    expect(github.calls).not.toContain("merge");
  });

  it("still counts a round the arm did answer", async () => {
    const github = fakeGitHub({
      conversations: [[note(REVIEWER, "c1")]],
      heads: ["head-before", "head-after"],
    });
    const record = await landArm(
      reviewed,
      config,
      succeeded(`PR: ${pr.url}`),
      deps(github, async () => ({
        output: "replied to both comments and pushed a fix",
        isError: false,
        timedOut: false,
      })),
    );

    expect(record.reviewRounds[0].response).toContain("pushed a fix");
    expect(record.reviewRounds[0].error).toBeUndefined();
    // Counted, unlike the errored round above. (A second round follows and
    // times out with nothing new — the point is that a real answer still
    // counts.)
    expect(
      record.reviewRounds.filter((round) => round.response !== undefined),
    ).toHaveLength(1);
  });
});

// The exchange the experiment is actually for: Greptile comments, the arm
// answers, and then Greptile answers *back* — inside the thread, holding its
// position or accepting the answer. Round two onward is where a disagreement
// plays out, so it has to reach the arm. Reviewer comments, timeout, and the
// configured round cap decide when the exchange ends.
describe("the rounds after the first", () => {
  const threeRounds = { ...config, reviewRounds: 3 };
  const armReply = (id: string, body: string) =>
    note("vivarium-tuatara-bot", id, body);

  it("hands a reviewer's reply back to the arm, on the follow-up prompt", async () => {
    const github = fakeGitHub({
      conversations: [
        [],
        [note(REVIEWER, "c1", "this leaks the connection on the error path")],
        // The post-answer read: the arm's reply is on the record, so the
        // exchange stays open and the next round waits.
        [
          note(REVIEWER, "c1", "this leaks the connection on the error path"),
          armReply("c2", "fixed in 3f21a — the finally block closes it"),
        ],
        // Greptile answers back inside the thread: the fix did not convince it.
        [
          note(REVIEWER, "c1", "this leaks the connection on the error path"),
          armReply("c2", "fixed in 3f21a — the finally block closes it"),
          {
            ...note(
              REVIEWER,
              "c3",
              "the finally block still runs after the early return above it, so the socket is closed twice",
            ),
            inReplyTo: "c1",
          },
        ],
        // Round three: the arm replied again, but nothing new arrives from
        // the reviewer, so it times out.
        [
          note(REVIEWER, "c1", "this leaks the connection on the error path"),
          armReply("c2", "fixed in 3f21a — the finally block closes it"),
          note(REVIEWER, "c3", "the finally block still runs after the early return above it, so the socket is closed twice"),
          armReply("c4", "disagree — the early return happens before the open"),
        ],
      ],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`opened it\n\nPR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(prompts).toHaveLength(2);
    // Each round gets the review prompt for *its* round, against this PR.
    expect(prompts[0]).toBe(reviewPrompt(pr.url, 1, 3));
    expect(prompts[1]).toBe(reviewPrompt(pr.url, 2, 3));
    // Still never handed the text of what it has to answer.
    expect(prompts[1]).not.toContain("closed twice");

    const [first, second, third] = record.reviewRounds;
    expect(first?.found.map((entry) => entry.id)).toEqual(["c1"]);
    // Only what is new since the last answer — not the whole thread again.
    expect(second?.found.map((entry) => entry.id)).toEqual(["c3"]);
    expect(second?.response).toBe("replied to every comment");
    expect(third?.timedOut).toBe(true);
    expect(record.status).toBe("merged");
  });

  it("does not infer sign-off from approval prose", async () => {
    const github = fakeGitHub({
      conversations: [
        [],
        [note(REVIEWER, "c1", "this leaks the connection")],
        [
          note(REVIEWER, "c1", "this leaks the connection"),
          armReply("c2", "fixed in 3f21a"),
          note(REVIEWER, "c3", "👍 LGTM — all comments addressed"),
        ],
      ],
      // The branch never moves, so no re-review pass is ever owed.
      heads: ["sha-unchanged"],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    // The prose still costs an answer turn — it is handed to the arm, never
    // classified. The arm then posts nothing back to a compliment, so the
    // exchange settles rather than being closed by the words themselves.
    expect(prompts).toHaveLength(2);
    expect(record.reviewRounds).toHaveLength(2);
    expect(record.reviewRounds[1]?.signedOff).toBeUndefined();
    expect(record.reviewRounds[1]?.response).toBe("replied to every comment");
    expect(record.reviewRounds[1]?.found.map((entry) => entry.id)).toEqual([
      "c3",
    ]);
    expect(record.reviewRounds[1]?.settled).toBe(true);
    expect(record.status).toBe("merged");
  });

  // The reviewer only ACKs a ping. A clean review gives the arm nothing to fix
  // and nothing to say, so no +1 ever arrives and the next round could only
  // end in the full timeout — the exchange must settle the moment an answer
  // leaves no trace on the pull request.
  it("settles when the answer pushes nothing and posts nothing", async () => {
    const github = fakeGitHub({
      conversations: [[note(REVIEWER, "c1", "5/5 — no issues found")]],
      // The branch never moves either.
      heads: ["sha-unchanged"],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(prompts).toHaveLength(1);
    expect(record.reviewRounds).toHaveLength(1);
    expect(record.reviewRounds[0]?.settled).toBe(true);
    expect(record.reviewRounds[0]?.timedOut).toBe(false);
    expect(record.status).toBe("merged");
  });

  it("keeps waiting when the post-answer read fails, rather than settling blind", async () => {
    const github = fakeGitHub({
      conversations: [[note(REVIEWER, "c1", "5/5 — no issues found")]],
      heads: ["sha-unchanged"],
    });
    const conversation = github.conversation.bind(github);
    let reads = 0;
    github.conversation = async (pullRequest) => {
      reads += 1;
      // The second read is the post-answer trace check.
      if (reads === 2) throw new Error("HTTP 502");
      return conversation(pullRequest);
    };
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async () => answer()),
    );

    // Unknown is not settled: a second round runs and times out instead.
    expect(record.reviewRounds).toHaveLength(2);
    expect(record.reviewRounds[0]?.settled).toBeUndefined();
    expect(record.reviewRounds[1]?.timedOut).toBe(true);
    expect(record.status).toBe("merged");
  });

  // The timeout bounds total reviewer silence, not each round afresh: round
  // two's window is measured from the comment round one found, so an answer
  // turn that already outlived the window leaves only the guaranteed final
  // poll, not a whole fresh wait.
  it("rolls the timeout window from the reviewer's last comment, not the round start", async () => {
    const github = fakeGitHub({
      conversations: [
        [],
        [note(REVIEWER, "c1", "one finding")],
        [
          note(REVIEWER, "c1", "one finding"),
          armReply("c2", "fixed in 3f21a"),
        ],
      ],
      heads: ["sha-reviewed", "sha-after-fix"],
    });
    let clock = 0;
    const record = await reviewArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      {
        github,
        // The answer turn alone outlives the 300ms window.
        reply: async () => {
          clock += 350;
          return answer();
        },
        note: () => {},
        wait: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      },
    );

    const [, second] = record.reviewRounds;
    expect(record.reviewRounds).toHaveLength(2);
    // Round two got its one poll and timed out on silence already spent.
    expect(second?.timedOut).toBe(true);
    expect(second?.waitedMs).toBe(0);
    expect(record.status).toBe("ready");
  });

  it("treats an ACK-only response to an unpushed answer as a sign-off", async () => {
    const reaction: ReviewNote = {
      id: "reaction:review-comment:90",
      kind: "reaction",
      author: REVIEWER,
      body: "+1",
      createdAt: "2026-07-24T00:02:00Z",
      inReplyTo: "review-comment:c2",
    };
    const root = note(REVIEWER, "c1", "this leaks the connection");
    const thread = [root, armReply("c2", "intended — see the doc comment"), reaction];
    const github = fakeGitHub({
      // The repeated final snapshot is the confirmation poll.
      conversations: [[], [root], thread, thread],
      // The arm argued without pushing: no re-review pass is owed, so the
      // reviewer's bare ACK is the end of the exchange.
      heads: ["sha-unchanged"],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(prompts).toHaveLength(1);
    expect(record.reviewRounds).toHaveLength(2);
    expect(record.reviewRounds[1]?.signedOff).toBe(true);
    expect(record.reviewRounds[1]?.found).toContainEqual(reaction);
  });

  // The reviewer ACKs each accepted reply while it is still replying in other
  // threads — the batch that closed PR #7 held five prose comments and two
  // thumbs-ups, and reading the thumbs-ups as a sign-off recorded it as
  // "nothing to answer". Prose beside an ACK is work.
  it("does not read ACKs beside prose as a sign-off", async () => {
    const root = note(REVIEWER, "c1", "this leaks the connection");
    const reaction: ReviewNote = {
      id: "reaction:review-comment:92",
      kind: "reaction",
      author: REVIEWER,
      body: "+1",
      createdAt: "2026-07-24T00:02:00Z",
      inReplyTo: "review-comment:c2",
    };
    const full = [
      root,
      armReply("c2", "intended — see the doc comment"),
      { ...note(REVIEWER, "c3", "your reasoning holds, though the doc comment could say so"), inReplyTo: "c1" },
      reaction,
    ];
    const github = fakeGitHub({
      conversations: [[], [root], full, full, full],
      heads: ["sha-unchanged"],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    // The reply is handed to the arm like any other prose; only the arm's
    // silence afterwards settles the exchange.
    expect(prompts).toHaveLength(2);
    expect(record.reviewRounds).toHaveLength(2);
    expect(record.reviewRounds[1]?.signedOff).toBeUndefined();
    expect(record.reviewRounds[1]?.found.map((entry) => entry.id)).toEqual([
      "c3",
      "reaction:review-comment:92",
    ]);
    expect(record.reviewRounds[1]?.settled).toBe(true);
    expect(record.status).toBe("merged");
  });

  // The regression from PR #7: the arm's pushed fix started a fresh review
  // pass, but the ACKs to its replies arrived minutes earlier and ended the
  // exchange — the pass's new P1 root finding landed forty seconds before an
  // unanswered merge. A push holds the exchange open: bare ACKs never surface
  // as a round, and the pass's findings reach the arm.
  it("holds the exchange open after a push until the re-review pass lands", async () => {
    const root = note(REVIEWER, "c1", "unbounded decompressed object size");
    const ack: ReviewNote = {
      id: "reaction:review-comment:93",
      kind: "reaction",
      author: REVIEWER,
      body: "+1",
      createdAt: "2026-07-24T00:02:00Z",
      inReplyTo: "review-comment:c2",
    };
    const acked = [root, armReply("c2", "fixed in 09beba5"), ack];
    const passFinding = note(REVIEWER, "c4", "unbounded decompressed header read");
    const github = fakeGitHub({
      conversations: [
        [],
        [root],
        // The fast responses to the answer: only the ACK is new here.
        acked,
        // The push-triggered pass arrives with a fresh root finding.
        [...acked, passFinding],
        [...acked, passFinding, armReply("c5", "capped the header read too")],
      ],
      // Round one pushes a fix; round two only replies.
      heads: ["r1-reviewed", "r1-pushed", "r2-same", "r2-same"],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(prompts).toHaveLength(2);
    expect(record.reviewRounds).toHaveLength(3);
    expect(record.reviewRounds[0]?.found.map((entry) => entry.id)).toEqual([
      "c1",
    ]);
    // The ACK-only batch never became a round of its own — the next thing the
    // arm was sent back for is the pass's finding.
    expect(record.reviewRounds[1]?.found.map((entry) => entry.id)).toEqual([
      "c4",
    ]);
    expect(record.reviewRounds.some((round) => round.signedOff)).toBe(false);
    expect(record.reviewRounds[2]?.timedOut).toBe(true);
    expect(record.status).toBe("merged");
  });

  it("observes an in-place edit to the reviewer's original summary", async () => {
    const root = note(REVIEWER, "c1", "deletion bypasses locking");
    const summary = (updatedAt: string, body: string): ReviewNote => ({
      id: "issue-comment:summary",
      kind: "issue-comment",
      author: REVIEWER,
      body,
      createdAt: "2026-07-24T00:00:01Z",
      updatedAt,
    });
    const initialSummary = summary(
      "2026-07-24T00:00:01Z",
      "one blocking finding remains",
    );
    const revisedSummary = summary(
      "2026-07-24T00:03:00Z",
      "the pushed fix is safe; no blocking finding remains",
    );
    const answered = [
      root,
      initialSummary,
      armReply("c2", "fixed the locking race"),
    ];
    const github = fakeGitHub({
      conversations: [
        [],
        [root, initialSummary],
        answered,
        [root, revisedSummary, answered[2]!],
        [root, revisedSummary, answered[2]!],
      ],
      heads: ["reviewed", "pushed", "pushed", "pushed"],
    });
    const prompts: string[] = [];

    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(prompts).toHaveLength(2);
    expect(record.reviewRounds).toHaveLength(2);
    expect(record.reviewRounds[1]?.found.map((entry) => entry.id)).toEqual([
      "issue-comment:summary",
    ]);
    expect(record.reviewRounds[1]?.settled).toBe(true);
    expect(record.status).toBe("merged");
  });

  it("ignores every reviewer reaction except thumbs-up", async () => {
    const reaction: ReviewNote = {
      id: "reaction:review-comment:91",
      kind: "reaction",
      author: REVIEWER,
      body: "heart",
      createdAt: "2026-07-24T00:02:00Z",
      inReplyTo: "review-comment:c2",
    };
    const github = fakeGitHub({ conversations: [[reaction]] });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(prompts).toEqual([]);
    expect(record.reviewRounds).toHaveLength(1);
    expect(record.reviewRounds[0]?.timedOut).toBe(true);
    expect(record.reviewRounds[0]?.found).toEqual([]);
    expect(record.reviewRounds[0]?.signedOff).toBeUndefined();
  });

  // An approval body can become visible just before substantive inline
  // comments submitted with it. Both are prose, so both go to the arm.
  it("debounces approval prose with comments still landing", async () => {
    const approval = note(REVIEWER, "c3", "LGTM");
    const finding = note(
      REVIEWER,
      "c4",
      "the close in the finally block runs twice now that the early return is gone",
    );
    const github = fakeGitHub({
      conversations: [
        [],
        [approval],
        [approval, finding],
        [approval, finding],
      ],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      { ...config, reviewRounds: 1, reviewDebounceMs: 100 },
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return answer();
      }),
    );

    expect(prompts).toHaveLength(1);
    expect(record.reviewRounds[0]?.signedOff).toBeUndefined();
    expect(record.reviewRounds[0]?.found.map((entry) => entry.id)).toEqual([
      "c3",
      "c4",
    ]);
  });

  it("does not let an arm-authored marker bypass later reviewer comments", async () => {
    const github = fakeGitHub({
      conversations: [
        [],
        [note(REVIEWER, "c1", "this leaks the connection")],
        // Post-answer read: the arm's reply keeps the exchange open.
        [
          note(REVIEWER, "c1", "this leaks the connection"),
          armReply("c2", "fixed in 3f21a"),
        ],
        [
          note(REVIEWER, "c1", "this leaks the connection"),
          armReply("c2", "fixed in 3f21a"),
          note(
            REVIEWER,
            "c3",
            "I still read this as double-closing the socket when the early return fires",
          ),
        ],
        // Post-answer read again: the arm stood its ground on the record.
        [
          note(REVIEWER, "c1", "this leaks the connection"),
          armReply("c2", "fixed in 3f21a"),
          note(
            REVIEWER,
            "c3",
            "I still read this as double-closing the socket when the early return fires",
          ),
          armReply("c4", "stood by the original design"),
        ],
        [
          note(REVIEWER, "c1", "this leaks the connection"),
          armReply("c2", "fixed in 3f21a"),
          note(
            REVIEWER,
            "c3",
            "I still read this as double-closing the socket when the early return fires",
          ),
          armReply("c4", "stood by the original design"),
          note(
            REVIEWER,
            "c5",
            "the error path in openSocket still demonstrates the double close",
          ),
        ],
      ],
    });
    const prompts: string[] = [];
    const record = await landArm(
      reviewed,
      threeRounds,
      succeeded(`PR: ${pr.url}`),
      deps(github, async (prompt) => {
        prompts.push(prompt);
        return {
          output: "stood by the original design.\n\nREVIEW: done",
          isError: false,
          timedOut: false,
        };
      }),
    );

    expect(prompts).toHaveLength(3);
    expect(record.reviewRounds).toHaveLength(3);
    expect(record.reviewRounds[2]?.found.map((entry) => entry.id)).toEqual(["c5"]);
    expect(record.reviewRounds.some((round) => round.timedOut)).toBe(false);
    expect(record.status).toBe("merged");
  });
});

// Quitting the live view aborts the controller every session runs under, but
// the review wait holds no session — it polls GitHub on a plain sleep. Without
// the signal reaching it, a quit during "waiting for review" sat out the rest
// of the review timeout (up to an hour) before teardown could run.
describe("aborting the run while waiting for review", () => {
  it("stops polling at the next tick and refuses to merge", async () => {
    const github = fakeGitHub({ conversations: [[]] });
    const controller = new AbortController();
    let clock = 0;
    let waits = 0;
    const waitSignals: (AbortSignal | undefined)[] = [];
    const record = await reviewArm(
      reviewed,
      // A timeout far beyond the fake clock: only the abort can end the wait.
      { ...config, reviewTimeoutMs: 1_000_000 },
      succeeded(`PR: ${pr.url}`),
      {
        github,
        reply: answer,
        note: () => {},
        wait: async (ms: number, signal?: AbortSignal) => {
          waitSignals.push(signal);
          clock += ms;
          waits += 1;
          if (waits === 2) controller.abort(new Error("the live view was quit"));
        },
        now: () => clock,
        signal: controller.signal,
      },
    );

    // The signal reaches the wait itself, so the production sleep can clear
    // its timer instead of leaving a pending setTimeout holding the process
    // open after teardown.
    expect(waitSignals).toEqual([controller.signal, controller.signal]);

    // The poll loop stopped on the abort, not the timeout.
    expect(waits).toBe(2);
    expect(record.status).toBe("review-failed");
    expect(record.reviewRounds).toHaveLength(1);
    expect(record.reviewRounds[0]?.timedOut).toBe(false);
    expect(record.reviewRounds[0]?.error).toContain("aborted");
    // And the fail-closed status keeps the merge barrier shut.
    const merged = await mergeArm(record, { github, note: () => {} });
    expect(merged.status).toBe("review-failed");
    expect(github.calls).not.toContain("merge");
  });
});

describe("the reviewer's two login spellings", () => {
  // `gh pr view --json reviews` (GraphQL) reports a bot without the `[bot]`
  // suffix REST keeps, and the conversation merges both sources — so a review
  // body authored by "greptile-apps" must still count as the configured
  // "greptile-apps[bot]" reviewer, or an approval-only review reads as
  // reviewer silence and the round times out.
  it("counts a GraphQL-spelled review body as reviewer activity", async () => {
    const reviewBody: ReviewNote = {
      id: "review:1",
      kind: "review",
      author: "greptile-apps",
      body: "please rename this before merging",
      createdAt: "2026-07-24T00:00:00Z",
      state: "COMMENTED",
    };
    const github = fakeGitHub({ conversations: [[reviewBody]] });
    const prompts: string[] = [];
    const record = await landArm(reviewed, config, succeeded(pr.url), deps(
      github,
      async (prompt) => {
        prompts.push(prompt);
        return answer();
      },
    ));

    expect(record.status).toBe("merged");
    expect(prompts).toHaveLength(1);
    expect(record.reviewRounds[0]?.timedOut).toBe(false);
    expect(record.reviewRounds[0]?.found.map((entry) => entry.id)).toEqual([
      "review:1",
    ]);
  });
});

describe("a conversation that cannot be read", () => {
  it("keeps polling past a failed read and still finds the review", async () => {
    const github = fakeGitHub({
      conversations: [[note(REVIEWER, "review-comment:1")]],
    });
    const conversation = github.conversation.bind(github);
    let failures = 1;
    github.conversation = async (pullRequest) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("HTTP 403: rate limit exceeded");
      }
      return conversation(pullRequest);
    };

    const record = await landArm(
      reviewed,
      config,
      succeeded(pr.url),
      deps(github, answer),
    );

    expect(record.status).toBe("merged");
    expect(record.reviewRounds[0]?.timedOut).toBe(false);
    expect(record.reviewRounds[0]?.found).toHaveLength(1);
  });

  // "The API was dark" must not be recorded as "the reviewer said nothing":
  // the two look identical in a timed-out round unless the error is kept.
  it("records an API-dark wait as a timeout with the error, not as silence", async () => {
    const github = fakeGitHub({});
    github.conversation = async () => {
      throw new Error("HTTP 403: rate limit exceeded");
    };

    const record = await landArm(
      reviewed,
      config,
      succeeded(pr.url),
      deps(github, answer),
    );

    expect(record.status).toBe("merged");
    expect(record.reviewRounds[0]?.timedOut).toBe(true);
    expect(record.reviewRounds[0]?.error).toContain("rate limit exceeded");
  });

  it("records a merge-time capture failure as a gap, never as an empty list", async () => {
    const github = fakeGitHub({});
    let attempts = 0;
    github.conversation = async () => {
      attempts += 1;
      throw new Error("HTTP 502");
    };

    const record = await landArm(komodo, config, succeeded(pr.url), deps(
      github,
      answer,
    ));

    expect(record.status).toBe("merged");
    expect(record.conversation).toEqual([]);
    expect(
      record.notes.some((entry) => entry.includes("conversation unavailable")),
    ).toBe(true);
    // Retried before giving up.
    expect(attempts).toBe(3);
  });

  it("retries the merge-time capture and keeps a late answer", async () => {
    const github = fakeGitHub({
      conversations: [[note(REVIEWER, "review-comment:9")]],
    });
    const conversation = github.conversation.bind(github);
    let failures = 2;
    github.conversation = async (pullRequest) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("HTTP 502");
      }
      return conversation(pullRequest);
    };

    const record = await mergeArm(
      {
        arm: "komodo",
        status: "ready",
        startedAt: "2026-07-24T00:00:00Z",
        completedAt: "2026-07-24T00:00:00Z",
        pullRequest: pr,
        reviewRounds: [],
        conversation: [],
        notes: [],
      },
      deps(github, answer),
    );

    expect(record.status).toBe("merged");
    expect(record.conversation).toHaveLength(1);
  });

  it("records a blocked arm's capture failure as a gap too", async () => {
    const github = fakeGitHub({});
    github.conversation = async () => {
      throw new Error("HTTP 502");
    };

    const record = await blockArm(
      {
        arm: "komodo",
        status: "ready",
        startedAt: "2026-07-24T00:00:00Z",
        completedAt: "2026-07-24T00:00:00Z",
        pullRequest: pr,
        reviewRounds: [],
        conversation: [],
        notes: [],
      },
      "tuatara is merge-failed",
      deps(github, answer),
    );

    expect(record.status).toBe("blocked");
    expect(record.conversation).toEqual([]);
    expect(
      record.notes.some((entry) => entry.includes("conversation unavailable")),
    ).toBe(true);
  });
});
