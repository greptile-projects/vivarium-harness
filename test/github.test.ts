import { describe, expect, test } from "bun:test";
import {
  GIT_TOKEN_ENV,
  armGitHub,
  pullRequestNumber,
  pullRequestUrl,
  slugFromRemote,
  threadFlagsFrom,
} from "../src/harness/github.js";
import type { ArmConfig } from "../src/harness/config.js";
import type { CommandResult, CommandRunner } from "../src/harness/github.js";

const TOKEN = "ghp_thisisthesecretvalue";

const arm = (overrides: Partial<ArmConfig> = {}): ArmConfig => ({
  name: "tuatara",
  repo: "/tmp/checkout",
  ...overrides,
});

// Records every spawn so a test can assert on argv and env — nothing here runs
// git or gh.
function recorder(replies: Record<string, CommandResult> = {}) {
  const calls: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }[] = [];
  const exec: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    // Flags and the `-c credential.helper=…` payload are dropped so a key stays
    // "git ls-remote origin …" whether or not the arm has a token.
    const key = `${command} ${args
      .filter((a) => !a.startsWith("-") && !a.startsWith("credential.helper="))
      .join(" ")}`;
    for (const [match, reply] of Object.entries(replies)) {
      if (key.startsWith(match)) return reply;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

describe("credential handling", () => {
  // The point of the credential helper is that the token reaches git without
  // ever being readable off the process table — `-c` values are argv, and argv
  // is world-readable through `ps` while the fetch runs.
  test("no spawned argument ever contains the token", async () => {
    const { calls, exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "git symbolic-ref": ok("origin/main\n"),
      "git rev-parse": ok("abc123\n"),
    });

    await armGitHub(arm({ ghToken: TOKEN }), exec).syncToBaseline();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      for (const argument of call.args) {
        expect(argument).not.toContain(TOKEN);
      }
    }
  });

  test("the token reaches git through the environment instead", async () => {
    const { calls, exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "git symbolic-ref": ok("origin/main\n"),
      "git rev-parse": ok("abc123\n"),
    });

    await armGitHub(arm({ ghToken: TOKEN }), exec).syncToBaseline();

    const fetch = calls.find((call) => call.args.includes("fetch"));
    expect(fetch?.env?.[GIT_TOKEN_ENV]).toBe(TOKEN);
    // …and the helper is still installed, referring to it by name.
    const helper = fetch?.args.find((a) => a.startsWith("credential.helper="));
    expect(helper).toContain(`$${GIT_TOKEN_ENV}`);
    expect(helper).not.toContain(TOKEN);
  });

  test("an arm with no token installs no helper and sets no token env", async () => {
    const { calls, exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "git symbolic-ref": ok("origin/main\n"),
      "git rev-parse": ok("abc123\n"),
    });

    await armGitHub(arm(), exec).syncToBaseline();

    const fetch = calls.find((call) => call.args.includes("fetch"));
    expect(fetch?.args.some((a) => a.startsWith("credential.helper="))).toBe(
      false,
    );
    expect(fetch?.env?.[GIT_TOKEN_ENV]).toBeUndefined();
  });
});

