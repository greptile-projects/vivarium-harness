import { spawn } from "node:child_process";
import type { ArmConfig } from "./config.js";

// Everything the harness does to git and GitHub *outside* Codex: resetting an
// arm's checkout to the shared baseline before a subticket, finding the pull
// request the arm opened, reading the review conversation, and merging it.
//
// The arm's own Codex session pushes and opens the PR itself (with `gh`, inside
// its microVM, under its own identity). This module is the orchestrator's half:
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
  // Branch refs present before the worker starts. Immediate-stop rollback uses
  // this ownership boundary instead of trusting whichever branch happens to
  // be checked out after an interrupted session.
  localBranches: string[];
  remoteBranches: string[];
}

export interface PullRequestRef {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  state: string;
  checks?: string;
  // Churn, as GitHub counts it. Snapshotted so the record can answer
  // findings-per-line and cost-of-review questions without a network. The
  // pre-review fetch carries the build's churn; the merge-time refresh
  // replaces it with the final numbers, review fixes included.
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

// One entry from GitHub's status-check rollup. Both CheckRun and
// StatusContext entries are normalized into this shape so landing can answer
// two mechanical questions without parsing display text: is Greptile running,
// and has it run since this review wait began?
export interface PullRequestCheck {
  name: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  detailsUrl?: string;
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
  // GitHub edits comments in place, retaining their object id. Keep the
  // revision timestamp separately so the landing loop can observe a changed
  // reviewer message without breaking stable inline-thread parent ids.
  updatedAt?: string;
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

// What an immediate human stop removed from GitHub before the ephemeral
// checkout disappeared. A branch that was never pushed has nothing to delete,
// so `branchDeleted` is only true when a remote ref actually existed.
export interface DiscardOutcome {
  branch?: string;
  pullRequest?: number;
  pullRequestClosed: boolean;
  branchDeleted: boolean;
}

// Everything the landing phase wants to know right after an arm's answer turn,
// read in one piece: where the branch head ended up, what a push changed, and
// the conversation as it stands. Each part fails independently — a missing
// `sha` is an unreadable head (which the caller treats as "pushed", the
// fail-open direction), a missing `diff` beside differing shas is a `diffError`
// gap, and a missing `conversation` is unknown, never "no trace".
export interface AnswerTrace {
  sha?: string;
  diff?: string;
  diffError?: string;
  conversation?: ReviewNote[];
  conversationError?: string;
}

// The whole irreversible tail of a merge, read in one piece: the merge itself,
// the conversation capture, and the churn refresh. `conversation` and
// `refreshed` fail independently of the merge — the caller records their gaps
// without un-merging anything.
export interface FinalizedMerge {
  merge: MergeOutcome;
  conversation?: ReviewNote[];
  conversationError?: string;
  refreshed?: PullRequestRef;
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
  checkRuns(pullRequest: number): Promise<PullRequestCheck[]>;
  postComment(pullRequest: number, body: string): Promise<void>;
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
  // The unified diff between two commits of this arm's checkout. Used to
  // archive each review round's fix (reviewedSha → respondedSha) while the
  // commits are still cheap to reach: after squash-merge and branch deletion
  // they are only reachable on GitHub for a while, and the arm's checkout —
  // which made them — is destroyed with the subticket's microVM. Throws when
  // git cannot produce it; the caller records the gap rather than guessing.
  diff(base: string, head: string): Promise<string>;
  merge(pullRequest: number): Promise<MergeOutcome>;
  // Roll an interrupted, unlanded subticket back to its external baseline.
  // The recorded pre-session branch refs and the new branch's creation reflog
  // establish ownership without trusting the current checkout, which may be
  // detached or sitting on unrelated work. Implementations close/delete only
  // that owned branch, while leaving the local checkout for the environment
  // layer to destroy.
  discardCurrentWork(baseline: Baseline): Promise<DiscardOutcome>;
  // The two bundled reads, defined only for isolated arms. Docker Sandbox
  // performs credential/template upkeep on every `sbx exec`, so a landing step
  // that makes three or four GitHub calls in sequence pays that fixed cost
  // three or four times — the post-answer bookkeeping and the merge tail were
  // each minutes of pure control-plane crossings. Each bundle is one crossing.
  // Callers fall back to the discrete methods above when a bundle is absent
  // (host mode, test fakes) or throws, so these are an optimization, never the
  // only path.
  //
  // `wantTrace` says whether the caller could still use the conversation for a
  // settle check (there is a round left and the shas may match); when false, or
  // when the shas differ, the bundle skips the conversation read.
  afterAnswer?(
    pullRequest: number,
    branch: string | undefined,
    reviewedSha: string | undefined,
    wantTrace: boolean,
  ): Promise<AnswerTrace>;
  finalizeMerge?(pullRequest: number): Promise<FinalizedMerge>;
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

// `vivarium-sync` owns the final compact JSON line on stdout. Older sandbox
// images did not redirect git clean's "Removing …" messages, and the sandbox
// client may also emit control-plane notices before the command response.
// Reading from the end preserves the JSON contract without requiring an image
// rebuild before an interrupted climb can resume.
function parseLastJsonLine<T>(stdout: string): T | undefined {
  const lines = stdout.trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJson<T>(lines[index] ?? "");
    if (parsed !== undefined) return parsed;
  }
  return undefined;
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
  updated_at?: string;
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

interface BundledReaction {
  parentKind?: "issue-comment" | "review-comment";
  parentId?: number;
  reaction?: GhReaction;
}

interface ConversationBundle {
  reviews?: GhReviewsResponse["reviews"];
  issueComments?: GhComment[];
  inlineComments?: GhReviewComment[];
  reactions?: BundledReaction[];
}

// Extend the baked baseline reset with the ownership snapshot needed by
// immediate-stop rollback. Keeping the wrapper here means an existing sandbox
// template gains the safety rule immediately; no image rebuild is required.
const ISOLATED_BASELINE_SCRIPT = String.raw`
set -euo pipefail

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

vivarium-sync >"$scratch/baseline.raw"
tail -n 1 "$scratch/baseline.raw" >"$scratch/baseline.json"
jq -e 'type == "object"' "$scratch/baseline.json" >/dev/null

git for-each-ref --format='%(refname:short)' refs/heads |
  jq -Rsc 'split("\n") | map(select(length > 0))' >"$scratch/local.json"
git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin |
  sed '/^HEAD$/d' |
  jq -Rsc 'split("\n") | map(select(length > 0))' >"$scratch/remote.json"

jq -cn \
  --slurpfile baseline "$scratch/baseline.json" \
  --slurpfile local "$scratch/local.json" \
  --slurpfile remote "$scratch/remote.json" \
  '$baseline[0] + {
    localBranches: $local[0],
    remoteBranches: $remote[0]
  }'
`;

// One review poll used to cross the sandbox control plane once for `gh pr
// view`, once for the origin URL, once for each comment collection, and once
// per reacted comment. Docker Sandbox performs credential/template upkeep on
// every `sbx exec`; when its refresh lock is contended, each crossing can pay
// the full lock timeout. A mature conversation therefore took minutes to read
// even after Greptile had already posted its response.
//
// Keep all GitHub requests inside one fixed, argument-only bash program. It
// still re-reads every reaction identity on every poll—the structured +1 is a
// landing decision, so caching by reaction count would be unsafe—but the host
// pays for one `sbx exec`. stdout is one compact JSON control-plane response;
// gh diagnostics remain on stderr.
const ISOLATED_CONVERSATION_SCRIPT = String.raw`
set -euo pipefail

slug="$1"
pull_request="$2"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

gh pr view "$pull_request" --json reviews >"$scratch/reviews.json"
gh api --paginate "repos/$slug/issues/$pull_request/comments" >"$scratch/issues.json"
gh api --paginate "repos/$slug/pulls/$pull_request/comments" >"$scratch/inline.json"

: >"$scratch/reactions.ndjson"
while IFS= read -r id; do
  gh api --paginate "repos/$slug/issues/comments/$id/reactions" </dev/null |
    jq -c --argjson parentId "$id" \
      '.[] | {parentKind: "issue-comment", parentId: $parentId, reaction: .}' \
      >>"$scratch/reactions.ndjson"
done < <(
  jq -r '.[] | select(.id != null and ((.reactions.total_count // 0) > 0)) | .id' \
    "$scratch/issues.json"
)

while IFS= read -r id; do
  gh api --paginate "repos/$slug/pulls/comments/$id/reactions" </dev/null |
    jq -c --argjson parentId "$id" \
      '.[] | {parentKind: "review-comment", parentId: $parentId, reaction: .}' \
      >>"$scratch/reactions.ndjson"
done < <(
  jq -r '.[] | select(.id != null and ((.reactions.total_count // 0) > 0)) | .id' \
    "$scratch/inline.json"
)

jq -s '.' "$scratch/reactions.ndjson" >"$scratch/reactions.json"
jq -cn \
  --slurpfile reviews "$scratch/reviews.json" \
  --slurpfile issues "$scratch/issues.json" \
  --slurpfile inline "$scratch/inline.json" \
  --slurpfile reactions "$scratch/reactions.json" \
  '{
    reviews: ($reviews[0].reviews // []),
    issueComments: ($issues[0] // []),
    inlineComments: ($inline[0] // []),
    reactions: ($reactions[0] // [])
  }'
`;

// Quote a script so it can ride as one argv word inside another script — the
// composite bundles below re-run the conversation reader through a nested
// `bash -c`, because `set -e` inside a shell *function* is silently disabled
// when the call sits in an `if !` condition, and a partially-read conversation
// must fail loudly rather than pass as a quiet reviewer.
const shellQuoted = (script: string): string =>
  `'${script.replaceAll("'", `'\\''`)}'`;

// The post-answer bookkeeping in one crossing: branch head (API twice, then
// the git remote — the same two-source read as `headSha`), the round's diff
// when the head moved, and the conversation when a settle check could still
// use it. No `set -e`: each part degrades to a named gap in the JSON rather
// than taking the others down with it.
const AFTER_ANSWER_SCRIPT = String.raw`
set -uo pipefail

slug="$1"
pull_request="$2"
branch="$3"
reviewed="$4"
want_trace="$5"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

sha=""
for attempt in 1 2; do
  view="$(gh pr view "$pull_request" --json headRefOid 2>>"$scratch/noise" || true)"
  sha="$(printf '%s' "$view" | jq -r '.headRefOid // empty' 2>/dev/null || true)"
  if [ -n "$sha" ]; then break; fi
done
if [ -z "$sha" ] && [ -n "$branch" ]; then
  sha="$(git ls-remote origin "refs/heads/$branch" 2>>"$scratch/noise" | awk 'NR == 1 { print $1 }' || true)"
fi

diff_status="none"
: >"$scratch/diff"
: >"$scratch/diff-err"
if [ -n "$sha" ] && [ -n "$reviewed" ] && [ "$sha" != "$reviewed" ]; then
  if git diff "$reviewed..$sha" >"$scratch/diff" 2>"$scratch/diff-err"; then
    diff_status="ok"
  else
    diff_status="error"
  fi
fi

conversation_error=""
printf 'null' >"$scratch/conversation.json"
if [ "$want_trace" = "1" ] && [ -n "$sha" ] && [ -n "$reviewed" ] && [ "$sha" = "$reviewed" ]; then
  if bash -c ${shellQuoted(ISOLATED_CONVERSATION_SCRIPT)} vivarium-conversation "$slug" "$pull_request" >"$scratch/conversation.raw" 2>"$scratch/conversation-err"; then
    tail -n 1 "$scratch/conversation.raw" >"$scratch/conversation.json"
  else
    conversation_error="$(tail -c 400 "$scratch/conversation-err" | tr -d '\0')"
    if [ -z "$conversation_error" ]; then conversation_error="the conversation read failed"; fi
  fi
fi

jq -cn \
  --arg sha "$sha" \
  --arg diffStatus "$diff_status" \
  --rawfile diff "$scratch/diff" \
  --rawfile diffErr "$scratch/diff-err" \
  --arg conversationError "$conversation_error" \
  --slurpfile conversation "$scratch/conversation.json" \
  '{
    sha: (if $sha == "" then null else $sha end),
    diff: (if $diffStatus == "ok" then $diff else null end),
    diffError:
      (if $diffStatus == "error"
       then (($diffErr | gsub("\\s+$"; "")) as $trimmed
             | if $trimmed == "" then "git diff failed" else $trimmed end)
       else null end),
    conversation: $conversation[0],
    conversationError: (if $conversationError == "" then null else $conversationError end)
  }'
`;

// The merge tail in one crossing: the merge, the state re-read that decides
// `merged`, the conversation capture for the record, and the churn refresh.
// Same shape as above — the merge exit code and every partial result travel in
// the JSON, so a failed capture can never look like an empty conversation and
// a failed re-read falls back to the merge command's own exit code.
const FINALIZE_MERGE_SCRIPT = String.raw`
set -uo pipefail

slug="$1"
pull_request="$2"
fields="$3"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

merge_code=0
gh pr merge "$pull_request" --merge --delete-branch >"$scratch/merge-out" 2>"$scratch/merge-err" || merge_code=$?

printf 'null' >"$scratch/view.json"
for attempt in 1 2 3; do
  if gh pr view "$pull_request" --json state,mergedAt,mergeCommit >"$scratch/view-try" 2>>"$scratch/noise" &&
    jq -e 'type == "object"' "$scratch/view-try" >/dev/null 2>&1; then
    cp "$scratch/view-try" "$scratch/view.json"
    break
  fi
done

conversation_error=""
printf 'null' >"$scratch/conversation.json"
if bash -c ${shellQuoted(ISOLATED_CONVERSATION_SCRIPT)} vivarium-conversation "$slug" "$pull_request" >"$scratch/conversation.raw" 2>"$scratch/conversation-err"; then
  tail -n 1 "$scratch/conversation.raw" >"$scratch/conversation.json"
else
  conversation_error="$(tail -c 400 "$scratch/conversation-err" | tr -d '\0')"
  if [ -z "$conversation_error" ]; then conversation_error="the conversation read failed"; fi
fi

printf 'null' >"$scratch/refreshed.json"
if gh pr view "$pull_request" --json "$fields" >"$scratch/refreshed-try" 2>>"$scratch/noise" &&
  jq -e 'type == "object"' "$scratch/refreshed-try" >/dev/null 2>&1; then
  cp "$scratch/refreshed-try" "$scratch/refreshed.json"
fi

jq -cn \
  --argjson mergeCode "$merge_code" \
  --rawfile mergeOut "$scratch/merge-out" \
  --rawfile mergeErr "$scratch/merge-err" \
  --slurpfile view "$scratch/view.json" \
  --slurpfile conversation "$scratch/conversation.json" \
  --arg conversationError "$conversation_error" \
  --slurpfile refreshed "$scratch/refreshed.json" \
  '{
    merge: { code: $mergeCode, stdout: $mergeOut, stderr: $mergeErr },
    view: $view[0],
    conversation: $conversation[0],
    conversationError: (if $conversationError == "" then null else $conversationError end),
    refreshed: $refreshed[0]
  }'
`;

// Immediate-stop rollback in one sandbox crossing. The Codex session has
// already been killed when this runs, so its local refs cannot move underneath
// the read. The remote still can: a collaborator may advance or recreate the
// branch at any moment. The remote-tracking reflog records the last object this
// session pushed, and a matching force-with-lease makes deletion the ownership
// check rather than a racy read followed by an unconditional mutation. A PR
// must match both that object and the recorded repository, and only after the
// ref check succeeds (or the ref is already absent) may it close. Errors are
// returned together so teardown can still destroy the VM after recording
// exactly what GitHub cleanup missed.
const DISCARD_WORK_SCRIPT = String.raw`
set -uo pipefail

baseline_branch="$1"
baseline_sha="$2"
baseline_local="$3"
baseline_remote="$4"
repo_slug="$5"
comment="$6"
branch=""
pull_request=""
closed="false"
branch_deleted="false"
errors=""
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

add_error() {
  if [ -n "$errors" ]; then errors="$errors"$'\n'; fi
  errors="$errors$1"
}

git for-each-ref --format='%(refname:short)' refs/heads |
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  [ "$candidate" != "$baseline_branch" ] || continue
  if printf '%s' "$baseline_local" |
    jq -e --arg branch "$candidate" 'index($branch) != null' >/dev/null 2>&1; then
    continue
  fi
  if printf '%s' "$baseline_remote" |
    jq -e --arg branch "$candidate" 'index($branch) != null' >/dev/null 2>&1; then
    continue
  fi

