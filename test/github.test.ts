import { describe, expect, test } from "bun:test";
import {
  GIT_TOKEN_ENV,
  armGitHub,
  pullRequestNumber,
  pullRequestUrl,
  sameLogin,
  slugFromRemote,
} from "../src/harness/github.js";
import type { ArmConfig } from "../src/harness/config.js";
import type {
  Baseline,
  CommandResult,
  CommandRunner,
} from "../src/harness/github.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "ghp_thisisthesecretvalue";

const arm = (overrides: Partial<ArmConfig> = {}): ArmConfig => ({
  name: "tuatara",
  repo: "/tmp/checkout",
  ...overrides,
});

const recordedBaseline = (
  overrides: Partial<Baseline> = {},
): Baseline => ({
  slug: "org/repo",
  branch: "main",
  sha: "base1234",
  localBranches: ["main"],
  remoteBranches: ["main"],
  ...overrides,
});

const pullRequestAt = (sha: string): string =>
  JSON.stringify([
    {
      number: 41,
      headRefOid: sha,
      headRepository: { nameWithOwner: "org/repo" },
    },
  ]);

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

  test("isolated harness operations run inside the arm without forwarding the token", async () => {
    const { calls, exec } = recorder({
      "sbx exec /workspace GH_TOKEN=proxy-managed GITHUB_TOKEN=proxy-managed vivarium-tuatara git rev-parse": ok(
        "feature-branch\n",
      ),
    });

    const branch = await armGitHub(
      arm({
        repo: "https://github.com/org/repo.git",
        sandboxName: "vivarium-tuatara",
        ghToken: TOKEN,
      }),
      exec,
    ).currentBranch();

    expect(branch).toBe("feature-branch");
    expect(calls).toEqual([
      {
        command: "sbx",
        args: [
          "exec",
          "-w",
          "/workspace",
          "-e",
          "GH_TOKEN=proxy-managed",
          "-e",
          "GITHUB_TOKEN=proxy-managed",
          "vivarium-tuatara",
          "git",
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ],
        env: undefined,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  test("isolated baseline sync crosses the sandbox control plane once", async () => {
    const { calls, exec } = recorder({
      "sbx exec /workspace GH_TOKEN=proxy-managed GITHUB_TOKEN=proxy-managed vivarium-tuatara bash": ok(
        '{"remote":"https://github.com/org/repo.git","branch":"main","sha":"abc123","localBranches":["main"],"remoteBranches":["main","existing"]}\n',
      ),
    });

    const github = armGitHub(
      arm({
        repo: "https://github.com/org/repo.git",
        sandboxName: "vivarium-tuatara",
        ghToken: TOKEN,
      }),
      exec,
    );
    expect(await github.isGitHubCheckout()).toBe(true);
    expect(await github.syncToBaseline()).toEqual({
      slug: "org/repo",
      branch: "main",
      sha: "abc123",
      localBranches: ["main"],
      remoteBranches: ["main", "existing"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("vivarium-baseline");
    expect(calls[0]?.args.some((arg) => arg.includes("vivarium-sync"))).toBe(
      true,
    );
    const scriptIndex = calls[0]?.args.indexOf("-ceu") ?? -1;
    const syntax = spawnSync("bash", [
      "-n",
      "-c",
      calls[0]?.args[scriptIndex + 1] ?? "",
    ]);
    expect(syntax.status).toBe(0);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  test("isolated baseline sync tolerates output before its final JSON line", async () => {
    const { exec } = recorder({
      "sbx exec /workspace GH_TOKEN=proxy-managed GITHUB_TOKEN=proxy-managed vivarium-tuatara bash": ok(
        'Removing generated.tmp\n{"remote":"https://github.com/org/repo.git","branch":"main","sha":"abc123","localBranches":["main"],"remoteBranches":["main"]}\n',
      ),
    });

    const github = armGitHub(
      arm({
        repo: "https://github.com/org/repo.git",
        sandboxName: "vivarium-tuatara",
        ghToken: TOKEN,
      }),
      exec,
    );

    expect(await github.syncToBaseline()).toEqual({
      slug: "org/repo",
      branch: "main",
      sha: "abc123",
      localBranches: ["main"],
      remoteBranches: ["main"],
    });
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
      localBranches: [],
      remoteBranches: [],
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
  test("reads an isolated conversation with reactions in one sbx crossing", async () => {
    const bundle = {
      reviews: [
        {
          id: 1,
          author: { login: "greptile-apps" },
          body: "review body",
          submittedAt: "2026-07-25T01:00:00Z",
          state: "COMMENTED",
        },
      ],
      issueComments: [
        {
          id: 2,
          user: { login: "vivarium-tuatara-bot" },
          body: "fixed",
          created_at: "2026-07-25T02:00:00Z",
          html_url: "https://github.com/org/repo/pull/7#issuecomment-2",
          reactions: { total_count: 1 },
        },
      ],
      inlineComments: [
        {
          id: 3,
          user: { login: "greptile-apps[bot]" },
          body: "inline finding",
          created_at: "2026-07-25T03:00:00Z",
          path: "src/github.ts",
          line: 7,
        },
      ],
      reactions: [
        {
          parentKind: "issue-comment",
          parentId: 2,
          reaction: {
            id: 90,
            user: { login: "greptile-apps[bot]" },
            content: "+1",
            created_at: "2026-07-25T02:01:00Z",
          },
        },
      ],
    };
    const { calls, exec } = recorder({
      "sbx exec /workspace GH_TOKEN=proxy-managed GITHUB_TOKEN=proxy-managed vivarium-tuatara bash": ok(
        `${JSON.stringify(bundle)}\n`,
      ),
    });
    const github = armGitHub(
      arm({
        repo: "https://github.com/org/repo.git",
        sandboxName: "vivarium-tuatara",
        ghToken: TOKEN,
      }),
      exec,
    );

    const notes = await github.conversation(7);

    expect(notes.map((entry) => [entry.kind, entry.body])).toEqual([
      ["review", "review body"],
      ["issue-comment", "fixed"],
      ["reaction", "+1"],
      ["review-comment", "inline finding"],
    ]);
    expect(notes[2]).toMatchObject({
      author: "greptile-apps[bot]",
      inReplyTo: "issue-comment:2",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("bash");
    expect(calls[0]?.args).toContain("org/repo");
    expect(calls[0]?.args.at(-1)).toBe("7");
    expect(JSON.stringify(calls)).not.toContain(TOKEN);

    const scriptIndex = calls[0]?.args.indexOf("-ceu") ?? -1;
    const script = calls[0]?.args[scriptIndex + 1] ?? "";
    const syntax = spawnSync("bash", ["-n", "-c", script]);
    expect(syntax.status).toBe(0);
  });

  test("an isolated conversation command failure remains a failed poll", async () => {
    const { exec } = recorder({
      "sbx exec /workspace GH_TOKEN=proxy-managed GITHUB_TOKEN=proxy-managed vivarium-tuatara bash": {
        code: 1,
        stdout: "",
        stderr: "GitHub API unavailable",
      },
    });
    const github = armGitHub(
      arm({
        repo: "https://github.com/org/repo.git",
        sandboxName: "vivarium-tuatara",
        ghToken: TOKEN,
      }),
      exec,
    );

    await expect(github.conversation(7)).rejects.toThrow(
      /GitHub API unavailable/,
    );
  });

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
            updated_at: "2026-07-25T01:05:00Z",
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
    expect(notes[0]?.updatedAt).toBe("2026-07-25T01:05:00Z");
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

  test("keeps an inline comment's diff anchor", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [] })),
      "gh api repos/org/repo/pulls/7/comments": ok(
        JSON.stringify([
          {
            id: 10,
            body: "finding",
            created_at: "2026-07-25T01:00:00Z",
            path: "src/session.ts",
            line: 42,
            original_line: 40,
            diff_hunk: "@@ -38,4 +40,4 @@\n context",
          },
        ]),
      ),
    });

    const notes = await armGitHub(arm(), exec).conversation(7);

    expect(notes[0]).toMatchObject({
      path: "src/session.ts",
      line: 42,
      originalLine: 40,
      diffHunk: "@@ -38,4 +40,4 @@\n context",
    });
  });

  // An empty conversation and an unreadable one must never look alike: a rate
  // limit during the review wait would read as reviewer silence, and a failure
  // at merge time would write `conversation: []` into land.json as if the
  // review never happened.
  test("throws when the inline comments cannot be read", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [] })),
      "gh api repos/org/repo/issues/7/comments": ok("[]"),
      "gh api repos/org/repo/pulls/7/comments": {
        code: 1,
        stdout: "",
        stderr: "HTTP 403: rate limit exceeded",
      },
    });

    await expect(armGitHub(arm(), exec).conversation(7)).rejects.toThrow(
      /rate limit exceeded/,
    );
  });

  test("throws when the issue comments cannot be read", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": ok(JSON.stringify({ reviews: [] })),
      "gh api repos/org/repo/issues/7/comments": {
        code: 1,
        stdout: "",
        stderr: "HTTP 502",
      },
    });

    await expect(armGitHub(arm(), exec).conversation(7)).rejects.toThrow(
      /HTTP 502/,
    );
  });

  test("throws when the reviews cannot be read", async () => {
    const { exec } = recorder({
      "git remote get-url": ok("https://github.com/org/repo.git\n"),
      "gh pr view": { code: 1, stdout: "", stderr: "HTTP 500" },
    });

    await expect(armGitHub(arm(), exec).conversation(7)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  test("throws when the origin remote cannot be resolved", async () => {
    const { exec } = recorder({
      "git remote get-url": { code: 128, stdout: "", stderr: "not a repo" },
      "gh pr view": ok(JSON.stringify({ reviews: [] })),
    });

    await expect(armGitHub(arm(), exec).conversation(7)).rejects.toThrow(
      /origin remote/,
    );
  });
});

describe("merge", () => {
  test("confirms the merge off the pull request state", async () => {
    const { exec } = recorder({
      "gh pr merge": ok("merged\n"),
      "gh pr view 7": ok(
        JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-07-25T01:00:00Z",
          mergeCommit: { oid: "c".repeat(40) },
        }),
      ),
    });

    const outcome = await armGitHub(arm(), exec).merge(7);

    expect(outcome).toEqual({
      merged: true,
      method: "merge",
      mergedAt: "2026-07-25T01:00:00Z",
      commit: "c".repeat(40),
      error: undefined,
    });
  });

  // A transient view failure after a successful merge must not record
  // merge-failed: that halts the climb with the box unchecked while the pull
  // request sits merged on GitHub, and the re-run rebuilds a solved rung.
  test("falls back to the merge exit code when the state cannot be re-read", async () => {
    const { exec, calls } = recorder({
      "gh pr merge": ok(""),
      "gh pr view 7": { code: 1, stdout: "", stderr: "HTTP 503" },
    });

    const outcome = await armGitHub(arm(), exec).merge(7);

    expect(outcome.merged).toBe(true);
    // The gap is named rather than left as ordinary missing fields.
    expect(outcome.error).toContain("could not be re-read");
    // The view was retried before falling back.
    const views = calls.filter((call) => call.args[1] === "view");
    expect(views).toHaveLength(3);
  });

  test("a failed merge with a failed re-read stays failed", async () => {
    const { exec } = recorder({
      "gh pr merge": { code: 1, stdout: "", stderr: "merge conflict" },
      "gh pr view 7": { code: 1, stdout: "", stderr: "HTTP 503" },
    });

    const outcome = await armGitHub(arm(), exec).merge(7);

    expect(outcome.merged).toBe(false);
    expect(outcome.error).toContain("merge conflict");
  });

  test("a failed merge command still counts when the state says MERGED", async () => {
    const { exec } = recorder({
      "gh pr merge": { code: 1, stdout: "", stderr: "already merged" },
      "gh pr view 7": ok(JSON.stringify({ state: "MERGED" })),
    });

    expect((await armGitHub(arm(), exec).merge(7)).merged).toBe(true);
  });
});