describe("syncToBaseline", () => {
  test("resets tracked files with checkout -f -B", async () => {
    const { calls, exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "git symbolic-ref": ok("origin/trunk\n"),
      "git rev-parse": ok("deadbeef\n"),
    });

    const baseline = await armGitHub(arm(), exec).syncToBaseline();

    expect(baseline).toEqual({
      slug: "org/repo",
      branch: "trunk",
      sha: "deadbeef",
    });
    const checkout = calls.find((call) => call.args[0] === "checkout");
    expect(checkout?.args).toEqual([
      "checkout",
      "-f",
      "-B",
      "trunk",
      "origin/trunk",
    ]);
  });

  test("clears untracked leftovers, but not node_modules or the ladder", async () => {
    const { calls, exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "git symbolic-ref": ok("origin/trunk\n"),
      "git rev-parse": ok("deadbeef\n"),
    });

    await armGitHub(arm(), exec).syncToBaseline();

    // A scratch file one arm left behind would otherwise ride into the next
    // subticket while the other arm started clean.
    const clean = calls.find((call) => call.args[0] === "clean");
    expect(clean?.args).toEqual([
      "clean",
      "-fdx",
      "-e",
      "node_modules",
      "-e",
      "LADDER.md",
    ]);
    // -x takes ignored files too — build output, caches, coverage. The reviewed
    // arm does strictly more work per rung (it re-runs its checks after
    // answering a review), so without this it can start the next subticket with
    // warm caches the other arm lacks: state persisting for one arm and not the
    // other. The two excludes still protect the only things -x must not take.
    expect(clean?.args).toContain("-e");
    expect(clean?.args).toContain("node_modules");
    expect(clean?.args).toContain("LADDER.md");
    // …and it runs after the checkout, so it only sees what checkout left.
    const order = calls.map((call) => call.args[0]);
    expect(order.indexOf("clean")).toBeGreaterThan(order.indexOf("checkout"));
  });

  test("a failed clean throws rather than starting the arms asymmetrically", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "git symbolic-ref": ok("origin/main\n"),
      "git rev-parse": ok("abc123\n"),
      "git clean": { code: 1, stdout: "", stderr: "permission denied" },
    });

    await expect(armGitHub(arm(), exec).syncToBaseline()).rejects.toThrow(
      /permission denied/,
    );
  });

  test("a failed fetch throws rather than silently building on a stale base", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "git symbolic-ref": ok("origin/main\n"),
      "git fetch": { code: 128, stdout: "", stderr: "could not read from remote" },
    });

    await expect(armGitHub(arm(), exec).syncToBaseline()).rejects.toThrow(
      /could not read from remote/,
    );
  });
});

