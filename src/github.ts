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
  // The description the arm wrote. The prompt requires it to open with the
  // ticket verbatim, so this is the arm's own statement of what it was asked
  // for — and the reviewer read it before anything else.
  body?: string;
  baseRefName?: string;
}

// One commit on the pull request. Kept so the record says what the arm actually
// did in what order without the repository having to still be there.
export interface CommitRef {
  sha: string;
  message: string;
  authors?: string[];
  committedAt?: string;
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
  // Where an inline comment points, and at what. `line` is what GitHub reports
  // *now*: an arm that pushes a fix makes the comment outdated and GitHub nulls
  // it, which is exactly when `originalLine` and `diffHunk` become the only
  // record of what was being complained about. Keeping the hunk is what makes
  // "which code did this finding refer to" answerable from the artifacts
  // instead of from a later API call against a repository that has to still
  // exist.
  line?: number;
  originalLine?: number;
  diffHunk?: string;
  // Whether the thread was resolved, and whether GitHub considers it outdated.
  // `resolved: false` on a thread the arm argued with and `resolved: true` on
  // one it fixed is the difference between a rejected suggestion and an accepted
  // one — which the brief asks for by name and no amount of reading the bodies
  // can settle.
  //
  // **undefined means unknown, not unresolved.** These live only in GraphQL, so
  // a REST-only run (or a failed query) leaves them absent rather than false.
  resolved?: boolean;
  outdated?: boolean;
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
  // The pull request's final diff, and the commits that made it. Captured before
  // the merge so the local record can show what changed without depending on
  // GitHub still serving the branch.
  diff(pullRequest: number): Promise<string | undefined>;
  commits(pullRequest: number): Promise<CommitRef[]>;
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
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string;
}

// Thread resolution is not in REST at all — `/pulls/{n}/comments` has no such
// field — so it takes one GraphQL query. 100 threads and 100 comments each is
// well past anything a Greptile review produces; the alternative is paginating a
// query whose answer is a pair of booleans.
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{ isResolved isOutdated comments(first:100){ nodes{ databaseId } } }
      }
    }
  }
}`;

interface GhReviewThreads {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: {
            isResolved?: boolean;
            isOutdated?: boolean;
            comments?: { nodes?: { databaseId?: number }[] };
          }[];
        };
      };
    };
  };
}

// Map each inline comment's id to its thread's resolution flags. A comment whose
// thread could not be read is simply absent, which is what leaves the note's
// fields undefined rather than false.
export function threadFlagsFrom(
  stdout: string,
): Map<string, { resolved: boolean; outdated: boolean }> {
  const flags = new Map<string, { resolved: boolean; outdated: boolean }>();
  const parsed = parseJson<GhReviewThreads>(stdout);
  const threads =
    parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  for (const thread of threads) {
    const resolved = thread.isResolved === true;
    const outdated = thread.isOutdated === true;
    for (const comment of thread.comments?.nodes ?? []) {
      if (typeof comment.databaseId !== "number") continue;
      flags.set(`review-comment:${comment.databaseId}`, { resolved, outdated });
    }
  }
  return flags;
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
        "number,url,title,headRefName,baseRefName,body,state,statusCheckRollup";
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
        // One extra call for what REST does not carry. Best-effort: a failure
        // leaves every note's resolution undefined, which reads as unknown.
        //
        // This runs on every poll of the review wait too, where the answer is
        // discarded — kept that way on purpose rather than splitting this into a
        // two-mode method: at a 30s poll and a 15m timeout that is tens of
        // one-point queries per subticket against a 5000/hour budget.
        const [owner, name] = slug.split("/");
        const threads = await gh([
          "api",
          "graphql",
          "-f",
          `query=${REVIEW_THREADS_QUERY}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${pullRequest}`,
        ]);
        const flags =
          threads.code === 0
            ? threadFlagsFrom(threads.stdout)
            : new Map<string, { resolved: boolean; outdated: boolean }>();

        for (const comment of parseJson<GhReviewComment[]>(inline.stdout) ??
          []) {
          const id = `review-comment:${comment.id ?? notes.length}`;
          const thread = flags.get(id);
          notes.push({
            id,
            kind: "review-comment",
            author: comment.user?.login ?? "unknown",
            body: comment.body ?? "",
            createdAt: comment.created_at ?? "",
            url: comment.html_url,
            path: comment.path,
            // `line` is null once the arm's fix makes the comment outdated;
            // `original_line` and the hunk are what survive that.
            line: comment.line ?? undefined,
            originalLine: comment.original_line ?? undefined,
            diffHunk: comment.diff_hunk,
            inReplyTo:
              comment.in_reply_to_id === undefined
                ? undefined
                : `review-comment:${comment.in_reply_to_id}`,
            resolved: thread?.resolved,
            outdated: thread?.outdated,
          });
        }
      }

      return notes.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    },

    // `gh pr diff` rather than a local `git diff`: the arm's branch may already
    // have been force-pushed over, and this asks GitHub what the pull request
    // *is* rather than what the checkout happens to hold.
    async diff(pullRequest) {
      const result = await gh(["pr", "diff", String(pullRequest)]);
      return result.code === 0 && result.stdout.length > 0
        ? result.stdout
        : undefined;
    },

    async commits(pullRequest) {
      const view = await gh([
        "pr",
        "view",
        String(pullRequest),
        "--json",
        "commits",
      ]);
      if (view.code !== 0) return [];
      const parsed = parseJson<{
        commits?: {
          oid?: string;
          messageHeadline?: string;
          messageBody?: string;
          committedDate?: string;
          authors?: { login?: string; name?: string }[];
        }[];
      }>(view.stdout);
      return (parsed?.commits ?? []).map((commit) => ({
        sha: String(commit.oid ?? ""),
        message: [commit.messageHeadline, commit.messageBody]
          .filter((part) => part !== undefined && part !== "")
          .join("\n\n"),
        authors: commit.authors
          ?.map((author) => author.login ?? author.name ?? "")
          .filter((author) => author !== ""),
        committedAt: commit.committedDate,
      }));
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
    baseRefName:
      typeof value.baseRefName === "string" ? value.baseRefName : undefined,
    body: typeof value.body === "string" ? value.body : undefined,
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
