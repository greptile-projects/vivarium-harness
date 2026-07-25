import type { ArmConfig, ArmName, HarnessConfig } from "./config.js";
import type {
  ArmGitHub,
  Baseline,
  MergeOutcome,
  PullRequestRef,
  ReviewNote,
} from "./github.js";
import { pullRequestUrl } from "./github.js";
import type { StreamResult } from "./live/stream.js";
import { reviewPrompt } from "./prompt.js";

// What happens to an arm's work *after* its Codex session says it is done: find
// the pull request it opened, make the reviewed arm answer its review on the
// record, then merge. Until this existed the arms opened pull requests nobody
// read and nobody merged, so every subticket started from the same commit as
// the one before it and Greptile's comments went into a void — the experiment's
// whole variable, unwired.
//
// Both arms go through the identical path. The reviewed arm's extra rounds are
// the only difference, and they come from `arm.reviewer` being set, not from a
// name check here.

export interface ReviewRound {
  round: number;
  reviewer: string;
  // How long this round waited for the reviewer before it either got something
  // or gave up. Worth recording: "how long did review hold the climb" is one of
  // the numbers the experiment is for.
  waitedMs: number;
  timedOut: boolean;
  // What appeared from the reviewer this round. Recorded for the record only —
  // the arm is never handed these; it fetches its own review.
  found: ReviewNote[];
  // The branch head before and after the arm answered. `reviewedSha` is the
  // commit the review was written against, pinned before the arm can move the
  // ref; without it a force-push would erase the only diff that shows what the
  // review changed. The pair also answers, with no text analysis at all,
  // whether the arm pushed a fix or merely replied.
  reviewedSha?: string;
  respondedSha?: string;
  respondedAt?: string;
  response?: string;
  error?: string;
}

export type LandingStatus =
  // The pull request was merged (possibly after review rounds).
  | "merged"
  // Not a GitHub checkout, or landing is off (the demo).
  | "skipped"
  // The arm's session failed, so there is nothing to land.
  | "not-attempted"
  // The session succeeded but no pull request exists — the deliverable is
  // missing, and the arm is failed for it.
  | "no-pull-request"
  | "merge-failed";

export interface LandingRecord {
  arm: ArmName;
  status: LandingStatus;
  startedAt: string;
  completedAt: string;
  branch?: string;
  pullRequest?: PullRequestRef;
  reviewer?: string;
  reviewRounds: ReviewRound[];
  // Every comment on the pull request at merge time, from either side. This is
  // the close-reading input: the reviewer's findings and the arm's answers,
  // in one chronological list.
  conversation: ReviewNote[];
  merge?: MergeOutcome;
  notes: string[];
}

