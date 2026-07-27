import { spawn } from "node:child_process";
import type { ArmConfig } from "./config.js";

// Everything the harness does to git and GitHub *outside* Codex: resetting an
// arm's checkout to the shared baseline before a subticket, finding the pull
// request the arm opened, reading the review conversation, and merging it.
//
// The arm's own Codex session pushes and opens the PR itself (with `gh`, inside
// its container, under its own token). This module is the orchestrator's half:
// mechanical, deterministic, identical for both arms except for the one thing
// the experiment varies — whether an arm has a reviewer to answer to.

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
  });

// The commit both arms start a subticket from — recorded per run so a diverged
// pair of checkouts is visible in the artifacts rather than inferred later.
export interface Baseline {
  slug?: string;
  branch: string;
  sha: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  state: string;
  checks?: string;
}

// One entry in a pull request's conversation: a review body, an inline review
// comment, an issue comment, or a reaction to either kind of comment. The
// harness records every one of them — the arm's replies as much as the
// reviewer's findings, because "did it actually answer" is the thing being
// observed.
export interface ReviewNote {
  id: string;
  kind: "review" | "review-comment" | "issue-comment" | "reaction";
  author: string;
  body: string;
  createdAt: string;
  url?: string;
  path?: string;
  // The diff anchor of an inline comment. Preserved because the branch it
  // points into moves and gets deleted: the body alone says what the reviewer
  // said, but not where.
  line?: number;
  originalLine?: number;
  diffHunk?: string;
  state?: string;
  inReplyTo?: string;
}

export interface MergeOutcome {
  merged: boolean;
  method?: string;
  mergedAt?: string;
  commit?: string;
  error?: string;
}

// One arm's git/GitHub surface, bound to its checkout and token so callers
// never pass either around. Injected as a whole in tests.
export interface ArmGitHub {
  // False for anything that is not a GitHub checkout — a scratch dir, a smoke
  // run against a non-clone. Landing is skipped rather than failed.
  isGitHubCheckout(): Promise<boolean>;
  syncToBaseline(): Promise<Baseline>;
  currentBranch(): Promise<string | undefined>;
  findPullRequest(hint: {
    url?: string;
    branch?: string;
  }): Promise<PullRequestRef | undefined>;
  conversation(pullRequest: number): Promise<ReviewNote[]>;
  // The commit the branch currently points at. Recorded on both sides of every
  // review round, because an arm that amends or force-pushes to address a
  // comment makes the reviewed commits unreachable from the branch and GitHub
  // marks the inline comments outdated — the one diff that shows what the
  // review actually changed. A sha stays fetchable long after the ref moves, so
  // capturing it is the whole preservation.
  //
  // `branch` is the fallback path: with it, a refusing API can be routed around
  // via `git ls-remote` rather than costing the sha outright.
  headSha(pullRequest: number, branch?: string): Promise<string | undefined>;
  merge(pullRequest: number): Promise<MergeOutcome>;
}

export type GitHubFactory = (arm: ArmConfig) => ArmGitHub;

// Parse `owner/name` out of an origin URL, in either form git uses.
export function slugFromRemote(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/, "");
  const match =
    /^git@[^:]+:(?<slug>[^/]+\/[^/]+)$/.exec(trimmed) ??
    /^(?:https?|ssh):\/\/[^/]+\/(?<slug>[^/]+\/[^/]+)$/.exec(trimmed);
  return match?.groups?.slug;
}

// The arm reports its pull request in its final message; this is how the
// harness reads it back. Any GitHub PR URL in the text works — the trailing
// `PR: <url>` line the prompt asks for is a convention, not a parser contract.
export function pullRequestUrl(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const matches = [
    ...output.matchAll(
      /https:\/\/github\.com\/[^\s)"'<>]+\/pull\/(\d+)(?![\w/])/g,
    ),
  ];
  return matches.at(-1)?.[0];
}

export function pullRequestNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? Number(match[1]) : undefined;
}

