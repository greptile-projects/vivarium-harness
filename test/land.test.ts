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
  asksSomething,
  landArm,
  landingError,
  landingSummary,
  prepareArm,
} from "../src/harness/land.js";
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
  containerImage: "vivarium-arm",
  maxAttempts: 3,
  idleTimeoutMs: 600_000,
  land: true,
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
    async commits() {
      calls.push("commits");
      return [{ sha: "commit-1", message: "the work" }];
    },
    async diff() {
      calls.push("diff");
      return "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
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
    const baseline = await prepareArm(komodo, config, {
      github,
      note: () => {},
    });

    expect(github.calls).toEqual(["sync"]);
    expect(baseline?.sha).toBe("abc1234def");
  });

  it("skips anything that is not a GitHub checkout", async () => {
    const github = fakeGitHub({ isCheckout: false });
    const baseline = await prepareArm(komodo, config, {
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

    // The work itself is captured, and captured *before* the merge: the merge
    // deletes the head ref, so asking afterwards is asking about a branch that
    // is gone.
    expect(record.diff).toContain("+new");
    expect(record.commits?.[0]?.sha).toBe("commit-1");
    const order = github.calls.filter((call) =>
      ["commits", "diff", "merge"].includes(call),
    );
    expect(order).toEqual(["commits", "diff", "merge"]);
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
    expect(prompts[0]).toContain("gh pr view");
    expect(prompts[0]).toContain("pulls/{number}/comments");

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

  it("lands nothing for a failed session, or when landing is off", async () => {
    const github = fakeGitHub({});
    const failed = await landArm(
      komodo,
      config,
      { status: "failed", output: undefined },
      deps(github, answer),
    );
    expect(failed.status).toBe("not-attempted");

    const landingOff = await landArm(
      komodo,
      { ...config, land: false },
      succeeded(`PR: ${pr.url}`),
      deps(github, answer),
    );
    expect(landingOff.status).toBe("skipped");
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
    // Which is what every "answered" counter reads.
    expect(landingSummary(record)).toContain("0/1 answered");
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
    // times out with nothing new, so the summary reads 1/2 — the point is that
    // a real answer still counts.)
    expect(
      record.reviewRounds.filter((round) => round.response !== undefined),
    ).toHaveLength(1);
    expect(landingSummary(record)).toContain("1/2 answered");
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
        // Round three: nothing new from the reviewer, so it times out.
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
    // Comment shape, not round number, determines the obligation.
    expect(prompts[0]).toContain("must address every substantive new root comment");
    expect(prompts[1]).toContain("must address every substantive new root comment");
    expect(prompts[1]).toContain("Replying to that follow-up is your choice");
    expect(prompts[1]).toContain("round 2 of at most 3");
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

  // The thumbs-up end of it. Sending the arm back to reply to "LGTM" would
  // spend a round producing an acknowledgement of an acknowledgement.
  it("stops without another round when the reviewer signs off", async () => {
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

    // One round answered, and the sign-off recorded as its own round rather
    // than looking like a round the arm ignored.
    expect(prompts).toHaveLength(1);
    expect(record.reviewRounds).toHaveLength(2);
    expect(record.reviewRounds[1]?.signedOff).toBe(true);
    expect(record.reviewRounds[1]?.timedOut).toBe(false);
    expect(record.reviewRounds[1]?.found.map((entry) => entry.id)).toEqual([
      "c3",
    ]);
    expect(record.status).toBe("merged");
    expect(landingSummary(record)).toContain("signed off");
  });

  it("treats a reviewer reaction to the arm's reply as a sign-off", async () => {
    const reaction: ReviewNote = {
      id: "reaction:review-comment:90",
      kind: "reaction",
      author: REVIEWER,
      body: "+1",
      createdAt: "2026-07-24T00:02:00Z",
      inReplyTo: "review-comment:c2",
    };
    const root = note(REVIEWER, "c1", "this leaks the connection");
    const thread = [root, armReply("c2", "fixed in 3f21a"), reaction];
    const github = fakeGitHub({
      // The repeated final snapshot is the confirmation poll.
      conversations: [[], [root], thread, thread],
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

  // An approving review body can become visible just before the substantive
  // inline comments submitted with it. The quiet-period debounce must collect
  // both before deciding whether the batch is a sign-off.
  it("does not let an early sign-off hide comments still landing", async () => {
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
        [
          note(REVIEWER, "c1", "this leaks the connection"),
          armReply("c2", "fixed in 3f21a"),
          note(
            REVIEWER,
            "c3",
            "I still read this as double-closing the socket when the early return fires",
          ),
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

describe("telling an acknowledgement from a comment", () => {
  const body = (text: string): ReviewNote => note(REVIEWER, "c1", text);

  it("dismisses only what asks the arm for nothing", () => {
    expect(asksSomething(body(""))).toBe(false);
    expect(asksSomething(body("👍"))).toBe(false);
    expect(asksSomething(body("LGTM"))).toBe(false);
    expect(asksSomething(body("No further comments — approving."))).toBe(false);
    expect(asksSomething(body("All comments addressed, thanks!"))).toBe(false);
    expect(
      asksSomething({
        ...body("+1"),
        id: "reaction:review-comment:90",
        kind: "reaction",
        author: REVIEWER,
        inReplyTo: "review-comment:10",
      }),
    ).toBe(false);
  });

  // The asymmetry that decides the classifier: a comment mistaken for an
  // acknowledgement never reaches the arm at all, while an acknowledgement
  // mistaken for a comment costs one bounded round. So anything in doubt is a
  // comment.
  it("keeps anything that might be asking for something", () => {
    expect(asksSomething(body("rename this to fooBar"))).toBe(true);
    expect(asksSomething(body("this comment is wrong"))).toBe(true);
    expect(
      asksSomething(body("```suggestion\nconst x = 1;\n```")),
    ).toBe(true);
    // Short, and every word ordinary — but not an acknowledgement.
    expect(asksSomething(body("no test covers this"))).toBe(true);
  });

});