  first="$(git reflog show --format='%H%x09%gs' \
    "refs/heads/$candidate" 2>/dev/null | tail -n 1 || true)"
  first_sha="$(printf '%s' "$first" | cut -f1)"
  first_subject="$(printf '%s' "$first" | cut -f2-)"
  [ "$first_sha" = "$baseline_sha" ] || continue
  case "$first_subject" in
    "branch: Created from origin/$baseline_branch"|"branch: Created from refs/remotes/origin/$baseline_branch")
      ;;
    "branch: Created from origin/"* | "branch: Created from refs/remotes/"*)
      continue
      ;;
    "branch: Created from "*) ;;
    *) continue ;;
  esac
  printf '%s\n' "$candidate"
done >"$scratch/candidates"

candidate_count="$(wc -l <"$scratch/candidates" | tr -d ' ')"
if [ "$candidate_count" -gt 1 ]; then
  branches="$(paste -sd, "$scratch/candidates")"
  add_error "interrupted-work ownership is ambiguous across branches: $branches"
elif [ "$candidate_count" -eq 1 ]; then
  branch="$(sed -n '1p' "$scratch/candidates")"
fi

if [ -n "$branch" ]; then
  remote_ref="refs/heads/$branch"
  pushed_sha="$(git reflog show --format='%H%x09%gs' \
    "refs/remotes/origin/$branch" 2>/dev/null |
    awk -F '\t' '$2 == "update by push" { print $1; exit }' || true)"

  if gh pr list --head "$branch" --state open --limit 100 \
    --json number,headRefOid,headRepository \
    >"$scratch/pr.json" 2>"$scratch/pr.err"; then
    jq -c \
      --arg slug "$repo_slug" \
      --arg sha "$pushed_sha" \
      '[.[] | select(
        .headRepository.nameWithOwner == $slug and
        .headRefOid == $sha
      )]' "$scratch/pr.json" >"$scratch/owned-prs.json" 2>/dev/null ||
      printf '[]' >"$scratch/owned-prs.json"
    pr_count="$(jq 'length' "$scratch/owned-prs.json")"
    if [ "$pr_count" -gt 1 ]; then
      add_error "interrupted-work ownership is ambiguous across $pr_count pull requests for $branch"
    elif [ "$pr_count" -eq 1 ]; then
      pull_request="$(jq -r '.[0].number' "$scratch/owned-prs.json")"
    fi
  else
    detail="$(tail -c 400 "$scratch/pr.err" | tr -d '\0')"
    if [ -z "$detail" ]; then detail="gh pr list exited nonzero"; fi
    add_error "could not inspect open pull request for $branch: $detail"
  fi

  git ls-remote --exit-code --heads origin "$remote_ref" \
    >"$scratch/remote.out" 2>"$scratch/remote.err"
  remote_code=$?
  safe_to_close="false"
  if [ "$remote_code" -eq 0 ]; then
    remote_sha="$(awk 'NR == 1 { print $1 }' "$scratch/remote.out")"
    if [ -z "$pushed_sha" ]; then
      add_error "could not prove ownership of remote branch $branch: no session push was recorded"
    elif [ "$remote_sha" != "$pushed_sha" ]; then
      add_error "remote branch $branch changed after this session pushed it; left it and its pull request untouched"
    else
      if git push \
        "--force-with-lease=$remote_ref:$pushed_sha" \
        origin ":$remote_ref" \
        >"$scratch/delete.out" 2>"$scratch/delete.err"; then
        branch_deleted="true"
        safe_to_close="true"
      else
        detail="$(tail -c 400 "$scratch/delete.err" | tr -d '\0')"
        if [ -z "$detail" ]; then detail="leased git push --delete exited nonzero"; fi
        add_error "could not safely delete remote branch $branch: $detail"
      fi
    fi
  elif [ "$remote_code" -eq 2 ]; then
    if [ -n "$pushed_sha" ] || [ -z "$pull_request" ]; then
      safe_to_close="true"
    else
      add_error "could not prove ownership of pull request $pull_request: no session push was recorded"
    fi
  elif [ "$remote_code" -ne 2 ]; then
    detail="$(tail -c 400 "$scratch/remote.err" | tr -d '\0')"
    if [ -z "$detail" ]; then detail="git ls-remote exited $remote_code"; fi
    add_error "could not inspect remote branch $branch: $detail"
  fi

  if [ "$safe_to_close" = "true" ] && [ -n "$pull_request" ]; then
    if gh pr close "$pull_request" --comment "$comment" \
      >"$scratch/close.out" 2>"$scratch/close.err"; then
      closed="true"
    else
      detail="$(tail -c 400 "$scratch/close.err" | tr -d '\0')"
      if [ -z "$detail" ]; then detail="gh pr close exited nonzero"; fi
      add_error "could not close pull request $pull_request: $detail"
    fi
  fi