export interface LandDeps {
  github: ArmGitHub;
  // Continue this arm's Codex thread with another turn. Injected because it is
  // the same session the harness already owns — a review answer must land in
  // the same thread as the work it is defending.
  reply: (prompt: string) => Promise<StreamResult>;
  note: (text: string) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

export function landingSummary(record: LandingRecord): string {
  const pr = record.pullRequest;
  const rounds = record.reviewRounds.length;
  const answered = record.reviewRounds.filter(
    (round) => round.response !== undefined,
  ).length;
  const where = pr ? `#${pr.number}` : "no pull request";
  switch (record.status) {
    case "merged":
      return rounds > 0
        ? `merged ${where} after ${answered}/${rounds} answered review round(s)`
        : `merged ${where}`;
    case "merge-failed":
      return `merge of ${where} failed: ${record.merge?.error ?? "unknown error"}`;
    case "no-pull-request":
      return "the session finished without opening a pull request";
    case "not-attempted":
      return "session failed — nothing to land";
    case "skipped":
      return "landing skipped (not a GitHub checkout)";
  }
}

// Put an arm's checkout back on origin's default branch before it starts, so
// every subticket begins from the commit the previous one merged. Returns
// undefined for a checkout that is not a GitHub clone (the demo's temp dirs).
export async function prepareArm(
  arm: ArmConfig,
  config: HarnessConfig,
  deps: Pick<LandDeps, "github" | "note">,
): Promise<Baseline | undefined> {
  if (!config.land) return undefined;
  if (!(await deps.github.isGitHubCheckout())) {
    deps.note("not a GitHub checkout — skipping baseline sync");
    return undefined;
  }
  const baseline = await deps.github.syncToBaseline();
  deps.note(
    `baseline ${baseline.branch} @ ${baseline.sha.slice(0, 7)}${
      baseline.slug ? ` (${baseline.slug})` : ""
    }`,
  );
  return baseline;
}

// Wait for something new from the reviewer, or give up. Polls the whole
// conversation rather than a cursor: comment ids are the only durable identity
// here, and a review that arrives as three comments at once should count once.
async function waitForReview(
  deps: LandDeps,
  pullRequest: number,
  reviewer: string,
  seen: Set<string>,
  timeoutMs: number,
  pollMs: number,
): Promise<{
  found: ReviewNote[];
  conversation: ReviewNote[];
  waitedMs: number;
  timedOut: boolean;
}> {
  const start = deps.now();
  for (;;) {
    const conversation = await deps.github.conversation(pullRequest);
    const found = conversation.filter(
      (note) => note.author === reviewer && !seen.has(note.id),
    );
    if (found.length > 0) {
      return { found, conversation, waitedMs: deps.now() - start, timedOut: false };
    }
    if (deps.now() - start >= timeoutMs) {
      return { found: [], conversation, waitedMs: deps.now() - start, timedOut: true };
    }
    await deps.wait(pollMs);
  }
}

export async function landArm(
  arm: ArmConfig,
  config: HarnessConfig,
  // The arm's own final message — where it reports the pull request it opened.
  session: { status: "succeeded" | "failed"; output?: string },
  deps: LandDeps,
): Promise<LandingRecord> {
  const startedAt = new Date().toISOString();
  const notes: string[] = [];
  const note = (text: string): void => {
    notes.push(text);
    deps.note(text);
  };
  const done = (
    status: LandingStatus,
    rest: Partial<LandingRecord> = {},
  ): LandingRecord => ({
    arm: arm.name,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    reviewer: arm.reviewer,
    reviewRounds: [],
    conversation: [],
    notes,
    ...rest,
  });

  if (session.status === "failed") return done("not-attempted");
  if (!config.land) return done("skipped");
  if (!(await deps.github.isGitHubCheckout())) return done("skipped");

  const branch = await deps.github.currentBranch();
  const reported = pullRequestUrl(session.output);
  const pullRequest = await deps.github.findPullRequest({
    url: reported,
    branch,
  });

  if (!pullRequest) {
    note(
      `no pull request found${branch ? ` for branch ${branch}` : ""} — nothing to merge`,
    );
    return done("no-pull-request", { branch });
  }
  note(`pull request #${pullRequest.number} — ${pullRequest.url}`);

  const reviewRounds: ReviewRound[] = [];
  const seen = new Set<string>();

  if (arm.reviewer) {
    for (let round = 1; round <= config.reviewRounds; round += 1) {
      note(`waiting for ${arm.reviewer} on #${pullRequest.number}…`);
      const waited = await waitForReview(
        deps,
        pullRequest.number,
        arm.reviewer,
        seen,
        config.reviewTimeoutMs,
        config.reviewPollMs,
      );

      if (waited.timedOut) {
        reviewRounds.push({
          round,
          reviewer: arm.reviewer,
          waitedMs: waited.waitedMs,
          timedOut: true,
          found: [],
        });
        note(
          round === 1
            ? `no review within ${Math.round(config.reviewTimeoutMs / 1000)}s — merging unreviewed`
            : "no further review — done answering",
        );
        break;
      }

      note(
        `${waited.found.length} new comment(s) from ${arm.reviewer} — sending the arm back to answer them`,
      );
      // Everything visible now counts as seen, including the arm's own replies:
      // the next round is only interested in what the reviewer says *after*
      // this answer.
      for (const entry of waited.conversation) seen.add(entry.id);

      // Pinned before the arm touches the branch. If it amends or force-pushes
      // to address a comment, this is the only remaining handle on the code the
      // review was actually written against.
      const reviewedSha = await deps.github.headSha(
        pullRequest.number,
        pullRequest.headRefName,
      );

      const answer = await deps.reply(
        reviewPrompt(pullRequest.url, round, config.reviewRounds),
      );
      // And after: the pair is what says whether the arm pushed a fix or only
      // replied. Equal shas mean it argued and changed nothing.
      const respondedSha = await deps.github.headSha(
        pullRequest.number,
        pullRequest.headRefName,
      );

      // A missing sha is recorded as a missing sha, never left to be inferred.
      // The round still counts — the arm did answer, and failing it over a
      // bookkeeping read would cost the rung — but an absent field otherwise
      // reads identically to a run made before these were captured at all, and
      // an analysis would silently treat the gap as "the arm changed nothing".
      const missing = [
        reviewedSha ? undefined : "reviewedSha",
        respondedSha ? undefined : "respondedSha",
      ].filter(Boolean);
      if (missing.length > 0) {
        note(
          `could not read the branch head on #${pullRequest.number} (${missing.join(", ")}) — round ${round} recorded without it`,
        );
      }
      reviewRounds.push({
        round,
        reviewer: arm.reviewer,
        waitedMs: waited.waitedMs,
        timedOut: false,
        found: waited.found,
        reviewedSha,
        respondedSha,
        respondedAt: new Date().toISOString(),
        response: answer.output,
        error: answer.isError ? answer.output : undefined,
      });

      if (answer.isError) {
        note("the arm failed to answer the review — merging what it has");
        break;
      }
    }
  }

  const merge = await deps.github.merge(pullRequest.number);
  const conversation = await deps.github.conversation(pullRequest.number);

  if (!merge.merged) {
    note(`merge failed: ${merge.error ?? "unknown error"}`);
    return done("merge-failed", {
      branch,
      pullRequest,
      reviewRounds,
      conversation,
      merge,
    });
  }

  note(`merged #${pullRequest.number}`);
  return done("merged", {
    branch,
    pullRequest,
    reviewRounds,
    conversation,
    merge,
  });
}

// A subticket's deliverable is a merged pull request, so a session that opened
// none — or whose pull request could not be merged — is a failed arm however
// cheerful its final message was. Greg halts on that and leaves the box
// unchecked, which is the point: a rung that did not land must not look built.
export function landingError(record: LandingRecord): string | undefined {
  if (record.status === "no-pull-request") {
    return "the session reported success but opened no pull request";
  }
  if (record.status === "merge-failed") {
    return `pull request ${record.pullRequest?.number ?? "?"} could not be merged: ${
      record.merge?.error ?? "unknown error"
    }`;
  }
  return undefined;
}
