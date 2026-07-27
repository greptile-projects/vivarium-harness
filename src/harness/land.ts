import type { ArmConfig, ArmName, HarnessConfig } from "./config.js";
import type {
  ArmGitHub,
  Baseline,
  CommitRef,
  MergeOutcome,
  PullRequestRef,
  ReviewNote,
} from "./github.js";
import { pullRequestUrl } from "./github.js";
import type { StreamResult, TokenUsage } from "./session.js";
import { reviewPrompt } from "./prompts.js";

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
  // The instruction the arm was handed this round, and what it said back. The
  // answer alone is half a record: `reviewPrompt` has changed before and will
  // again, and a reply reads differently depending on whether the arm was told
  // this was its last round.
  prompt?: string;
  response?: string;
  // What the round cost. Cumulative for the arm's thread — see TokenUsage.
  usage?: TokenUsage;
  error?: string;
  // The reviewer came back with nothing to answer — an approval, a thumbs-up,
  // "no further comments". The arm was not sent back for this round, and the
  // exchange ended here. Recorded rather than inferred from an empty `response`,
  // which is also what an errored answer turn leaves behind.
  signedOff?: boolean;
}

// Words an acknowledgement can be built entirely out of. Anything else in a
// note means the reviewer is still saying something.
const ACKNOWLEDGEMENT_WORDS = new Set([
  "ack", "acknowledged", "add", "additional", "addressed", "agreed", "all",
  "and", "approval", "approve", "approved", "approving", "are", "cheers",
  "comment", "comments", "concern", "concerns", "feedback", "found", "further",
  "good", "great", "here", "is", "issue", "issues", "left", "lgtm", "looks",
  "makes", "me", "merge", "more", "my", "new", "nice", "no", "none", "nothing",
  "perfect", "pr", "ready", "remaining", "requested", "resolved", "sense",
  "ship", "sounds", "thank", "thanks", "the", "this", "to", "you",
]);

// A note reduced to its words: markdown decoration, hidden HTML bookkeeping,
// emoji and punctuation removed. A fenced block becomes the word "code" rather
// than vanishing — a suggestion block with no prose around it is still the
// reviewer asking for a change.
function plainWords(body: string): string[] {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  return text.split(/\s+/).filter(Boolean);
}

// Does this note ask the arm for anything? A round exists to hand the arm
// something to answer, and an approval, a 👍 on a reply, or "no further
// comments" asks for nothing: sending the arm back for it would spend a review
// round producing acknowledgements of an acknowledgement.
//
// The classifier is deliberately biased toward "yes". A real comment mistaken
// for an acknowledgement is never shown to the arm at all — a review comment
// silently dropped from an experiment about answering review comments. An
// acknowledgement mistaken for a comment costs one bounded round. So only a
// short note built *entirely* out of acknowledgement words is dismissed;
// everything else is something to answer.
export function asksSomething(note: ReviewNote): boolean {
  // A reaction is an acknowledgement of its parent comment, never a new
  // request. Its author is still preserved so only the configured reviewer can
  // settle the wait with it.
  if (note.kind === "reaction") return false;
  const words = plainWords(note.body);
  if (words.length === 0) return false;
  if (words.length > 10) return true;
  return !words.every((word) => ACKNOWLEDGEMENT_WORDS.has(word));
}

// True when everything new from the reviewer this round is acknowledgement —
// the thumbs-up end of "it either comments back or it thumbs up".
export function reviewerSignedOff(found: ReviewNote[]): boolean {
  return found.length > 0 && !found.some(asksSomething);
}