fi

jq -cn \
  --arg branch "$branch" \
  --arg pullRequest "$pull_request" \
  --argjson pullRequestClosed "$closed" \
  --argjson branchDeleted "$branch_deleted" \
  --arg errors "$errors" \
  '{
    branch: (if $branch == "" then null else $branch end),
    pullRequest: (if $pullRequest == "" then null else ($pullRequest | tonumber) end),
    pullRequestClosed: $pullRequestClosed,
    branchDeleted: $branchDeleted,
    errors: (if $errors == "" then [] else ($errors | split("\n")) end)
  }'
`;

const INTERRUPTED_PR_COMMENT =
  "Closed by Vivarium: the run was stopped before this subticket landed and will restart from a fresh clone.";

// The fields every pull-request snapshot carries, shared by `findPullRequest`
// and the merge bundle's churn refresh so the two reads cannot drift.
const PULL_REQUEST_FIELDS =
  "number,url,title,headRefName,state,statusCheckRollup,additions,deletions,changedFiles";

// A bundle is only trusted with all four collections present: a partial read
// must fail loudly rather than pass as a conversation with fewer entries.
function asConversationBundle(value: unknown): ConversationBundle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bundle = value as ConversationBundle;
  return Array.isArray(bundle.reviews) &&
    Array.isArray(bundle.issueComments) &&
    Array.isArray(bundle.inlineComments) &&
    Array.isArray(bundle.reactions)
    ? bundle
    : undefined;
}

// Reviews, issue comments, inline review comments and their reactions, merged
// into one chronological record. Pure: both the single-crossing bundle reads
// and the host path (which fetches the same four collections with discrete
// calls) land here, so the note shape cannot drift between modes.
function notesFromBundle(bundle: ConversationBundle): ReviewNote[] {
  const notes: ReviewNote[] = [];

  for (const review of bundle.reviews ?? []) {
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

  const addReactions = (
    comment: GhComment,
    parentKind: "issue-comment" | "review-comment",
  ): void => {
    if (!comment.id) return;
    for (const entry of bundle.reactions ?? []) {
      if (
        entry.parentKind !== parentKind ||
        entry.parentId !== comment.id ||
        !entry.reaction
      ) {
        continue;
      }
      notes.push({
        id: `reaction:${parentKind}:${entry.reaction.id ?? notes.length}`,
        kind: "reaction",
        author: entry.reaction.user?.login ?? "unknown",
        body: entry.reaction.content ?? "reaction",
        createdAt: entry.reaction.created_at ?? "",
        url: comment.html_url,
        inReplyTo: `${parentKind}:${comment.id}`,
      });
    }
  };

  for (const comment of bundle.issueComments ?? []) {
    notes.push({
      id: `issue-comment:${comment.id ?? notes.length}`,
      kind: "issue-comment",
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.created_at ?? "",
      updatedAt: comment.updated_at,
      url: comment.html_url,
    });
    addReactions(comment, "issue-comment");
  }

  for (const comment of bundle.inlineComments ?? []) {
    notes.push({
      id: `review-comment:${comment.id ?? notes.length}`,
      kind: "review-comment",
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.created_at ?? "",
      updatedAt: comment.updated_at,
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
    addReactions(comment, "review-comment");
  }

  return notes.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

interface GhStatusCheck {
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export function armGitHub(arm: ArmConfig, exec: CommandRunner): ArmGitHub {
  // Isolated checkouts live only inside their arm microVM. Run the harness's
  // deterministic git/GitHub operations through `sbx exec` as well as Codex,
  // so moving the clone off the host does not move landing responsibility into
  // the model. Docker's credential proxy replaces the sentinel value only on
  // GitHub requests; neither the VM nor argv receives the real token.
  const hostEnv = arm.ghToken
    ? {
        GH_TOKEN: arm.ghToken,
        GITHUB_TOKEN: arm.ghToken,
        [GIT_TOKEN_ENV]: arm.ghToken,
      }
    : undefined;
  const run = (command: string, args: string[]) =>
    arm.sandboxName
      ? exec("sbx", [
          "exec",
          "-w",
          "/workspace",
          "-e",
          "GH_TOKEN=proxy-managed",
          "-e",
          "GITHUB_TOKEN=proxy-managed",
          arm.sandboxName,
          command,
          ...args,
        ])
      : exec(command, args, { cwd: arm.repo, env: hostEnv });
  const git = (args: string[]) => run("git", args);
  const gh = (args: string[]) => run("gh", args);
  const checkoutLocation = arm.sandboxName
    ? `${arm.sandboxName}:/workspace`
    : arm.repo;

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

  const branchSnapshot = async (): Promise<{
    localBranches: string[];
    remoteBranches: string[];
  }> => {
    const [local, remoteBranches] = await Promise.all([
      git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
      git([
        "for-each-ref",
        "--format=%(refname:strip=3)",
        "refs/remotes/origin",
      ]),
    ]);
    if (local.code !== 0 || remoteBranches.code !== 0) {
      throw new Error(
        `could not snapshot branches in ${checkoutLocation}: ${
          local.stderr.trim() ||
          remoteBranches.stderr.trim() ||
          "git for-each-ref failed"
        }`,
      );
    }
    const lines = (value: string): string[] =>
      value
        .trim()
        .split(/\r?\n/)
        .filter((branch) => branch.length > 0 && branch !== "HEAD");
    return {
      localBranches: lines(local.stdout),
      remoteBranches: lines(remoteBranches.stdout),
    };
  };

  const sessionOwnedBranch = async (
    baseline: Baseline,
  ): Promise<string | undefined> => {
    const snapshot = await branchSnapshot();
    const candidates: string[] = [];
    for (const branch of snapshot.localBranches) {
      if (
        branch === baseline.branch ||
        baseline.localBranches.includes(branch) ||
        baseline.remoteBranches.includes(branch)
      ) {
        continue;
      }
      const reflog = await git([
        "reflog",
        "show",
        "--format=%H%x09%gs",
        `refs/heads/${branch}`,
      ]);
      if (reflog.code !== 0) continue;
      const entries = reflog.stdout.trim().split(/\r?\n/);
      const first = entries.at(-1) ?? "";
      const separator = first.indexOf("\t");
      if (separator < 0) continue;
      const createdSha = first.slice(0, separator);
      const subject = first.slice(separator + 1);
      const remoteBaselineSources = new Set([
        `branch: Created from origin/${baseline.branch}`,
        `branch: Created from refs/remotes/origin/${baseline.branch}`,
      ]);
      const createdFromRemote = subject.startsWith(
        "branch: Created from origin/",
      ) ||
        subject.startsWith("branch: Created from refs/remotes/");
      if (
        createdSha === baseline.sha &&
        subject.startsWith("branch: Created from ") &&
        (!createdFromRemote || remoteBaselineSources.has(subject))
      ) {
        candidates.push(branch);
      }
    }
    if (candidates.length > 1) {
      throw new Error(
        `interrupted-work ownership is ambiguous across branches: ${candidates.join(",")}`,
      );
    }
    return candidates[0];
  };

  const sessionPushedSha = async (
    branch: string,
  ): Promise<string | undefined> => {
    const reflog = await git([
      "reflog",
      "show",
      "--format=%H%x09%gs",
      `refs/remotes/origin/${branch}`,
    ]);
    if (reflog.code !== 0) return undefined;
    for (const entry of reflog.stdout.trim().split(/\r?\n/)) {
      const separator = entry.indexOf("\t");
      if (separator < 0 || entry.slice(separator + 1) !== "update by push") {
        continue;
      }
      const sha = entry.slice(0, separator);
      return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha) ? sha : undefined;
    }
    return undefined;
  };

  const api: ArmGitHub = {
    async isGitHubCheckout() {
      if (arm.sandboxName) {
        return slugFromRemote(arm.repo) !== undefined;
      }
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
    // (a symlink on the host, a read-only mount in the microVM — deleting it
    // blinds the arm to the ladder). The `-x` on the clean below is deliberate;
    // see its comment.
    async syncToBaseline() {
      if (arm.sandboxName) {
        const result = await run("bash", [
          "-ceu",
          ISOLATED_BASELINE_SCRIPT,
          "vivarium-baseline",
        ]);
        if (result.code !== 0) {
          throw new Error(
            `baseline sync failed in ${checkoutLocation}: ${result.stderr.trim() || result.stdout.trim()}`,
          );
        }
        const baseline = parseLastJsonLine<{
          remote?: string;
          branch?: string;
          sha?: string;
          localBranches?: unknown;
          remoteBranches?: unknown;
        }>(result.stdout);
        const slug = baseline?.remote
          ? slugFromRemote(baseline.remote)
          : undefined;
        if (
          !baseline?.branch ||
          !baseline.sha ||
          !slug ||
          !Array.isArray(baseline.localBranches) ||
          !baseline.localBranches.every(
            (branch): branch is string => typeof branch === "string",
          ) ||
          !Array.isArray(baseline.remoteBranches) ||
          !baseline.remoteBranches.every(
            (branch): branch is string => typeof branch === "string",
          )
        ) {
          const detail =
            result.stdout.trim() || result.stderr.trim() || "empty output";
          throw new Error(
            `baseline sync returned invalid state in ${checkoutLocation}: ${detail}`,
          );
        }
        return {
          slug,
          branch: baseline.branch,
          sha: baseline.sha,
          localBranches: baseline.localBranches,
          remoteBranches: baseline.remoteBranches,
        };
      }

      const url = await remote();
      const slug = url ? slugFromRemote(url) : undefined;
      const branch = await defaultBranch();
      const credentials = arm.sandboxName ? [] : credentialArgs(arm.ghToken);

      const fetched = await git([
        ...credentials,
        "fetch",
        "--prune",
        "origin",
        branch,
      ]);
      if (fetched.code !== 0) {
        throw new Error(
          `git fetch failed in ${checkoutLocation}: ${fetched.stderr.trim() || fetched.stdout.trim()}`,
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
          `git checkout ${branch} failed in ${checkoutLocation}: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
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
          `git clean failed in ${checkoutLocation}: ${cleaned.stderr.trim() || cleaned.stdout.trim()}`,
        );
      }

      const head = await git(["rev-parse", "HEAD"]);
      const snapshot = await branchSnapshot();
      return { slug, branch, sha: head.stdout.trim(), ...snapshot };
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
      const fields = PULL_REQUEST_FIELDS;
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
        ...(arm.sandboxName ? [] : credentialArgs(arm.ghToken)),
        "ls-remote",
        "origin",
        `refs/heads/${branch}`,
      ]);
      if (remoteRef.code !== 0) return undefined;
      // "<sha>\trefs/heads/<branch>"
      const sha = remoteRef.stdout.trim().split(/\s+/)[0];
      return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
    },

    // Read from the local object store: the arm made both commits in this
    // checkout, so even a sha an amend or force-push unhooked from the branch
    // is still on disk here.
    async diff(base, head) {
      const result = await git(["diff", `${base}..${head}`]);
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() || `git diff ${base}..${head} failed`,
        );
      }
      return result.stdout;
    },

    async discardCurrentWork(baseline) {
      if (arm.sandboxName) {
        const result = await run("bash", [
          "-c",
          DISCARD_WORK_SCRIPT,
          "vivarium-discard-work",
          baseline.branch,
          baseline.sha,
          JSON.stringify(baseline.localBranches),
          JSON.stringify(baseline.remoteBranches),
          baseline.slug ?? "",
          INTERRUPTED_PR_COMMENT,
        ]);
        if (result.code !== 0) {
          throw new Error(
            `could not discard interrupted work in ${checkoutLocation}: ${
              result.stderr.trim() ||
              result.stdout.trim() ||
              `bash exited ${result.code}`
            }`,
          );
        }
        const parsed = parseLastJsonLine<
          Partial<DiscardOutcome> & { errors?: unknown }
        >(result.stdout);
        if (
          !parsed ||
          typeof parsed.pullRequestClosed !== "boolean" ||
          typeof parsed.branchDeleted !== "boolean" ||
          !Array.isArray(parsed.errors)
        ) {
          throw new Error(
            `could not parse interrupted-work cleanup in ${checkoutLocation}`,
          );
        }
        const errors = parsed.errors.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
        );
        if (errors.length > 0) {
          throw new Error(
            `interrupted-work cleanup was incomplete in ${checkoutLocation}:\n${errors.join("\n")}`,
          );
        }
        return {
          branch:
            typeof parsed.branch === "string" ? parsed.branch : undefined,
          pullRequest:
            typeof parsed.pullRequest === "number"
              ? parsed.pullRequest
              : undefined,
          pullRequestClosed: parsed.pullRequestClosed,
          branchDeleted: parsed.branchDeleted,
        };
      }

      const branch = await sessionOwnedBranch(baseline);
      if (!branch) {
        return {
          pullRequestClosed: false,
          branchDeleted: false,
        };
      }

      const errors: string[] = [];
      let pullRequest: number | undefined;
      let pullRequestClosed = false;
      let branchDeleted = false;
      const pushedSha = await sessionPushedSha(branch);
      const listed = await gh([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,headRefOid,headRepository",
      ]);
      if (listed.code === 0) {
        const candidates = parseJson<
          Array<{
            number?: unknown;
            headRefOid?: unknown;
            headRepository?: { nameWithOwner?: unknown };
          }>
        >(listed.stdout);
        if (!candidates) {
          errors.push(
            `could not parse open pull requests for ${branch}`,
          );
        } else {
          const owned = candidates.filter(
            (candidate) =>
              typeof candidate.number === "number" &&
              candidate.headRefOid === pushedSha &&
              candidate.headRepository?.nameWithOwner === baseline.slug,
          );
          if (owned.length > 1) {
            errors.push(
              `interrupted-work ownership is ambiguous across ${owned.length} pull requests for ${branch}`,
            );
          } else if (owned.length === 1) {
            pullRequest = owned[0]!.number as number;
          }
        }
      } else {
        errors.push(
          `could not inspect open pull request for ${branch}: ${
            listed.stderr.trim() ||
            listed.stdout.trim() ||
            `gh exited ${listed.code}`
          }`,
        );
      }

      const credentials = credentialArgs(arm.ghToken);
      const remoteRef = `refs/heads/${branch}`;
      const remote = await git([
        ...credentials,
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        remoteRef,
      ]);
      let safeToClose = false;
      if (remote.code === 0) {
        const remoteSha = remote.stdout.trim().split(/\s+/, 1)[0];
        if (!remoteSha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(remoteSha)) {
          errors.push(
            `could not inspect remote branch ${branch}: git ls-remote returned an invalid object ID`,
          );
        } else if (!pushedSha) {
          errors.push(
            `could not prove ownership of remote branch ${branch}: no session push was recorded`,
          );
        } else if (remoteSha !== pushedSha) {
          errors.push(
            `remote branch ${branch} changed after this session pushed it; left it and its pull request untouched`,
          );
        } else {
          const deleted = await git([
            ...credentials,
            "push",
            `--force-with-lease=${remoteRef}:${pushedSha}`,
            "origin",
            `:${remoteRef}`,
          ]);
          if (deleted.code === 0) {
            branchDeleted = true;
            safeToClose = true;
          } else {
            errors.push(
              `could not safely delete remote branch ${branch}: ${
                deleted.stderr.trim() ||
                deleted.stdout.trim() ||
                `git exited ${deleted.code}`
              }`,
            );
          }
        }
      } else if (remote.code === 2) {
        if (pushedSha || pullRequest === undefined) {
          safeToClose = true;
        } else {
          errors.push(
            `could not prove ownership of pull request ${pullRequest}: no session push was recorded`,
          );
        }
      } else {
        errors.push(
          `could not inspect remote branch ${branch}: ${
            remote.stderr.trim() ||
            remote.stdout.trim() ||
            `git exited ${remote.code}`
          }`,
        );
      }

      if (safeToClose && pullRequest !== undefined) {
        const closed = await gh([
          "pr",
          "close",
          String(pullRequest),
          "--comment",
          INTERRUPTED_PR_COMMENT,
        ]);
        if (closed.code === 0) {
          pullRequestClosed = true;
        } else {
          errors.push(
            `could not close pull request ${pullRequest}: ${
              closed.stderr.trim() ||
              closed.stdout.trim() ||
              `gh exited ${closed.code}`
            }`,
          );
        }
      }

      if (errors.length > 0) {
        throw new Error(
          `interrupted-work cleanup was incomplete in ${checkoutLocation}:\n${errors.join("\n")}`,
        );
      }
      return {
        branch,
        pullRequest,
        pullRequestClosed,
        branchDeleted,
      };
    },

    async checkRuns(pullRequest) {
      const result = await gh([
        "pr",
        "view",
        String(pullRequest),
        "--json",
        "statusCheckRollup",
      ]);
      if (result.code !== 0) {
        throw new Error(
          `could not read checks for pull request ${pullRequest}: ${
            result.stderr.trim() ||
            result.stdout.trim() ||
            `gh exited ${result.code}`
          }`,
        );
      }
      const parsed = parseJson<{ statusCheckRollup?: GhStatusCheck[] }>(
        result.stdout,
      );
      if (!parsed || !Array.isArray(parsed.statusCheckRollup)) {
        throw new Error(
          `could not parse checks for pull request ${pullRequest}`,
        );
      }
      return parsed.statusCheckRollup.map((check) => ({
        name: check.name ?? check.context ?? "unknown",
        status: check.status ?? check.state ?? "UNKNOWN",
        startedAt: check.startedAt,
        completedAt: check.completedAt,
        createdAt: check.createdAt,
        detailsUrl: check.detailsUrl ?? check.targetUrl,
      }));
    },

    async postComment(pullRequest, body) {
      const result = await gh([
        "pr",
        "comment",
        String(pullRequest),
        "--body",
        body,
      ]);
      if (result.code !== 0) {
        throw new Error(
          `could not comment on pull request ${pullRequest}: ${
            result.stderr.trim() ||
            result.stdout.trim() ||
            `gh exited ${result.code}`
          }`,
        );
      }
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
    // []` into the run record — the close-reading input — with nothing anywhere
    // saying it was a gap. Callers decide what a failure means (a failed poll
    // is retried; a failed capture is recorded as unavailable), but only if
    // they can see it.
    async conversation(pullRequest) {
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

      if (arm.sandboxName) {
        // Isolated deployment validation requires a plain HTTPS GitHub clone
        // URL, so config already carries the same slug as origin. Reading the
        // remote again would be an entire extra sbx crossing per poll.
        const slug = slugFromRemote(arm.repo);
        if (!slug) {
          throw new Error(
            `could not resolve the configured remote for ${checkoutLocation} — conversation unread`,
          );
        }
        const result = await run("bash", [
          "-ceu",
          ISOLATED_CONVERSATION_SCRIPT,
          "vivarium-conversation",
          slug,
          String(pullRequest),
        ]);
        if (result.code !== 0) {
          throw new Error(
            `could not read the conversation of pull request ${pullRequest}: ${
              result.stderr.trim() ||
              result.stdout.trim() ||
              `bash exited ${result.code}`
            }`,
          );
        }
        const bundle = asConversationBundle(
          parseLastJsonLine<unknown>(result.stdout),
        );
        if (!bundle) {
          throw new Error(
            `could not parse the conversation of pull request ${pullRequest}`,
          );
        }
        return notesFromBundle(bundle);
      }

      const view = await api(
        ["pr", "view", String(pullRequest), "--json", "reviews"],
        "the reviews",
      );
      const reviews = parseJson<GhReviewsResponse>(view)?.reviews ?? [];

      const url = await remote();
      const slug = url ? slugFromRemote(url) : undefined;
      if (!slug) {
        // Only GitHub checkouts get here (see isGitHubCheckout), so a missing
        // slug is a transient git failure — and returning the reviews alone
        // would be the same silent partial capture the checks above exist to
        // prevent.
        throw new Error(
          `could not resolve the origin remote in ${checkoutLocation} — comments unread`,
        );
      }
      const issueComments =
        parseJson<GhComment[]>(
          await api(
            [
              "api",
              "--paginate",
              `repos/${slug}/issues/${pullRequest}/comments`,
            ],
            "the issue comments",
          ),
        ) ?? [];
      const inlineComments =
        parseJson<GhReviewComment[]>(
          await api(
            [
              "api",
              "--paginate",
              `repos/${slug}/pulls/${pullRequest}/comments`,
            ],
            "the inline comments",
          ),
        ) ?? [];

      const reactions: BundledReaction[] = [];
      const collect = async (
        comments: GhComment[],
        parentKind: "issue-comment" | "review-comment",
        endpoint: (id: number) => string,
      ): Promise<void> => {
        for (const comment of comments) {
          if (!comment.id || (comment.reactions?.total_count ?? 0) === 0) {
            continue;
          }
          const list =
            parseJson<GhReaction[]>(
              await api(
                ["api", "--paginate", endpoint(comment.id)],
                `reactions on comment ${comment.id}`,
              ),
            ) ?? [];
          for (const reaction of list) {
            reactions.push({ parentKind, parentId: comment.id, reaction });
          }
        }
      };
      await collect(
        issueComments,
        "issue-comment",
        (id) => `repos/${slug}/issues/comments/${id}/reactions`,
      );
      await collect(
        inlineComments,
        "review-comment",
        (id) => `repos/${slug}/pulls/comments/${id}/reactions`,
      );

      return notesFromBundle({
        reviews,
        issueComments,
        inlineComments,
        reactions,
      });
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

  if (arm.sandboxName) {
    const requireSlug = (): string => {
      const slug = slugFromRemote(arm.repo);
      if (!slug) {
        throw new Error(
          `could not resolve the configured remote for ${checkoutLocation}`,
        );
      }
      return slug;
    };

    api.afterAnswer = async (pullRequest, branch, reviewedSha, wantTrace) => {
      const result = await run("bash", [
        "-c",
        AFTER_ANSWER_SCRIPT,
        "vivarium-after-answer",
        requireSlug(),
        String(pullRequest),
        branch ?? "",
        reviewedSha ?? "",
        wantTrace ? "1" : "0",
      ]);
      if (result.code !== 0) {
        throw new Error(
          `the post-answer read of pull request ${pullRequest} failed: ${
            result.stderr.trim() ||
            result.stdout.trim() ||
            `bash exited ${result.code}`
          }`,
        );
      }
      const parsed = parseLastJsonLine<{
        sha?: unknown;
        diff?: unknown;
        diffError?: unknown;
        conversation?: unknown;
        conversationError?: unknown;
      }>(result.stdout);
      if (!parsed) {
        throw new Error(
          `could not parse the post-answer read of pull request ${pullRequest}`,
        );
      }
      const shaText = typeof parsed.sha === "string" ? parsed.sha.trim() : "";
      const bundle = asConversationBundle(parsed.conversation);
      return {
        sha: /^[0-9a-f]{7,40}$/i.test(shaText) ? shaText : undefined,
        diff: typeof parsed.diff === "string" ? parsed.diff : undefined,
        diffError:
          typeof parsed.diffError === "string" ? parsed.diffError : undefined,
        conversation: bundle ? notesFromBundle(bundle) : undefined,
        conversationError:
          typeof parsed.conversationError === "string"
            ? parsed.conversationError
            : undefined,
      };
    };

    api.finalizeMerge = async (pullRequest) => {
      const result = await run("bash", [
        "-c",
        FINALIZE_MERGE_SCRIPT,
        "vivarium-finalize-merge",
        requireSlug(),
        String(pullRequest),
        PULL_REQUEST_FIELDS,
      ]);
      if (result.code !== 0) {
        throw new Error(
          `the merge of pull request ${pullRequest} could not be finalized: ${
            result.stderr.trim() ||
            result.stdout.trim() ||
            `bash exited ${result.code}`
          }`,
        );
      }
      const parsed = parseLastJsonLine<{
        merge?: { code?: unknown; stdout?: unknown; stderr?: unknown };
        view?: {
          state?: unknown;
          mergedAt?: unknown;
          mergeCommit?: { oid?: unknown };
        } | null;
        conversation?: unknown;
        conversationError?: unknown;
        refreshed?: Record<string, unknown> | null;
      }>(result.stdout);
      // The bundle must at least say how the merge command exited: without
      // that, "merged" cannot be decided at all, and the caller's discrete
      // fallback re-runs the merge — which is safe, because merging an
      // already-merged pull request fails while its state still reads MERGED.
      if (!parsed || typeof parsed.merge?.code !== "number") {
        throw new Error(
          `could not parse the merge state of pull request ${pullRequest}`,
        );
      }
      const view =
        parsed.view && typeof parsed.view === "object" ? parsed.view : undefined;
      const state = typeof view?.state === "string" ? view.state : undefined;
      const merged = view ? state === "MERGED" : parsed.merge.code === 0;
      const mergeStderr =
        typeof parsed.merge.stderr === "string" ? parsed.merge.stderr : "";
      const mergeStdout =
        typeof parsed.merge.stdout === "string" ? parsed.merge.stdout : "";
      const bundle = asConversationBundle(parsed.conversation);
      const refreshed =
        parsed.refreshed &&
        typeof parsed.refreshed === "object" &&
        typeof parsed.refreshed.number === "number"
          ? toRef(parsed.refreshed)
          : undefined;
      return {
        merge: {
          merged,
          method: "merge",
          mergedAt:
            typeof view?.mergedAt === "string" ? view.mergedAt : undefined,
          commit:
            typeof view?.mergeCommit?.oid === "string"
              ? view.mergeCommit.oid
              : undefined,
          error: merged
            ? view
              ? undefined
              : "merge reported success but its state could not be re-read — mergedAt and commit are missing, not absent"
            : mergeStderr.trim() ||
              mergeStdout.trim() ||
              `pull request ${pullRequest} is ${state ?? "not merged"}`,
        },
        conversation: bundle ? notesFromBundle(bundle) : undefined,
        conversationError:
          typeof parsed.conversationError === "string"
            ? parsed.conversationError
            : undefined,
        refreshed,
      };
    };
  }

  return api;
}

function toRef(value: Record<string, unknown>): PullRequestRef {
  const rollup = value.statusCheckRollup;
  const count = (churn: unknown): number | undefined =>
    typeof churn === "number" && Number.isFinite(churn) ? churn : undefined;
  return {
    number: Number(value.number ?? 0),
    url: String(value.url ?? ""),
    title: String(value.title ?? ""),
    headRefName: String(value.headRefName ?? ""),
    state: String(value.state ?? "UNKNOWN"),
    checks: Array.isArray(rollup)
      ? summarizeChecks(rollup as Record<string, unknown>[])
      : undefined,
    additions: count(value.additions),
    deletions: count(value.deletions),
    changedFiles: count(value.changedFiles),
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