describe("conversation", () => {
  // `gh api --paginate` merges array responses into a single JSON array, so a
  // review long enough to paginate still parses as one document. This pins
  // that expectation: the inline comments must survive.
  test("reads every inline comment out of one merged array", async () => {
    const page = (id: number) => ({
      id,
      user: { login: "greptile-apps[bot]" },
      body: `finding ${id}`,
      created_at: `2026-07-25T0${id}:00:00Z`,
      html_url: `https://github.com/org/repo/pull/7#discussion_r${id}`,
      path: "src/github.ts",
    });
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [], comments: [] })),
      "gh api repos/org/repo/pulls/7/comments": ok(
        JSON.stringify([page(1), page(2), page(3)]),
      ),
    });

    const notes = await armGitHub(arm(), exec).conversation(7);

    expect(notes.map((note) => note.body)).toEqual([
      "finding 1",
      "finding 2",
      "finding 3",
    ]);
    expect(notes.every((note) => note.kind === "review-comment")).toBe(true);
  });

  test("merges reviews, issue comments and inline comments chronologically", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(
        JSON.stringify({
          reviews: [
            {
              id: 1,
              author: { login: "greptile-apps[bot]" },
              body: "the review",
              submittedAt: "2026-07-25T02:00:00Z",
              state: "COMMENTED",
            },
          ],
        }),
      ),
      "gh api repos/org/repo/issues/7/comments": ok(
        JSON.stringify([
          {
            id: 2,
            user: { login: "makors" },
            body: "the issue comment",
            created_at: "2026-07-25T01:00:00Z",
          },
        ]),
      ),
      "gh api repos/org/repo/pulls/7/comments": ok(
        JSON.stringify([
          {
            id: 3,
            user: { login: "greptile-apps[bot]" },
            body: "the inline comment",
            created_at: "2026-07-25T03:00:00Z",
          },
        ]),
      ),
    });

    const notes = await armGitHub(arm(), exec).conversation(7);

    expect(notes.map((note) => note.body)).toEqual([
      "the issue comment",
      "the review",
      "the inline comment",
    ]);
  });

  test("an inline reply keeps its parent link", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [], comments: [] })),
      "gh api repos/org/repo/pulls/7/comments": ok(
        JSON.stringify([
          { id: 10, body: "finding", created_at: "2026-07-25T01:00:00Z" },
          {
            id: 11,
            body: "answer",
            created_at: "2026-07-25T02:00:00Z",
            in_reply_to_id: 10,
          },
        ]),
      ),
    });

    const notes = await armGitHub(arm(), exec).conversation(7);

    expect(notes[0]?.inReplyTo).toBeUndefined();
    expect(notes[1]?.inReplyTo).toBe("review-comment:10");
  });

  test("records reviewer reactions without querying comments that have none", async () => {
    const { exec, calls } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [] })),
      "gh api repos/org/repo/issues/7/comments": ok("[]"),
      "gh api repos/org/repo/pulls/7/comments": ok(
        JSON.stringify([
          {
            id: 10,
            user: { login: "vivarium-tuatara-bot" },
            body: "@greptileai fixed",
            created_at: "2026-07-25T01:00:00Z",
            reactions: { total_count: 1 },
          },
          {
            id: 11,
            user: { login: "vivarium-tuatara-bot" },
            body: "no reaction here",
            created_at: "2026-07-25T01:01:00Z",
            reactions: { total_count: 0 },
          },
        ]),
      ),
      "gh api repos/org/repo/pulls/comments/10/reactions": ok(
        JSON.stringify([
          {
            id: 90,
            user: { login: "greptile-apps[bot]" },
            content: "+1",
            created_at: "2026-07-25T01:02:00Z",
          },
        ]),
      ),
    });

    const notes = await armGitHub(arm(), exec).conversation(7);
    const reaction = notes.find((entry) => entry.kind === "reaction");

    expect(reaction).toMatchObject({
      id: "reaction:review-comment:90",
      author: "greptile-apps[bot]",
      body: "+1",
      inReplyTo: "review-comment:10",
    });
    const reactionCalls = calls.filter((call) =>
      call.args.some((argument) => argument.endsWith("/reactions")),
    );
    expect(reactionCalls).toHaveLength(1);
    expect(reactionCalls[0]?.args).toContain(
      "repos/org/repo/pulls/comments/10/reactions",
    );
  });

  // Once the arm pushes a fix, GitHub marks the comment outdated and nulls
  // `line`. `original_line` and the hunk are then the only record of what was
  // being complained about — and without them "which code did this finding refer
  // to" is answerable only by another API call against a repo that has to still
  // exist.
  test("keeps what an inline comment pointed at, outdated or not", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [], comments: [] })),
      "gh api repos/org/repo/pulls/7/comments": ok(
        JSON.stringify([
          {
            id: 20,
            body: "this leaks the token",
            created_at: "2026-07-25T01:00:00Z",
            path: "src/github.ts",
            line: null,
            original_line: 167,
            diff_hunk: "@@ -160,7 +160,7 @@\n-  echo password=$TOKEN",
          },
        ]),
      ),
    });

    const [note] = await armGitHub(arm(), exec).conversation(7);

    expect(note?.path).toBe("src/github.ts");
    expect(note?.line).toBeUndefined();
    expect(note?.originalLine).toBe(167);
    expect(note?.diffHunk).toContain("echo password=$TOKEN");
  });

  // "Rejected suggestions" is one of the brief's named outcomes, and no amount of
  // reading the bodies settles it: resolution lives only in GraphQL.
  test("marks each inline comment's thread resolved or not", async () => {
    const { exec, calls } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [], comments: [] })),
      "gh api repos/org/repo/pulls/7/comments": ok(
        JSON.stringify([
          { id: 30, body: "fixed this one", created_at: "2026-07-25T01:00:00Z" },
          { id: 31, body: "argued with this", created_at: "2026-07-25T02:00:00Z" },
        ]),
      ),
      "gh api graphql": ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: true,
                      isOutdated: true,
                      comments: { nodes: [{ databaseId: 30 }] },
                    },
                    {
                      isResolved: false,
                      isOutdated: false,
                      comments: { nodes: [{ databaseId: 31 }] },
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    });

    const notes = await armGitHub(arm(), exec).conversation(7);

    expect(notes[0]?.resolved).toBe(true);
    expect(notes[0]?.outdated).toBe(true);
    expect(notes[1]?.resolved).toBe(false);
    // The query is asked against the slug parsed from origin, not a guess.
    const graphql = calls.find((call) => call.args.includes("graphql"));
    expect(graphql?.args).toContain("owner=org");
    expect(graphql?.args).toContain("number=7");
  });

  // A failed query must leave the fields absent, because `resolved: false` is a
  // claim ("the arm did not resolve it") and undefined is the truth ("we do not
  // know").
  test("leaves resolution unknown when the query fails", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [], comments: [] })),
      "gh api repos/org/repo/pulls/7/comments": ok(
        JSON.stringify([
          { id: 40, body: "finding", created_at: "2026-07-25T01:00:00Z" },
        ]),
      ),
      "gh api graphql": { code: 1, stdout: "", stderr: "rate limited" },
    });

    const [note] = await armGitHub(arm(), exec).conversation(7);

    expect(note?.resolved).toBeUndefined();
    expect(note?.outdated).toBeUndefined();
  });
});

