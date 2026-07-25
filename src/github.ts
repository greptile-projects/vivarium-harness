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
// comment, or an issue comment. The harness records every one of them — the
// arm's replies as much as the reviewer's findings, because "did it actually
// answer" is the thing being observed.
export interface ReviewNote {
  id: string;
  kind: "review" | "review-comment" | "issue-comment";
  author: string;
  body: string;
  createdAt: string;
  url?: string;
  path?: string;
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
  // False for anything that is not a GitHub checkout — the demo's temp dirs,
  // a smoke run against a scratch repo. Landing is skipped rather than failed.
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
  headSha(pullRequest: number): Promise<string | undefined>;
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
  comments?: {
    id?: string | number;
    author?: { login?: string };
    body?: string;
    createdAt?: string;
    url?: string;
  }[];
}

interface GhReviewComment {
  id?: number;
  user?: { login?: string };
  body?: string;
  created_at?: string;
  html_url?: string;
  path?: string;
  in_reply_to_id?: number;
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
    // feature branch, a dirty tree) so every subticket starts where the ladder
    // says it does. Untracked files survive — `node_modules` and the mounted
    // ladder are not the arm's work to throw away.
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
    async headSha(pullRequest) {
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
      return undefined;
    },

    // Reviews, issue comments and inline review comments, merged into one
    // chronological record. Inline comments come from the REST API because
    // `gh pr view` does not expose them.
    async conversation(pullRequest) {
      const notes: ReviewNote[] = [];

      const view = await gh([
        "pr",
        "view",
        String(pullRequest),
        "--json",
        "reviews,comments",
      ]);
      const parsed =
        view.code === 0 ? parseJson<GhReviewsResponse>(view.stdout) : undefined;

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
      for (const comment of parsed?.comments ?? []) {
        notes.push({
          id: `issue-comment:${comment.id ?? comment.createdAt ?? notes.length}`,
          kind: "issue-comment",
          author: comment.author?.login ?? "unknown",
          body: comment.body ?? "",
          createdAt: comment.createdAt ?? "",
          url: comment.url,
        });
      }

      const url = await remote();
      const slug = url ? slugFromRemote(url) : undefined;
      if (slug) {
        // `--paginate` merges array responses into a single array, so this
        // stays one `JSON.parse` no matter how long the review gets.
        const inline = await gh([
          "api",
          "--paginate",
          `repos/${slug}/pulls/${pullRequest}/comments`,
        ]);
        for (const comment of parseJson<GhReviewComment[]>(inline.stdout) ??
          []) {
          notes.push({
            id: `review-comment:${comment.id ?? notes.length}`,
            kind: "review-comment",
            author: comment.user?.login ?? "unknown",
            body: comment.body ?? "",
            createdAt: comment.created_at ?? "",
            url: comment.html_url,
            path: comment.path,
            inReplyTo:
              comment.in_reply_to_id === undefined
                ? undefined
                : `review-comment:${comment.in_reply_to_id}`,
          });
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
      const view = await gh([
        "pr",
        "view",
        String(pullRequest),
        "--json",
        "state,mergedAt,mergeCommit",
      ]);
      const parsed =
        view.code === 0
          ? parseJson<{
              state?: string;
              mergedAt?: string;
              mergeCommit?: { oid?: string };
            }>(view.stdout)
          : undefined;
      const merged = parsed?.state === "MERGED";

      return {
        merged,
        method: "merge",
        mergedAt: parsed?.mergedAt,
        commit: parsed?.mergeCommit?.oid,
        error: merged
          ? undefined
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