describe("review check recovery", () => {
  test("normalizes GitHub check runs and status contexts", async () => {
    const { exec } = recorder({
      "gh pr view 7": ok(
        JSON.stringify({
          statusCheckRollup: [
            {
              name: "Greptile Review",
              status: "IN_PROGRESS",
              startedAt: "2026-07-30T01:00:00Z",
              completedAt: "0001-01-01T00:00:00Z",
              detailsUrl: "https://greptile.com/",
            },
            {
              context: "continuous-integration",
              state: "SUCCESS",
              createdAt: "2026-07-30T00:55:00Z",
              targetUrl: "https://ci.example/run/1",
            },
          ],
        }),
      ),
    });

    expect(await armGitHub(arm(), exec).checkRuns(7)).toEqual([
      {
        name: "Greptile Review",
        status: "IN_PROGRESS",
        startedAt: "2026-07-30T01:00:00Z",
        completedAt: "0001-01-01T00:00:00Z",
        createdAt: undefined,
        detailsUrl: "https://greptile.com/",
      },
      {
        name: "continuous-integration",
        status: "SUCCESS",
        startedAt: undefined,
        completedAt: undefined,
        createdAt: "2026-07-30T00:55:00Z",
        detailsUrl: "https://ci.example/run/1",
      },
    ]);
  });

  test("posts the review request as an exact PR-level comment", async () => {
    const { calls, exec } = recorder();

    await armGitHub(arm(), exec).postComment(7, "@greptileai review");

    expect(calls).toContainEqual({
      command: "gh",
      args: ["pr", "comment", "7", "--body", "@greptileai review"],
      env: undefined,
    });
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

describe("discarding interrupted work", () => {
  test("closes the owned PR and branch even from detached HEAD", async () => {
    const pushedSha = "a".repeat(40);
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from HEAD\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(
        `${pushedSha}\tupdate by push\n`,
      ),
      "gh pr list": ok(`${pullRequestAt(pushedSha)}\n`),
      "gh pr close 41": ok("closed\n"),
      "git ls-remote origin refs/heads/subticket-6-5": ok(
        `${pushedSha}\trefs/heads/subticket-6-5\n`,
      ),
      "git push origin :refs/heads/subticket-6-5": ok("deleted\n"),
    });

    const outcome = await armGitHub(
      arm({ ghToken: TOKEN }),
      exec,
    ).discardCurrentWork(recordedBaseline());

    expect(outcome).toEqual({
      branch: "subticket-6-5",
      pullRequest: 41,
      pullRequestClosed: true,
      branchDeleted: true,
    });
    const closed = calls.find(
      (call) => call.command === "gh" && call.args.includes("close"),
    );
    expect(closed?.args).toEqual([
      "pr",
      "close",
      "41",
      "--comment",
      "Closed by Vivarium: the run was stopped before this subticket landed and will restart from a fresh clone.",
    ]);
    const deletion = calls.find(
      (call) =>
        call.command === "git" &&
        call.args.includes(":refs/heads/subticket-6-5"),
    );
    expect(deletion?.args).toContain(
      `--force-with-lease=refs/heads/subticket-6-5:${pushedSha}`,
    );
    expect(deletion?.env?.[GIT_TOKEN_ENV]).toBe(TOKEN);
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(TOKEN);
    expect(calls.some((call) => call.args.includes("rev-parse"))).toBe(false);
    expect(calls.indexOf(deletion!)).toBeLessThan(calls.indexOf(closed!));
  });

  test("owns a new branch created from the recorded origin baseline", async () => {
    const pushedSha = "a".repeat(40);
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from origin/main\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(
        `${pushedSha}\tupdate by push\n`,
      ),
      "gh pr list": ok(`${pullRequestAt(pushedSha)}\n`),
      "gh pr close 41": ok("closed\n"),
      "git ls-remote origin refs/heads/subticket-6-5": ok(
        `${pushedSha}\trefs/heads/subticket-6-5\n`,
      ),
      "git push origin :refs/heads/subticket-6-5": ok("deleted\n"),
    });

    expect(
      await armGitHub(arm(), exec).discardCurrentWork(recordedBaseline()),
    ).toEqual({
      branch: "subticket-6-5",
      pullRequest: 41,
      pullRequestClosed: true,
      branchDeleted: true,
    });
    expect(calls.some((call) => call.args.includes("close"))).toBe(true);
  });

  test("never closes a same-named pull request from another repository", async () => {
    const pushedSha = "a".repeat(40);
    const foreignPr = JSON.stringify([
      {
        number: 99,
        headRefOid: pushedSha,
        headRepository: { nameWithOwner: "someone/fork" },
      },
    ]);
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from HEAD\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(
        `${pushedSha}\tupdate by push\n`,
      ),
      "gh pr list": ok(`${foreignPr}\n`),
      "git ls-remote origin refs/heads/subticket-6-5": ok(
        `${pushedSha}\trefs/heads/subticket-6-5\n`,
      ),
      "git push origin :refs/heads/subticket-6-5": ok("deleted\n"),
    });

    expect(
      await armGitHub(arm(), exec).discardCurrentWork(recordedBaseline()),
    ).toEqual({
      branch: "subticket-6-5",
      pullRequestClosed: false,
      branchDeleted: true,
    });
    expect(calls.some((call) => call.args.includes("close"))).toBe(false);
  });

  test("preserves a session branch replaced by a collaborator", async () => {
    const pushedSha = "a".repeat(40);
    const collaboratorSha = "b".repeat(40);
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from HEAD\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(
        `${pushedSha}\tupdate by push\n`,
      ),
      "gh pr list": ok(`${pullRequestAt(pushedSha)}\n`),
      "git ls-remote origin refs/heads/subticket-6-5": ok(
        `${collaboratorSha}\trefs/heads/subticket-6-5\n`,
      ),
    });

    await expect(
      armGitHub(arm(), exec).discardCurrentWork(recordedBaseline()),
    ).rejects.toThrow(/changed after this session pushed it/);
    expect(calls.some((call) => call.args.includes("close"))).toBe(false);
    expect(calls.some((call) => call.args.includes("push"))).toBe(false);
  });

  test("preserves a remote branch when no session push can be proven", async () => {
    const remoteSha = "a".repeat(40);
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from HEAD\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(""),
      "gh pr list": ok(`${pullRequestAt(remoteSha)}\n`),
      "git ls-remote origin refs/heads/subticket-6-5": ok(
        `${remoteSha}\trefs/heads/subticket-6-5\n`,
      ),
    });

    await expect(
      armGitHub(arm(), exec).discardCurrentWork(recordedBaseline()),
    ).rejects.toThrow(/no session push was recorded/);
    expect(calls.some((call) => call.args.includes("close"))).toBe(false);
    expect(calls.some((call) => call.args.includes("push"))).toBe(false);
  });

  test("does not close an orphaned PR without a session push record", async () => {
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from HEAD\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(""),
      "gh pr list": ok(`${pullRequestAt("a".repeat(40))}\n`),
      "git ls-remote origin refs/heads/subticket-6-5": {
        code: 2,
        stdout: "",
        stderr: "",
      },
    });

    await expect(
      armGitHub(arm(), exec).discardCurrentWork(recordedBaseline()),
    ).rejects.toThrow(/no session push was recorded/);
    expect(calls.some((call) => call.args.includes("close"))).toBe(false);
  });

  test("closes the owned PR when its session-pushed branch is already absent", async () => {
    const pushedSha = "a".repeat(40);
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from HEAD\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(
        `${pushedSha}\tupdate by push\n`,
      ),
      "gh pr list": ok(`${pullRequestAt(pushedSha)}\n`),
      "gh pr close 41": ok("closed\n"),
      "git ls-remote origin refs/heads/subticket-6-5": {
        code: 2,
        stdout: "",
        stderr: "",
      },
    });

    expect(
      await armGitHub(arm(), exec).discardCurrentWork(recordedBaseline()),
    ).toEqual({
      branch: "subticket-6-5",
      pullRequest: 41,
      pullRequestClosed: true,
      branchDeleted: false,
    });
    expect(calls.some((call) => call.args.includes("push"))).toBe(false);
  });

  test("a lease race preserves the PR when the remote moves during cleanup", async () => {
    const pushedSha = "a".repeat(40);
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from HEAD\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(
        `${pushedSha}\tupdate by push\n`,
      ),
      "gh pr list": ok(`${pullRequestAt(pushedSha)}\n`),
      "git ls-remote origin refs/heads/subticket-6-5": ok(
        `${pushedSha}\trefs/heads/subticket-6-5\n`,
      ),
      "git push origin :refs/heads/subticket-6-5": {
        code: 1,
        stdout: "",
        stderr: "stale info",
      },
    });

    await expect(
      armGitHub(arm(), exec).discardCurrentWork(recordedBaseline()),
    ).rejects.toThrow(/could not safely delete remote branch.*stale info/);
    expect(calls.some((call) => call.args.includes("close"))).toBe(false);
    const deletion = calls.find((call) => call.args.includes("push"));
    expect(deletion?.args).toContain(
      `--force-with-lease=refs/heads/subticket-6-5:${pushedSha}`,
    );
  });

  test("never touches the recorded baseline branch", async () => {
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
    });

    expect(
      await armGitHub(arm(), exec).discardCurrentWork(recordedBaseline()),
    ).toEqual({
      pullRequestClosed: false,
      branchDeleted: false,
    });
    expect(calls).toHaveLength(2);
  });

  test("never touches a pre-existing non-baseline branch", async () => {
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nexisting-feature\n"),
      "git for-each-ref refs/remotes/origin": ok("main\nexisting-feature\n"),
    });

    expect(
      await armGitHub(arm(), exec).discardCurrentWork(
        recordedBaseline({ remoteBranches: ["main", "existing-feature"] }),
      ),
    ).toEqual({
      pullRequestClosed: false,
      branchDeleted: false,
    });
    expect(calls.some((call) => call.command === "gh")).toBe(false);
    expect(calls.some((call) => call.args.includes("push"))).toBe(false);
  });

  test("still deletes a pushed branch that has no PR", async () => {
    const pushedSha = "a".repeat(40);
    const { calls, exec } = recorder({
      "git for-each-ref refs/heads": ok("main\nsubticket-6-5\n"),
      "git for-each-ref refs/remotes/origin": ok("main\n"),
      "git reflog show refs/heads/subticket-6-5": ok(
        "base1234\tbranch: Created from HEAD\n",
      ),
      "git reflog show refs/remotes/origin/subticket-6-5": ok(
        `${pushedSha}\tupdate by push\n`,
      ),
      "gh pr list": ok("[]\n"),
      "git ls-remote origin refs/heads/subticket-6-5": ok(
        `${pushedSha}\trefs/heads/subticket-6-5\n`,
      ),
      "git push origin :refs/heads/subticket-6-5": ok("deleted\n"),
    });

    const outcome = await armGitHub(arm(), exec).discardCurrentWork(
      recordedBaseline(),
    );

    expect(outcome.pullRequest).toBeUndefined();
    expect(outcome.pullRequestClosed).toBe(false);
    expect(outcome.branchDeleted).toBe(true);
    expect(calls.some((call) => call.args.includes("close"))).toBe(false);
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

  // REST says `greptile-apps[bot]`, GraphQL says `greptile-apps`, and the
  // conversation merges notes from both — so the reviewer match has to treat
  // the two spellings as one login or review bodies silently fail the filter.
  test("sameLogin treats the REST and GraphQL bot spellings as one login", () => {
    expect(sameLogin("greptile-apps", "greptile-apps[bot]")).toBe(true);
    expect(sameLogin("greptile-apps[bot]", "greptile-apps")).toBe(true);
    expect(sameLogin("greptile-apps[bot]", "greptile-apps[bot]")).toBe(true);
    expect(sameLogin("greptile-apps", "other-bot")).toBe(false);
    // Only a trailing suffix is a bot marker.
    expect(sameLogin("a[bot]b", "ab")).toBe(false);
  });
});