describe("threadFlagsFrom", () => {
  test("keys every comment in a thread to that thread's flags", () => {
    const flags = threadFlagsFrom(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    isResolved: true,
                    isOutdated: false,
                    // A finding and the arm's reply share one thread, so both
                    // carry its resolution.
                    comments: {
                      nodes: [{ databaseId: 1 }, { databaseId: 2 }],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    expect(flags.get("review-comment:1")).toEqual({
      resolved: true,
      outdated: false,
    });
    expect(flags.get("review-comment:2")?.resolved).toBe(true);
  });

  test("is empty rather than throwing on anything unexpected", () => {
    expect(threadFlagsFrom("").size).toBe(0);
    expect(threadFlagsFrom("not json").size).toBe(0);
    expect(threadFlagsFrom(JSON.stringify({ data: {} })).size).toBe(0);
  });
});

describe("the pull request itself", () => {
  // The record has to stand on its own: a repository can be renamed, made
  // private, or have its branch force-pushed over.
  test("captures the description the arm wrote", async () => {
    const { exec } = recorder({
      "gh pr view 7": ok(
        JSON.stringify({
          number: 7,
          url: "https://github.com/org/repo/pull/7",
          title: "1.1 Do the thing",
          headRefName: "subticket-1-1",
          baseRefName: "main",
          body: "## Original Ticket\n\nBuild the storage layer.",
          state: "OPEN",
        }),
      ),
    });

    const ref = await armGitHub(arm(), exec).findPullRequest({
      url: "https://github.com/org/repo/pull/7",
    });

    expect(ref?.body).toContain("## Original Ticket");
    expect(ref?.baseRefName).toBe("main");
  });

  test("captures the diff and the commits behind it", async () => {
    const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const { exec } = recorder({
      "gh pr diff 7": ok(patch),
      "gh pr view 7": ok(
        JSON.stringify({
          commits: [
            {
              oid: "aaa111",
              messageHeadline: "add storage",
              messageBody: "with tests",
              committedDate: "2026-07-25T01:00:00Z",
              authors: [{ login: "vivarium-komodo" }],
            },
          ],
        }),
      ),
    });
    const github = armGitHub(arm(), exec);

    expect(await github.diff(7)).toBe(patch);
    expect(await github.commits(7)).toEqual([
      {
        sha: "aaa111",
        message: "add storage\n\nwith tests",
        authors: ["vivarium-komodo"],
        committedAt: "2026-07-25T01:00:00Z",
      },
    ]);
  });

  test("an empty or failed diff is undefined, not an empty patch", async () => {
    const { exec } = recorder({ "gh pr diff 7": { code: 1, stdout: "", stderr: "no" } });
    expect(await armGitHub(arm(), exec).diff(7)).toBeUndefined();
  });
});

describe("headSha", () => {
  test("reads the head off the pull request", async () => {
    const { exec, calls } = recorder({
      "gh pr view 7": ok(JSON.stringify({ headRefOid: "a".repeat(40) })),
    });

    expect(await armGitHub(arm(), exec).headSha(7, "subticket-1-1")).toBe(
      "a".repeat(40),
    );
    // No fallback needed, so the remote is not consulted at all.
    expect(calls.some((call) => call.args.includes("ls-remote"))).toBe(false);
  });

  // The API and the git remote publish the same fact over two protocols with
  // two quotas — a rate limit or a 5xx on one says nothing about the other, and
  // this sha cannot be re-read once the arm pushes over it.
  test("falls back to the git remote when the API will not answer", async () => {
    const { exec, calls } = recorder({
      "gh pr view 7": { code: 1, stdout: "", stderr: "HTTP 503" },
      "git ls-remote origin": ok(
        `${"b".repeat(40)}\trefs/heads/subticket-1-1\n`,
      ),
    });

    expect(await armGitHub(arm({ ghToken: TOKEN }), exec).headSha(7, "subticket-1-1")).toBe(
      "b".repeat(40),
    );
    // Retried on the API first, and only then routed around.
    expect(calls.filter((call) => call.command === "gh")).toHaveLength(2);
    const lsRemote = calls.find((call) => call.args.includes("ls-remote"));
    expect(lsRemote?.args).toContain("refs/heads/subticket-1-1");
    // The fallback is a network call too, so it needs the same credentials —
    // and the token still must not appear in argv.
    expect(lsRemote?.args.join(" ")).not.toContain(TOKEN);
    expect(lsRemote?.env?.[GIT_TOKEN_ENV]).toBe(TOKEN);
  });

  test("gives up only when both sources refuse", async () => {
    const { exec } = recorder({
      "gh pr view 7": { code: 1, stdout: "", stderr: "HTTP 503" },
      "git ls-remote origin": { code: 128, stdout: "", stderr: "no route" },
    });

    expect(await armGitHub(arm(), exec).headSha(7, "subticket-1-1")).toBeUndefined();
  });

  test("ignores a remote answer that is not a sha", async () => {
    const { exec } = recorder({
      "gh pr view 7": { code: 1, stdout: "", stderr: "HTTP 503" },
      "git ls-remote origin": ok("warning: something went sideways\n"),
    });

    expect(await armGitHub(arm(), exec).headSha(7, "subticket-1-1")).toBeUndefined();
  });
});

describe("pure helpers", () => {
  // Host-agnostic on purpose: it parses `owner/name` out of either spelling
  // git uses, and says nothing about which host that is.
  test("slugFromRemote handles both remote spellings", () => {
    expect(slugFromRemote("https://github.com/org/repo.git")).toBe("org/repo");
    expect(slugFromRemote("git@github.com:org/repo.git")).toBe("org/repo");
    expect(slugFromRemote("https://github.com/org/repo")).toBe("org/repo");
    expect(slugFromRemote("/tmp/a-local-checkout")).toBeUndefined();
  });

  test("pullRequestUrl finds the URL an arm signed off with", () => {
    expect(
      pullRequestUrl("done!\nPR: https://github.com/org/repo/pull/12\n"),
    ).toBe("https://github.com/org/repo/pull/12");
    expect(pullRequestUrl("no link here")).toBeUndefined();
  });

  test("pullRequestNumber reads the number back off a URL", () => {
    expect(pullRequestNumber("https://github.com/org/repo/pull/12")).toBe(12);
    expect(pullRequestNumber("https://github.com/org/repo")).toBeUndefined();
  });
});