export type LandingStatus =
  // The pull request was merged (possibly after review rounds).
  | "merged"
  // Not a GitHub checkout, or landing is off for this run.
  | "skipped"
  // The arm's session failed, so there is nothing to land.
  | "not-attempted"
  // The session succeeded but no pull request exists — the deliverable is
  // missing, and the arm is failed for it.
  | "no-pull-request"
  | "merge-failed"
  // Reviewed and mergeable, but not merged yet — the transient state between
  // the review phase and the merge phase.
  | "ready"
  // Mergeable, but the *other* arm was not, so this one was deliberately left
  // unmerged. Merging it alone would put the two codebases permanently out of
  // step on a rung only one arm ever built, which is worse than losing the rung.
  | "blocked";

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
  // What the arm actually changed. Captured before the merge, so the record can
  // show the work without GitHub having to still serve the branch — the diff
  // lands beside `land.json` as `pull-request.diff` rather than inside it,
  // because a four-thousand-line patch encoded as a JSON string is not something
  // anyone can close-read.
  commits?: CommitRef[];
  diff?: string;
  // Where that patch was written. Filled in by `RunArtifacts.recordLanding`,
  // which is the only thing here that knows about disk.
  diffFile?: string;
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
  // Preserve an explicit reviewer sign-off in the human-readable summary.
  const last = record.reviewRounds.at(-1);
  const ended = last?.signedOff ? `, ${last.reviewer} signed off` : "";
  switch (record.status) {
    case "merged":
      return rounds > 0
        ? `merged ${where} after ${answered}/${rounds} answered review round(s)${ended}`
        : `merged ${where}`;
    case "merge-failed":
      return `merge of ${where} failed: ${record.merge?.error ?? "unknown error"}`;
    case "no-pull-request":
      return "the session finished without opening a pull request";
    case "not-attempted":
      return "session failed — nothing to land";
    case "skipped":
      return "landing skipped (not a GitHub checkout)";
    case "blocked":
      return `${where} held back — the other arm did not land, so neither merged`;
    case "ready":
      return `${where} reviewed and ready, not yet merged`;
  }
}

// Put an arm's checkout back on origin's default branch before it starts, so
// every subticket begins from the commit the previous one merged. Returns
// undefined for a checkout that is not a GitHub clone.
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
  debounceMs: number,
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
      if (debounceMs <= 0) {
        return { found, conversation, waitedMs: deps.now() - start, timedOut: false };
      }

      // A submitted review reaches GitHub as a review body, root comments,
      // replies and reactions that may become visible a few seconds apart.
      // Keep resetting a short quiet window while new reviewer entries arrive,
      // then hand the complete batch to one Codex turn.
      let settledConversation = conversation;
      let settledFound = found;
      let ids = new Set(found.map((entry) => entry.id));
      for (;;) {
        await deps.wait(debounceMs);
        settledConversation = await deps.github.conversation(pullRequest);
        settledFound = settledConversation.filter(
          (note) => note.author === reviewer && !seen.has(note.id),
        );
        const grew = settledFound.some((entry) => !ids.has(entry.id));
        if (!grew) {
          return {
            found: settledFound,
            conversation: settledConversation,
            waitedMs: deps.now() - start,
            timedOut: false,
          };
        }
        ids = new Set(settledFound.map((entry) => entry.id));
      }
    }
    if (deps.now() - start >= timeoutMs) {
      return { found: [], conversation, waitedMs: deps.now() - start, timedOut: true };
    }
    await deps.wait(pollMs);
  }
}

