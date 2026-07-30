import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../harness/artifacts.js";
import { RESULTS_DIR } from "../harness/config.js";
import {
  runCommand,
  type CommandRunner,
  type ReviewNote,
} from "../harness/github.js";
import { reviewRevision } from "../harness/land.js";

// The Komodo counterfactual's durable record. Greptile reviews Komodo's work
// in the private mirror (`scripts/mirror_sync.sh`), not on Komodo's own pull
// requests, so nothing in `run.json` captures those reviews — the landing's
// `conversation` is empty by design. Tuatara's side gets the equivalent data
// through `land.ts`, including `conversationRevisions`, because Greptile edits
// its PR-level overview (and confidence score) in place and only an observer
// that keeps every revision preserves the trajectory. This module is that
// observer for the mirror: each run re-reads every mirror pull request and
// files it under `results/mirror/pr-NNNN.json`, replacing the `conversation`
// snapshot and *accumulating* revisions under the same `reviewRevision` rule
// `land.ts` uses, so the two arms' review histories stay comparable note for
// note. Run it on a schedule while the experiment is live — the edits it
// exists to catch are only cheap to read before GitHub buries them in the
// edit-history API.
//
// Reads talk to the GitHub API by repo slug rather than through `ArmGitHub`:
// the mirror has no checkout on this machine, and must not gain one — a clone
// would be a second copy of Komodo's tree lying around for the sake of a
// read-only record.

export interface MirrorPullRequest {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

// Where the mirror state came from, parsed out of the provenance lines
// `mirror_sync.sh` writes into every mirror PR body. This is the join key back
// to Komodo's own pull request — the analysis pairs a subticket's Tuatara
// review with its Komodo counterfactual through it.
export interface MirrorSource {
  pullRequest?: number;
  url?: string;
  sha?: string;
}

export interface MirrorPullRecord {
  schemaVersion: 1;
  slug: string;
  pullRequest: MirrorPullRequest;
  source?: MirrorSource;
  capturedAt: string;
  conversation: ReviewNote[];
  conversationRevisions: ReviewNote[];
}

export interface MirrorSnapshotOptions {
  slug: string;
  directory: string;
  exec?: CommandRunner;
  // Token with read access to the private mirror. Optional: without it `gh`
  // falls back to its ambient login, which suits a manual run on a machine
  // already authenticated as an account that can see the mirror.
  token?: string;
  log?: (line: string) => void;
}

export interface MirrorSnapshotSummary {
  pulls: number;
  newRevisions: number;
  // One entry per pull request that could not be recorded. The others are
  // still written: a rate limit halfway through must not cost the whole pass.
  errors: string[];
}

interface GhPullListItem {
  number?: number;
}

interface GhPull {
  number?: number;
  html_url?: string;
  title?: string;
  state?: string;
  body?: string;
  head?: { ref?: string };
  created_at?: string;
  updated_at?: string;
  merged_at?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

interface GhReview {
  id?: number;
  user?: { login?: string };
  body?: string;
  state?: string;
  submitted_at?: string;
  html_url?: string;
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

export function recordFileName(pullRequest: number): string {
  return `pr-${String(pullRequest).padStart(4, "0")}.json`;
}

export function parseSource(body: string | undefined): MirrorSource | undefined {
  if (!body) return undefined;
  const pr = /^Source PR: #(\d+) — (\S+)$/m.exec(body);
  const sha = /^Source SHA: ([0-9a-f]{7,40})$/m.exec(body);
  if (!pr && !sha) return undefined;
  return {
    pullRequest: pr ? Number(pr[1]) : undefined,
    url: pr?.[2],
    sha: sha?.[1],
  };
}

export async function snapshotMirror(
  options: MirrorSnapshotOptions,
): Promise<MirrorSnapshotSummary> {
  const exec = options.exec ?? runCommand;
  const log = options.log ?? (() => {});
  const env = options.token
    ? { GH_TOKEN: options.token, GITHUB_TOKEN: options.token }
    : undefined;

  // Every call checks its exit code and throws, for the same reason
  // `conversation` in github.ts does: an empty list from a failed read is
  // indistinguishable from a quiet reviewer, and this file *is* the record.
  const api = async (path: string, what: string): Promise<string> => {
    const result = await exec("gh", ["api", "--paginate", path], { env });
    if (result.code !== 0) {
      throw new Error(
        `could not read ${what}: ${
          result.stderr.trim() ||
          result.stdout.trim() ||
          `gh exited ${result.code}`
        }`,
      );
    }
    return result.stdout;
  };
  const apiJson = async <T>(path: string, what: string): Promise<T> => {
    const stdout = await api(path, what);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new Error(`could not parse ${what}`);
    }
  };

  const slug = options.slug;
  await mkdir(options.directory, { recursive: true });

  const listed = await apiJson<GhPullListItem[]>(
    `repos/${slug}/pulls?state=all&per_page=100`,
    `the pull requests of ${slug}`,
  );
  const numbers = listed
    .map((pull) => pull.number)
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right);

  const summary: MirrorSnapshotSummary = {
    pulls: numbers.length,
    newRevisions: 0,
    errors: [],
  };

