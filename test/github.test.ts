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