// Phase one of landing: find the arm's pull request and run its review rounds.
// Everything here is reversible — it reads GitHub and adds comments, and never
// touches either arm's main. It stops one step short of the merge so the
// harness can hold a barrier between the two (see `mergeArm`).
export async function reviewArm(
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
        config.reviewDebounceMs,
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

      const found = waited.found;
      const conversation = waited.conversation;

      // Everything visible now counts as seen, including the arm's own replies:
      // the next round is only interested in what the reviewer says *after*
      // this answer.
      for (const entry of conversation) seen.add(entry.id);

      // The thumbs-up branch. The reviewer said something, but nothing that
      // asks the arm for anything, so there is no round to run: the exchange
      // is over and the pull request goes to merge.
      if (reviewerSignedOff(found)) {
        reviewRounds.push({
          round,
          reviewer: arm.reviewer,
          waitedMs: waited.waitedMs,
          timedOut: false,
          found,
          signedOff: true,
        });
        note(
          `${arm.reviewer} came back with nothing to answer — the review is settled`,
        );
        break;
      }

      note(
        `${found.length} new comment(s) from ${arm.reviewer} — sending the arm back to answer them`,
      );

      // Pinned before the arm touches the branch. If it amends or force-pushes
      // to address a comment, this is the only remaining handle on the code the
      // review was actually written against.
      const reviewedSha = await deps.github.headSha(
        pullRequest.number,
        pullRequest.headRefName,
      );

      const instruction = reviewPrompt(
        pullRequest.url,
        round,
        config.reviewRounds,
      );
      const answer = await deps.reply(instruction);
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
        found,
        reviewedSha,
        respondedSha,
        respondedAt: new Date().toISOString(),
        // What the arm was handed. `reviewPrompt` has changed before and a
        // reply reads differently depending on whether the arm was told this
        // was its last round.
        prompt: instruction,
        // `response` is what the arm *said*; a session that errored said
        // nothing. Setting it unconditionally made every non-timed-out round
        // count as answered — including one whose Codex turn died on spawn —
        // so `answered` could never disagree with `rounds` and the headline
        // "did the reviewed arm engage with its review" was not measuring
        // engagement at all. The failure text is still kept, as `error`.
        response: answer.isError ? undefined : answer.output,
        usage: answer.usage,
        error: answer.isError ? answer.output : undefined,
      });

      if (answer.isError) {
        note("the arm failed to answer the review — merging what it has");
        break;
      }
    }
  }

  // Captured here, at the end of review: every arm reaches this point, it is
  // strictly before any merge (the barrier runs after both reviews), and
  // `--delete-branch` will remove the head ref — so an arm that ends up blocked
  // by its peer still keeps the record of what it built.
  const commits = await deps.github.commits(pullRequest.number);
  const diff = await deps.github.diff(pullRequest.number);

  return done("ready", { branch, pullRequest, reviewRounds, commits, diff });
}

// Phase two: the irreversible step. Only a "ready" record merges; anything else
// passes through untouched, which is what lets the harness convert a peer's
// failure into "blocked" and hand the whole set here without special-casing.
export async function mergeArm(
  record: LandingRecord,
  deps: Pick<LandDeps, "github" | "note">,
): Promise<LandingRecord> {
  if (record.status !== "ready" || !record.pullRequest) return record;

  const notes = [...record.notes];
  const note = (text: string): void => {
    notes.push(text);
    deps.note(text);
  };

  const merge = await deps.github.merge(record.pullRequest.number);
  const conversation = await deps.github.conversation(
    record.pullRequest.number,
  );


  if (!merge.merged) {
    note(`merge failed: ${merge.error ?? "unknown error"}`);
    return {
      ...record,
      status: "merge-failed",
      completedAt: new Date().toISOString(),
      conversation,
      merge,
      notes,
    };
  }

  note(`merged #${record.pullRequest.number}`);
  return {
    ...record,
    status: "merged",
    completedAt: new Date().toISOString(),
    conversation,
    merge,
    notes,
  };
}

// Mark a mergeable arm as deliberately not merged, because a peer arm was not
// mergeable. The conversation is still captured — the review happened and is
// worth reading even though the rung is being abandoned.
export async function blockArm(
  record: LandingRecord,
  reason: string,
  deps: Pick<LandDeps, "github" | "note">,
): Promise<LandingRecord> {
  if (record.status !== "ready") return record;

  const note = `not merged: ${reason}`;
  deps.note(note);
  const conversation = record.pullRequest
    ? await deps.github.conversation(record.pullRequest.number).catch(() => [])
    : [];
  return {
    ...record,
    status: "blocked",
    completedAt: new Date().toISOString(),
    conversation,
    notes: [...record.notes, note],
  };
}

// The whole landing for one arm, review then merge, with no barrier between.
// Kept for the one-ticket path, where there is no peer to stay in step with.
export async function landArm(
  arm: ArmConfig,
  config: HarnessConfig,
  session: { status: "succeeded" | "failed"; output?: string },
  deps: LandDeps,
): Promise<LandingRecord> {
  return mergeArm(await reviewArm(arm, config, session, deps), deps);
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
  // Nothing is wrong with this arm's own work — the rung still did not land,
  // and it must not look built.
  if (record.status === "blocked") {
    return "held back so the arms stay in step: the other arm did not land";
  }
  if (record.status === "ready") {
    return "landing did not finish — the merge phase never ran";
  }
  return undefined;
}