// The two bundled reads: each is one sbx crossing carrying every part of a
// landing step that used to be its own crossing. The parts fail independently,
// so the assertions here are about which gaps survive parsing, not prose.
describe("the bundled landing reads", () => {
  const isolated = () =>
    arm({
      repo: "https://github.com/org/repo.git",
      sandboxName: "vivarium-tuatara",
      ghToken: TOKEN,
    });
  const bashReply = (payload: unknown) => ({
    "sbx exec /workspace GH_TOKEN=proxy-managed GITHUB_TOKEN=proxy-managed vivarium-tuatara bash":
      ok(`${JSON.stringify(payload)}\n`),
  });
  const scriptOf = (call: { args: string[] } | undefined) => {
    const scriptIndex = call?.args.indexOf("-c") ?? -1;
    return call?.args[scriptIndex + 1] ?? "";
  };

  test("host mode does not define the bundled reads", () => {
    const github = armGitHub(arm(), recorder().exec);
    expect(github.afterAnswer).toBeUndefined();
    expect(github.finalizeMerge).toBeUndefined();
  });

  test("afterAnswer reads head, diff and conversation in one crossing", async () => {
    const { calls, exec } = recorder(
      bashReply({
        sha: "abc1234def5678",
        diff: "diff --git a/fix.ts b/fix.ts\n",
        diffError: null,
        conversation: {
          reviews: [],
          issueComments: [],
          inlineComments: [
            {
              id: 3,
              user: { login: "greptile-apps[bot]" },
              body: "inline finding",
              created_at: "2026-07-25T03:00:00Z",
            },
          ],
          reactions: [],
        },
        conversationError: null,
      }),
    );
    const github = armGitHub(isolated(), exec);

    const trace = await github.afterAnswer!(7, "subticket-1-1", "beef1234", true);

    expect(trace.sha).toBe("abc1234def5678");
    expect(trace.diff).toContain("diff --git");
    expect(trace.diffError).toBeUndefined();
    expect(trace.conversation?.map((entry) => entry.body)).toEqual([
      "inline finding",
    ]);
    expect(trace.conversationError).toBeUndefined();
    expect(calls).toHaveLength(1);
    // The script receives the pull request, branch, reviewed sha and the
    // want-trace flag as plain arguments.
    expect(calls[0]?.args.slice(-4)).toEqual([
      "7",
      "subticket-1-1",
      "beef1234",
      "1",
    ]);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);

    const syntax = spawnSync("bash", ["-n", "-c", scriptOf(calls[0])]);
    expect(syntax.status).toBe(0);
  });

  test("afterAnswer keeps each part's gap independent", async () => {
    const { exec } = recorder(
      bashReply({
        sha: "not-a-sha",
        diff: null,
        diffError: "git diff failed",
        conversation: null,
        conversationError: "rate limited",
      }),
    );
    const github = armGitHub(isolated(), exec);

    const trace = await github.afterAnswer!(7, "subticket-1-1", "beef1234", true);

    expect(trace.sha).toBeUndefined();
    expect(trace.diff).toBeUndefined();
    expect(trace.diffError).toBe("git diff failed");
    expect(trace.conversation).toBeUndefined();
    expect(trace.conversationError).toBe("rate limited");
  });

  test("a failed bundle read throws so the caller can fall back", async () => {
    const { exec } = recorder({
      "sbx exec /workspace GH_TOKEN=proxy-managed GITHUB_TOKEN=proxy-managed vivarium-tuatara bash":
        { code: 1, stdout: "", stderr: "control plane down" },
    });
    const github = armGitHub(isolated(), exec);

    await expect(
      github.afterAnswer!(7, "subticket-1-1", "beef1234", false),
    ).rejects.toThrow(/control plane down/);
    await expect(github.finalizeMerge!(7)).rejects.toThrow(
      /control plane down/,
    );
  });

  test("discardCurrentWork closes and deletes in one crossing", async () => {
    const { calls, exec } = recorder(
      bashReply({
        branch: "subticket-6-5",
        pullRequest: 41,
        pullRequestClosed: true,
        branchDeleted: true,
        errors: [],
      }),
    );
    const github = armGitHub(isolated(), exec);

    expect(await github.discardCurrentWork(recordedBaseline())).toEqual({
      branch: "subticket-6-5",
      pullRequest: 41,
      pullRequestClosed: true,
      branchDeleted: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(-6)).toEqual([
      "main",
      "base1234",
      '["main"]',
      '["main"]',
      "org/repo",
      "Closed by Vivarium: the run was stopped before this subticket landed and will restart from a fresh clone.",
    ]);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);

    const syntax = spawnSync("bash", ["-n", "-c", scriptOf(calls[0])]);
    expect(syntax.status).toBe(0);
  });

  test("discardCurrentWork reports partial cleanup instead of hiding it", async () => {
    const { exec } = recorder(
      bashReply({
        branch: "subticket-6-5",
        pullRequest: 41,
        pullRequestClosed: true,
        branchDeleted: false,
        errors: ["could not safely delete remote branch subticket-6-5: denied"],
      }),
    );
    const github = armGitHub(isolated(), exec);

    await expect(
      github.discardCurrentWork(recordedBaseline()),
    ).rejects.toThrow(
      /could not safely delete remote branch subticket-6-5/,
    );
  });

  test("finalizeMerge decides merged from the re-read state, not the exit code", async () => {
    const { calls, exec } = recorder(
      bashReply({
        merge: { code: 1, stdout: "", stderr: "already merged" },
        view: {
          state: "MERGED",
          mergedAt: "2026-07-30T14:46:02Z",
          mergeCommit: { oid: "deadbeef" },
        },
        conversation: {
          reviews: [],
          issueComments: [
            {
              id: 2,
              user: { login: "greptile-apps[bot]" },
              body: "summary",
              created_at: "2026-07-25T02:00:00Z",
            },
          ],
          inlineComments: [],
          reactions: [],
        },
        conversationError: null,
        refreshed: {
          number: 7,
          url: "https://github.com/org/repo/pull/7",
          title: "1.1 Do the thing",
          headRefName: "subticket-1-1",
          state: "MERGED",
          additions: 10,
          deletions: 2,
          changedFiles: 3,
        },
      }),
    );
    const github = armGitHub(isolated(), exec);

    const result = await github.finalizeMerge!(7);

    expect(result.merge.merged).toBe(true);
    expect(result.merge.mergedAt).toBe("2026-07-30T14:46:02Z");
    expect(result.merge.commit).toBe("deadbeef");
    expect(result.conversation?.map((entry) => entry.body)).toEqual([
      "summary",
    ]);
    expect(result.refreshed?.changedFiles).toBe(3);
    expect(calls).toHaveLength(1);
    // The churn refresh reads the same fields as findPullRequest.
    expect(calls[0]?.args.at(-1)).toContain("changedFiles");

    const syntax = spawnSync("bash", ["-n", "-c", scriptOf(calls[0])]);
    expect(syntax.status).toBe(0);
  });

  test("finalizeMerge without a state re-read falls back to the exit code", async () => {
    const { exec } = recorder(
      bashReply({
        merge: { code: 0, stdout: "", stderr: "" },
        view: null,
        conversation: null,
        conversationError: "boom",
        refreshed: null,
      }),
    );
    const github = armGitHub(isolated(), exec);

    const result = await github.finalizeMerge!(7);

    expect(result.merge.merged).toBe(true);
    // Missing, not absent: the record must say the state could not be re-read.
    expect(result.merge.error).toMatch(/could not be re-read/);
    expect(result.conversation).toBeUndefined();
    expect(result.conversationError).toBe("boom");
    expect(result.refreshed).toBeUndefined();
  });
});