  for (const number of numbers) {
    try {
      const written = await snapshotOne(number);
      summary.newRevisions += written.newRevisions;
      log(
        `pr #${number}: ${written.notes} note(s), ${written.newRevisions} new revision(s)`,
      );
    } catch (error) {
      const message = `pr #${number}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      summary.errors.push(message);
      log(message);
    }
  }
  return summary;

  async function snapshotOne(
    number: number,
  ): Promise<{ notes: number; newRevisions: number }> {
    const detail = await apiJson<GhPull>(
      `repos/${slug}/pulls/${number}`,
      `mirror pull request ${number}`,
    );
    const conversation = await readConversation(number);

    const file = join(options.directory, recordFileName(number));
    // An unreadable existing record fails this pull request rather than being
    // overwritten: the accumulated revisions exist nowhere else, and replacing
    // a corrupt file with a fresh snapshot would destroy them silently. The
    // opposite of state.ts's fail-open reads, because this read gates a write.
    const previous = await readExisting(file);

    const observed = new Map(
      (previous?.conversationRevisions ?? []).map((note) => [
        reviewRevision(note),
        note,
      ]),
    );
    const before = observed.size;
    for (const note of conversation) {
      observed.set(reviewRevision(note), note);
    }

    const record: MirrorPullRecord = {
      schemaVersion: 1,
      slug,
      pullRequest: {
        number,
        url: detail.html_url ?? "",
        title: detail.title ?? "",
        headRefName: detail.head?.ref ?? "",
        state: detail.merged_at ? "MERGED" : (detail.state ?? "").toUpperCase(),
        createdAt: detail.created_at,
        updatedAt: detail.updated_at,
        mergedAt: detail.merged_at ?? undefined,
        additions: detail.additions,
        deletions: detail.deletions,
        changedFiles: detail.changed_files,
      },
      source: parseSource(detail.body),
      capturedAt: new Date().toISOString(),
      conversation,
      conversationRevisions: [...observed.values()],
    };
    await atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`);
    return {
      notes: conversation.length,
      newRevisions: observed.size - before,
    };
  }

  async function readExisting(
    file: string,
  ): Promise<MirrorPullRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    let parsed: MirrorPullRecord;
    try {
      parsed = JSON.parse(raw) as MirrorPullRecord;
    } catch {
      throw new Error(`existing record ${file} is unreadable — not overwriting it`);
    }
    return parsed;
  }

  // The same conversation `ArmGitHub.conversation` assembles for Tuatara's
  // pull requests, addressed by slug because there is no checkout. Note ids
  // keep the identical `kind:id` format so the two records read as one corpus.
  async function readConversation(number: number): Promise<ReviewNote[]> {
    const notes: ReviewNote[] = [];

    const reviews = await apiJson<GhReview[]>(
      `repos/${slug}/pulls/${number}/reviews`,
      `the reviews of mirror pull request ${number}`,
    );
    for (const review of reviews) {
      notes.push({
        id: `review:${review.id ?? notes.length}`,
        kind: "review",
        author: review.user?.login ?? "unknown",
        body: review.body ?? "",
        createdAt: review.submitted_at ?? "",
        url: review.html_url,
        state: review.state,
      });
    }

    const addReactions = async (
      comment: GhComment,
      parentKind: "issue-comment" | "review-comment",
      endpoint: string,
    ): Promise<void> => {
      if (!comment.id || (comment.reactions?.total_count ?? 0) === 0) return;
      const reactions = await apiJson<GhReaction[]>(
        endpoint,
        `reactions on comment ${comment.id}`,
      );
      for (const reaction of reactions) {
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

    const issueComments = await apiJson<GhComment[]>(
      `repos/${slug}/issues/${number}/comments`,
      `the issue comments of mirror pull request ${number}`,
    );
    for (const comment of issueComments) {
      notes.push({
        id: `issue-comment:${comment.id ?? notes.length}`,
        kind: "issue-comment",
        author: comment.user?.login ?? "unknown",
        body: comment.body ?? "",
        createdAt: comment.created_at ?? "",
        updatedAt: comment.updated_at,
        url: comment.html_url,
      });
      await addReactions(
        comment,
        "issue-comment",
        `repos/${slug}/issues/comments/${comment.id}/reactions`,
      );
    }

    const inline = await apiJson<GhReviewComment[]>(
      `repos/${slug}/pulls/${number}/comments`,
      `the inline comments of mirror pull request ${number}`,
    );
    for (const comment of inline) {
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
      await addReactions(
        comment,
        "review-comment",
        `repos/${slug}/pulls/comments/${comment.id}/reactions`,
      );
    }

    return notes.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }
}

if (import.meta.main) {
  const slug = process.env.MIRROR_REPO || "makors/vivarium-komodo-mirror";
  const summary = await snapshotMirror({
    slug,
    // One directory per mirror: the production pair and the disposable test
    // pair are distinct repos whose PR numbers would otherwise collide.
    directory: join(RESULTS_DIR, "mirror", slug.replace("/", "__")),
    token: process.env.MIRROR_SNAPSHOT_TOKEN || undefined,
    log: (line) => console.log(line),
  });
  console.log(
    `${summary.pulls} mirror pull request(s), ${summary.newRevisions} new revision(s)` +
      (summary.errors.length ? `, ${summary.errors.length} error(s)` : ""),
  );
  if (summary.errors.length > 0) process.exit(1);
}