// GitHub publishes a bot's login two ways: REST says `greptile-apps[bot]`,
// GraphQL (`gh pr view --json reviews`) says `greptile-apps`. The conversation
// merges notes from both, so one configured reviewer string can never
// literally match every note it authored — review bodies would silently fail
// the reviewer filter while inline comments passed it. Compare with the
// suffix stripped from both sides.
export function sameLogin(left: string, right: string): boolean {
  const strip = (login: string): string => login.replace(/\[bot\]$/, "");
  return strip(left) === strip(right);
}

function parseJson<T>(stdout: string): T | undefined {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

// The environment variable the credential helper below reads the token out of.
// Named for this repo so it cannot collide with something the arm's own
// tooling sets.
export const GIT_TOKEN_ENV = "VIVARIUM_GIT_TOKEN";

// A token, when the arm has one, is fed to git through a one-shot credential
// helper so it never lands in the remote URL (and so never in `git config`,
// the reflog, or an error message quoting the URL).
//
// The helper reads the token from the environment rather than having it
// interpolated into this string: `-c` arguments are process **argv**, which on
// a shared host is world-readable through `ps` for as long as the fetch runs.
// The environment of another user's process is not. So what goes in argv is
// the *name* `$VIVARIUM_GIT_TOKEN`, expanded by the shell git runs the helper
// in, and the token itself is never a substring of anything we spawn. The `$$`
// below is the template literal's escape for a literal `$` — turning it into a
// JS interpolation is exactly the bug this avoids.
function credentialArgs(token: string | undefined): string[] {
  if (!token) return [];
  return [
    "-c",
    `credential.helper=!f() { echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV}"; }; f`,
  ];
}

interface GhReviewsResponse {
  reviews?: {
    id?: string | number;
    author?: { login?: string };
    body?: string;
    submittedAt?: string;
    state?: string;
    url?: string;
  }[];
}

interface GhComment {
  id?: number;
  user?: { login?: string };
  body?: string;
  created_at?: string;
  html_url?: string;
  reactions?: { total_count?: number };
}

interface GhReviewComment extends GhComment {
  path?: string;
  line?: number;
  original_line?: number;
  diff_hunk?: string;
  in_reply_to_id?: number;
}

interface GhReaction {
  id?: number;
  user?: { login?: string };
  content?: string;
  created_at?: string;
}

export function armGitHub(arm: ArmConfig, exec: CommandRunner): ArmGitHub {
  const env = arm.ghToken
    ? {
        GH_TOKEN: arm.ghToken,
        GITHUB_TOKEN: arm.ghToken,
        [GIT_TOKEN_ENV]: arm.ghToken,
      }
    : undefined;
  const git = (args: string[]) => exec("git", args, { cwd: arm.repo, env });
  const gh = (args: string[]) => exec("gh", args, { cwd: arm.repo, env });

  const remote = async (): Promise<string | undefined> => {
    const result = await git(["remote", "get-url", "origin"]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  };

  // origin/HEAD when the clone recorded one, `main` otherwise. Resolved from
  // the local refs so a sync never depends on an extra network round trip.
  const defaultBranch = async (): Promise<string> => {
    const result = await git([
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (result.code !== 0) return "main";
    return result.stdout.trim().replace(/^origin\//, "") || "main";
  };

  return {
    async isGitHubCheckout() {
      const url = await remote();
      return url !== undefined && slugFromRemote(url) !== undefined;
    },

    // Put the checkout back on the shared baseline: whatever origin's default
    // branch points at right now, including work the *other* subticket just
    // merged. Discards whatever the previous arm session left behind (a
    // feature branch, a dirty tree, untracked scratch files) so every subticket
    // starts where the ladder says it does.
    //
    // The clean is what makes the *pair* comparable rather than just each arm
    // tidy: `checkout -f` only restores tracked files, so a scratch file one
    // arm dropped would ride into the next subticket while the other arm's
    // tree stayed clean — an input that differs between the arms, in an
    // experiment whose whole design is holding inputs constant.
    //
    // Two things must survive it, and neither is the arm's work to throw away:
    // `node_modules` (reinstalling per subticket, for days) and `LADDER.md`
    // (a symlink on the host, a bind mount in the container — deleting it
    // blinds the arm to the ladder). The `-x` on the clean below is deliberate;
    // see its comment.
    async syncToBaseline() {
      const url = await remote();
      const slug = url ? slugFromRemote(url) : undefined;
      const branch = await defaultBranch();
      const credentials = credentialArgs(arm.ghToken);

      const fetched = await git([
        ...credentials,
        "fetch",
        "--prune",
        "origin",
        branch,
      ]);
      if (fetched.code !== 0) {
        throw new Error(
          `git fetch failed in ${arm.repo}: ${fetched.stderr.trim() || fetched.stdout.trim()}`,
        );
      }

      const checkout = await git([
        "checkout",
        "-f",
        "-B",
        branch,
        `origin/${branch}`,
      ]);
      if (checkout.code !== 0) {
        throw new Error(
          `git checkout ${branch} failed in ${arm.repo}: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
        );
      }

      // `-x` removes ignored files too. Without it every gitignored path — build
      // output, caches, coverage, scratch databases — survived into the next
      // subticket, and the reviewed arm does strictly more work per rung (it
      // runs its checks again after answering a review), so it could enter the
      // next subticket with warm caches the other arm lacks. That is state
      // persisting for one arm and not the other, in a design whose premise is
      // holding inputs constant. The two `-e` excludes already protect the only
      // things `-x` must not take: `node_modules` (expensive, identical for
      // both) and the mounted ladder.
      const cleaned = await git([
        "clean",
        "-fdx",
        "-e",
        "node_modules",
        "-e",
        "LADDER.md",
      ]);
      if (cleaned.code !== 0) {
        throw new Error(
          `git clean failed in ${arm.repo}: ${cleaned.stderr.trim() || cleaned.stdout.trim()}`,
        );
      }

      const head = await git(["rev-parse", "HEAD"]);
      return { slug, branch, sha: head.stdout.trim() };
    },

    async currentBranch() {
      const result = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (result.code !== 0) return undefined;
      const branch = result.stdout.trim();
      return branch && branch !== "HEAD" ? branch : undefined;
    },

    // The PR the arm opened, found by the URL it reported; failing that, by the
    // branch its checkout is sitting on. Both paths, because an arm that
    // forgets to quote its URL still opened a real pull request.
    async findPullRequest(hint) {
      const fields =
        "number,url,title,headRefName,state,statusCheckRollup";
      const number = hint.url ? pullRequestNumber(hint.url) : undefined;

      if (number !== undefined) {
        const view = await gh([
          "pr",
          "view",
          String(number),
          "--json",
          fields,
        ]);
        const parsed =
          view.code === 0
            ? parseJson<Record<string, unknown>>(view.stdout)
            : undefined;
        if (parsed) return toRef(parsed);
      }

      if (!hint.branch) return undefined;
      const list = await gh([
        "pr",
        "list",
        "--head",
        hint.branch,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        fields,
      ]);
      const parsed =
        list.code === 0
          ? parseJson<Record<string, unknown>[]>(list.stdout)
          : undefined;
      const first = parsed?.[0];
      return first ? toRef(first) : undefined;
    },

    // Retried, unlike every other call here, because this is the one whose
    // answer cannot be recovered later: the caller wants the sha *before* the
    // arm moves the ref, and a second chance a moment later is still before it.
    // Every other method can be re-run against the same pull request tomorrow.
    //
    // And when the API keeps refusing, it falls back to asking the git remote
    // directly. The same fact is published in two places over two protocols
    // with two quotas — a REST rate limit or a 5xx on `gh` says nothing about
    // whether `git ls-remote` will answer — so a single failing endpoint should
    // not be what loses a sha that cannot be re-read once the arm pushes.
    async headSha(pullRequest, branch) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const view = await gh([
          "pr",
          "view",
          String(pullRequest),
          "--json",
          "headRefOid",
        ]);
        if (view.code === 0) {
          const parsed = parseJson<{ headRefOid?: unknown }>(view.stdout);
          const sha = parsed?.headRefOid;
          if (typeof sha === "string" && sha.length > 0) return sha;
        }
      }

      if (!branch) return undefined;
      const remoteRef = await git([
        ...credentialArgs(arm.ghToken),
        "ls-remote",
        "origin",
        `refs/heads/${branch}`,
      ]);
      if (remoteRef.code !== 0) return undefined;
      // "<sha>\trefs/heads/<branch>"
      const sha = remoteRef.stdout.trim().split(/\s+/)[0];
      return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
    },

    // Reviews, issue comments, inline review comments and their reactions,
    // merged into one chronological record. Comments come from REST so their
    // reaction counts are available; identities are fetched only for comments
    // whose count is nonzero, avoiding an API call per historical comment on
    // every poll.
    //
    // Every call here checks its exit code and throws. A failed `gh` used to
    // fall through to an empty list, and an empty list is indistinguishable
    // from a quiet reviewer: a rate limit during the review wait read as
    // "merging unreviewed", and a failure at merge time wrote `conversation:
    // []` into land.json — the close-reading record — with nothing anywhere
    // saying it was a gap. Callers decide what a failure means (a failed poll
    // is retried; a failed capture is recorded as unavailable), but only if
    // they can see it.
    async conversation(pullRequest) {
      const notes: ReviewNote[] = [];

      const api = async (args: string[], what: string): Promise<string> => {
        const result = await gh(args);
        if (result.code !== 0) {
          throw new Error(
            `could not read ${what} of pull request ${pullRequest}: ${
              result.stderr.trim() ||
              result.stdout.trim() ||
              `gh exited ${result.code}`
            }`,
          );
        }
        return result.stdout;
      };

      const view = await api(
        ["pr", "view", String(pullRequest), "--json", "reviews"],
        "the reviews",
      );
      const parsed = parseJson<GhReviewsResponse>(view);

      for (const review of parsed?.reviews ?? []) {
        notes.push({
          id: `review:${review.id ?? review.submittedAt ?? notes.length}`,
          kind: "review",
          author: review.author?.login ?? "unknown",
          body: review.body ?? "",
          createdAt: review.submittedAt ?? "",
          url: review.url,
          state: review.state,
        });
      }
      const url = await remote();
      const slug = url ? slugFromRemote(url) : undefined;
      if (!slug) {
        // Only GitHub checkouts get here (see isGitHubCheckout), so a missing
        // slug is a transient git failure — and returning the reviews alone
        // would be the same silent partial capture the checks above exist to
        // prevent.
        throw new Error(
          `could not resolve the origin remote in ${arm.repo} — comments unread`,
        );
      }
      {
        const addReactions = async (
          comment: GhComment,
          parentKind: "issue-comment" | "review-comment",
          endpoint: string,
        ) => {
          if (!comment.id || (comment.reactions?.total_count ?? 0) === 0) return;
          const response = await api(
            ["api", "--paginate", endpoint],
            `reactions on comment ${comment.id}`,
          );
          for (const reaction of parseJson<GhReaction[]>(response) ?? []) {
            notes.push({
              id: `reaction:${parentKind}:${reaction.id ?? notes.length}`,
              kind: "reaction",
              author: reaction.user?.login ?? "unknown",
              body: reaction.content ?? "reaction",
              createdAt: reaction.created_at ?? "",
              url: comment.html_url,
              inReplyTo: `${parentKind}:${comment.id}`,
            });
          }
        };

        const issueComments = await api(
          ["api", "--paginate", `repos/${slug}/issues/${pullRequest}/comments`],
          "the issue comments",
        );
        for (const comment of parseJson<GhComment[]>(issueComments) ?? []) {
          notes.push({
            id: `issue-comment:${comment.id ?? notes.length}`,
            kind: "issue-comment",
            author: comment.user?.login ?? "unknown",
            body: comment.body ?? "",
            createdAt: comment.created_at ?? "",
            url: comment.html_url,
          });
          await addReactions(
            comment,
            "issue-comment",
            `repos/${slug}/issues/comments/${comment.id}/reactions`,
          );
        }

        // `--paginate` merges array responses into a single array, so this
        // stays one `JSON.parse` no matter how long the review gets.
        const inline = await api(
          ["api", "--paginate", `repos/${slug}/pulls/${pullRequest}/comments`],
          "the inline comments",
        );
        for (const comment of parseJson<GhReviewComment[]>(inline) ?? []) {
          notes.push({
            id: `review-comment:${comment.id ?? notes.length}`,
            kind: "review-comment",
            author: comment.user?.login ?? "unknown",
            body: comment.body ?? "",
            createdAt: comment.created_at ?? "",
            url: comment.html_url,
            path: comment.path,
            line: comment.line ?? undefined,
            originalLine: comment.original_line ?? undefined,
            diffHunk: comment.diff_hunk ?? undefined,
            inReplyTo:
              comment.in_reply_to_id === undefined
                ? undefined
                : `review-comment:${comment.in_reply_to_id}`,
          });
          await addReactions(
            comment,
            "review-comment",
            `repos/${slug}/pulls/comments/${comment.id}/reactions`,
          );
        }
      }

      return notes.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    },

    async merge(pullRequest) {
      const merge = await gh([
        "pr",
        "merge",
        String(pullRequest),
        "--merge",
        "--delete-branch",
      ]);

      // The follow-up view is what decides `merged`, so it retries — and when
      // it never answers, the merge command's own exit code decides instead.
      // A transient failure here used to record a successful merge as
      // merge-failed, which halts the climb with the box unchecked while the
      // pull request sits merged on GitHub; the re-run then rebuilds a solved
      // rung — the silent desync the merge barrier exists to prevent.
      let parsed:
        | {
            state?: string;
            mergedAt?: string;
            mergeCommit?: { oid?: string };
          }
        | undefined;
      for (let attempt = 1; attempt <= 3 && !parsed; attempt += 1) {
        const view = await gh([
          "pr",
          "view",
          String(pullRequest),
          "--json",
          "state,mergedAt,mergeCommit",
        ]);
        if (view.code === 0) {
          parsed = parseJson<typeof parsed>(view.stdout);
        }
      }
      const merged = parsed ? parsed.state === "MERGED" : merge.code === 0;

      return {
        merged,
        method: "merge",
        mergedAt: parsed?.mergedAt,
        commit: parsed?.mergeCommit?.oid,
        error: merged
          ? parsed
            ? undefined
            : "merge reported success but its state could not be re-read — mergedAt and commit are missing, not absent"
          : merge.stderr.trim() ||
            merge.stdout.trim() ||
            `pull request ${pullRequest} is ${parsed?.state ?? "not merged"}`,
      };
    },
  };
}

function toRef(value: Record<string, unknown>): PullRequestRef {
  const rollup = value.statusCheckRollup;
  return {
    number: Number(value.number ?? 0),
    url: String(value.url ?? ""),
    title: String(value.title ?? ""),
    headRefName: String(value.headRefName ?? ""),
    state: String(value.state ?? "UNKNOWN"),
    checks: Array.isArray(rollup)
      ? summarizeChecks(rollup as Record<string, unknown>[])
      : undefined,
  };
}

function summarizeChecks(rollup: Record<string, unknown>[]): string | undefined {
  if (rollup.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const check of rollup) {
    const state = String(check.conclusion || check.state || "PENDING");
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([state, count]) => `${count} ${state.toLowerCase()}`)
    .join(", ");
}

export const gitHubForArm: GitHubFactory = (arm) => armGitHub(arm, runCommand);