// Execute the bundled scripts for real — bash, jq and all — against stubbed
// `gh`/`git` binaries, the way the mirror-sync suite runs its script. `bash
// -n` above proves the syntax; this proves the jq assembly and the argument
// plumbing produce the JSON contract the TypeScript side parses.
describe("the bundled scripts, executed", () => {
  const captureScript = async (
    invoke: (github: ReturnType<typeof armGitHub>) => Promise<unknown>,
  ): Promise<string[]> => {
    const { calls, exec } = recorder({
      "sbx exec /workspace GH_TOKEN=proxy-managed GITHUB_TOKEN=proxy-managed vivarium-tuatara bash":
        ok(
          '{"sha":null,"diff":null,"diffError":null,"conversation":null,"conversationError":null,"merge":{"code":0,"stdout":"","stderr":""},"view":null,"refreshed":null,"branch":"subticket-6-5","pullRequest":41,"pullRequestClosed":true,"branchDeleted":true,"errors":[]}\n',
        ),
    });
    const github = armGitHub(
      arm({
        repo: "https://github.com/org/repo.git",
        sandboxName: "vivarium-tuatara",
        ghToken: TOKEN,
      }),
      exec,
    );
    await invoke(github);
    const args = calls[0]?.args ?? [];
    const scriptIndex = args.indexOf("-c");
    // The script plus everything after it: [script, $0, $1, …].
    return args.slice(scriptIndex + 1);
  };

  const stubDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "vivarium-gh-stub-"));
    writeFileSync(
      join(dir, "gh"),
      `#!/usr/bin/env bash
args="$*"
case "$args" in
  "pr list --head subticket-6-5 --state open --limit 100 --json number,headRefOid,headRepository")
    echo '[{"number":41,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRepository":{"nameWithOwner":"org/repo"}}]'
    ;;
  "pr close 41 --comment Closed by Vivarium: the run was stopped before this subticket landed and will restart from a fresh clone.") exit 0 ;;
  "pr view 7 --json headRefOid") printf '{"headRefOid":"%s"}\\n' "$GH_STUB_SHA" ;;
  "pr view 7 --json reviews") echo '{"reviews":[]}' ;;
  "pr merge 7 --merge --delete-branch") exit 0 ;;
  "pr view 7 --json state,mergedAt,mergeCommit") echo '{"state":"MERGED","mergedAt":"2026-07-30T00:00:00Z","mergeCommit":{"oid":"deadbeef"}}' ;;
  "pr view 7 --json number,url,title,headRefName,state,statusCheckRollup,additions,deletions,changedFiles") echo '{"number":7,"url":"https://github.com/org/repo/pull/7","title":"t","headRefName":"b","state":"MERGED","additions":1,"deletions":2,"changedFiles":3}' ;;
  "api --paginate repos/org/repo/issues/7/comments") echo '[]' ;;
  "api --paginate repos/org/repo/pulls/7/comments") echo '[{"id":3,"user":{"login":"greptile-apps[bot]"},"body":"finding","created_at":"2026-07-25T03:00:00Z","reactions":{"total_count":0}}]' ;;
  *) echo "unexpected gh $args" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "git"),
      `#!/usr/bin/env bash
case "$1" in
  for-each-ref)
    case "$*" in
      *"refs/heads"*) printf '%s\\n' main subticket-6-5 ;;
      *"refs/remotes/origin"*)
        echo main
        if [ "$GH_STUB_MODE" = "preexisting" ]; then echo subticket-6-5; fi
        ;;
    esac
    ;;
  reflog)
    case "$*" in
      *"refs/remotes/origin/subticket-6-5"*)
        printf '%s\\tupdate by push\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        ;;
      *)
        if [ "$GH_STUB_MODE" = "origin" ]; then
          printf 'base1234\\tbranch: Created from origin/main\\n'
        else
          printf 'base1234\\tbranch: Created from HEAD\\n'
        fi
        ;;
    esac
    ;;
  ls-remote)
    if [ "$GH_STUB_MODE" = "replaced" ]; then
      sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    else
      sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    fi
    printf '%s\\trefs/heads/subticket-6-5\\n' "$sha"
    ;;
  push)
    case "$*" in
      *"--force-with-lease=refs/heads/subticket-6-5:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"*)
        if [ "$GH_STUB_MODE" = "lease-race" ]; then
          echo "stale info" >&2
          exit 1
        fi
        exit 0
        ;;
      *)
        echo "unsafe delete: $*" >&2
        exit 1
        ;;
    esac
    ;;
  diff) printf 'STUBDIFF %s\\n' "$2" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    return dir;
  };

  const runScript = (
    scriptAndArgs: string[],
    sha: string,
    mode = "owned",
  ): Record<string, any> => {
    const dir = stubDir();
    const result = spawnSync("bash", ["-c", ...scriptAndArgs], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_STUB_SHA: sha,
        GH_STUB_MODE: mode,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]!);
  };

  test("afterAnswer settles: equal shas read the conversation, take no diff", async () => {
    const scriptAndArgs = await captureScript((github) =>
      github.afterAnswer!(7, "subticket-1-1", "aaaaaaa1", true),
    );
    const parsed = runScript(scriptAndArgs, "aaaaaaa1");

    expect(parsed.sha).toBe("aaaaaaa1");
    expect(parsed.diff).toBeNull();
    expect(parsed.diffError).toBeNull();
    expect(parsed.conversationError).toBeNull();
    expect(parsed.conversation?.inlineComments?.[0]?.body).toBe("finding");
  });

  test("afterAnswer pushed: differing shas take the diff, skip the conversation", async () => {
    const scriptAndArgs = await captureScript((github) =>
      github.afterAnswer!(7, "subticket-1-1", "aaaaaaa1", true),
    );
    const parsed = runScript(scriptAndArgs, "bbbbbb22");

    expect(parsed.sha).toBe("bbbbbb22");
    expect(parsed.diff).toContain("STUBDIFF aaaaaaa1..bbbbbb22");
    expect(parsed.diffError).toBeNull();
    expect(parsed.conversation).toBeNull();
    expect(parsed.conversationError).toBeNull();
  });

  test("discardCurrentWork closes the PR and deletes the branch", async () => {
    const scriptAndArgs = await captureScript((github) =>
      github.discardCurrentWork(recordedBaseline()),
    );
    const parsed = runScript(scriptAndArgs, "");

    expect(parsed).toMatchObject({
      branch: "subticket-6-5",
      pullRequest: 41,
      pullRequestClosed: true,
      branchDeleted: true,
      errors: [],
    });
  });

  test("discardCurrentWork accepts a branch created from origin/main", async () => {
    const scriptAndArgs = await captureScript((github) =>
      github.discardCurrentWork(recordedBaseline()),
    );
    const parsed = runScript(scriptAndArgs, "", "origin");

    expect(parsed).toMatchObject({
      branch: "subticket-6-5",
      pullRequest: 41,
      pullRequestClosed: true,
      branchDeleted: true,
      errors: [],
    });
  });

  test("discardCurrentWork preserves a collaborator-replaced branch and PR", async () => {
    const scriptAndArgs = await captureScript((github) =>
      github.discardCurrentWork(recordedBaseline()),
    );
    const parsed = runScript(scriptAndArgs, "", "replaced");

    expect(parsed).toMatchObject({
      branch: "subticket-6-5",
      pullRequest: 41,
      pullRequestClosed: false,
      branchDeleted: false,
    });
    expect(parsed.errors).toEqual([
      "remote branch subticket-6-5 changed after this session pushed it; left it and its pull request untouched",
    ]);
  });

  test("discardCurrentWork preserves the PR when its deletion lease loses a race", async () => {
    const scriptAndArgs = await captureScript((github) =>
      github.discardCurrentWork(recordedBaseline()),
    );
    const parsed = runScript(scriptAndArgs, "", "lease-race");

    expect(parsed).toMatchObject({
      branch: "subticket-6-5",
      pullRequest: 41,
      pullRequestClosed: false,
      branchDeleted: false,
    });
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain(
      "could not safely delete remote branch subticket-6-5",
    );
    expect(parsed.errors[0]).toContain("stale info");
  });

  test("discardCurrentWork leaves a pre-existing feature branch untouched", async () => {
    const scriptAndArgs = await captureScript((github) =>
      github.discardCurrentWork(recordedBaseline({
        remoteBranches: ["main", "subticket-6-5"],
      })),
    );
    const parsed = runScript(scriptAndArgs, "", "preexisting");

    expect(parsed).toMatchObject({
      branch: null,
      pullRequest: null,
      pullRequestClosed: false,
      branchDeleted: false,
      errors: [],
    });
  });

  test("finalizeMerge merges, re-reads, captures and refreshes in one pass", async () => {
    const scriptAndArgs = await captureScript((github) =>
      github.finalizeMerge!(7),
    );
    const parsed = runScript(scriptAndArgs, "unused");

    expect(parsed.merge?.code).toBe(0);
    expect(parsed.view?.state).toBe("MERGED");
    expect(parsed.view?.mergeCommit?.oid).toBe("deadbeef");
    expect(parsed.conversation?.inlineComments?.[0]?.body).toBe("finding");
    expect(parsed.conversationError).toBeNull();
    expect(parsed.refreshed?.changedFiles).toBe(3);
  });
});
