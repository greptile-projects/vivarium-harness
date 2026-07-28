import type { ArmPhase } from "./arms.js";
import type { ArmConfig, ArmName, HarnessConfig } from "./config.js";
import type {
  ArmGitHub,
  Baseline,
  MergeOutcome,
  PullRequestRef,
  ReviewNote,
} from "./github.js";
import { pullRequestUrl, sameLogin } from "./github.js";
import type { StreamResult } from "./session.js";
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
  response?: string;
  error?: string;
  // The reviewer reacted with a thumbs-up. The arm was not sent back for this
  // round, and the exchange ended here. Recorded rather than inferred from an
  // empty `response`, which is also what an errored answer turn leaves behind.
  signedOff?: boolean;
  // The arm's answer pushed no commit and posted no comment, so there was
  // nothing for the reviewer to respond to and the exchange ended with this
  // round instead of waiting again. Recorded rather than inferred: an equal
  // sha pair beside an unreadable conversation would look identical.
  settled?: boolean;
}

// GitHub's reaction API represents thumbs-up as "+1". That structured event is
// the only mechanical sign-off: prose is never classified by vocabulary,
// length, punctuation, or review state.
function isThumbsUpReaction(note: ReviewNote): boolean {
  return note.kind === "reaction" && note.body === "+1";
}

export function reviewerSignedOff(found: ReviewNote[]): boolean {
  return found.some(isThumbsUpReaction);
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
  // Actionable review arrived, but the arm could not complete its answer turn.
  | "review-failed"
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
  // What the arm has moved on to, for the live view's status word. Optional
  // because every test here injects this whole interface by hand and a phase is
  // a display detail, not part of what landing does.
  phase?: (phase: ArmPhase) => void;
  // The signal is handed through so the production sleep can clear its timer
  // on abort, rather than the wrapper resolving early over a setTimeout that
  // keeps the process alive for the rest of the interval.
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  // Quitting the live view aborts the controller every session runs under —
  // but the landing phase waits on GitHub with no session in flight, so it has
  // to watch the same signal itself or a quit during "waiting for review" sits
  // out the rest of the review timeout before teardown can run.
  signal?: AbortSignal;
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
  const ended = last?.signedOff
    ? `, ${last.reviewer} signed off`
    : last?.settled
      ? ", settled with nothing left to answer"
      : "";
  switch (record.status) {
    case "merged":
      return rounds > 0
        ? `merged ${where} after ${answered}/${rounds} answered review round(s)${ended}`
        : `merged ${where}`;
    case "merge-failed":
      return `merge of ${where} failed: ${record.merge?.error ?? "unknown error"}`;
    case "review-failed":
      return `${where} was not merged because the arm failed to answer review`;
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
  deps: Pick<LandDeps, "github" | "note">,
): Promise<Baseline | undefined> {
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

// `deps.wait`, cut short when the run is aborted. Returns whether the signal
// fired, so a poll loop stops at the next tick instead of sitting out its
// timeout after the user has already quit. The signal goes to the wait itself
// rather than being raced against it: the production sleep cancels its timer
// on abort, where a race would resolve early and leave the pending setTimeout
// holding the process open for the rest of the interval.
async function waitUnlessAborted(
  deps: Pick<LandDeps, "wait" | "signal">,
  ms: number,
): Promise<boolean> {
  if (deps.signal?.aborted) return true;
  await deps.wait(ms, deps.signal);
  return deps.signal?.aborted ?? false;
}

// Wait for something new from the reviewer, or give up. Polls the whole
// conversation rather than a cursor: comment ids are the only durable identity
// here, and a review that arrives as three comments at once should count once.
//
// The reviewer match goes through `sameLogin`: GraphQL-sourced review bodies
// drop the `[bot]` suffix REST keeps, and a literal compare silently excluded
// them — an approval-only review read as reviewer silence.
async function waitForReview(
  deps: LandDeps,
  pullRequest: number,
  reviewer: string,
  seen: Set<string>,
  timeoutMs: number,
  pollMs: number,
  debounceMs: number,
  // The rolling anchor: when the harness last saw something from the reviewer,
  // in `deps.now()` terms. The timeout window is "the reviewer has been silent
  // for `timeoutMs`", not a fresh allowance per wait — so a round that starts
  // after the arm spent a while answering inherits the silence already on the
  // clock. Absent (round one, nothing seen yet), the window runs from the
  // start of this wait. At least one poll always happens, so activity that
  // landed during the arm's answer turn is found even past the deadline.
  reviewerLastSeenAt?: number,
): Promise<{
  found: ReviewNote[];
  conversation: ReviewNote[];
  waitedMs: number;
  timedOut: boolean;
  // The run was aborted mid-wait — the caller stops landing, it does not merge.
  aborted?: boolean;
  // Set when the last poll before giving up could not read the conversation:
  // "the API was dark" must not be recorded as "the reviewer said nothing".
  error?: string;
}> {
  const start = deps.now();
  const deadline = (reviewerLastSeenAt ?? start) + timeoutMs;
  const abortedResult = () => ({
    found: [] as ReviewNote[],
    conversation: [] as ReviewNote[],
    waitedMs: deps.now() - start,
    timedOut: false,
    aborted: true,
  });
  if (deps.signal?.aborted) return abortedResult();
  const fromReviewer = (note: ReviewNote): boolean =>
    sameLogin(note.author, reviewer) &&
    !seen.has(note.id) &&
    (note.kind !== "reaction" || isThumbsUpReaction(note));
  let lastError: string | undefined;
  for (;;) {
    let conversation: ReviewNote[];
    try {
      conversation = await deps.github.conversation(pullRequest);
      lastError = undefined;
    } catch (error) {
      // A failed read is a failed poll, not reviewer silence — keep polling,
      // and if the whole wait ends this way, say so in the record.
      lastError = error instanceof Error ? error.message : String(error);
      if (deps.now() >= deadline) {
        return {
          found: [],
          conversation: [],
          waitedMs: deps.now() - start,
          timedOut: true,
          error: lastError,
        };
      }
      if (await waitUnlessAborted(deps, pollMs)) return abortedResult();
      continue;
    }
    const found = conversation.filter(fromReviewer);
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
        // Aborting mid-debounce drops the batch in hand, which is fine: the
        // run is being torn down, not sent back to answer.
        if (await waitUnlessAborted(deps, debounceMs)) return abortedResult();
        let next: ReviewNote[];
        try {
          next = await deps.github.conversation(pullRequest);
        } catch {
          // The batch in hand is complete as of the last successful read —
          // hand it over rather than losing it to a failed re-poll.
          return {
            found: settledFound,
            conversation: settledConversation,
            waitedMs: deps.now() - start,
            timedOut: false,
          };
        }
        settledConversation = next;
        settledFound = settledConversation.filter(fromReviewer);
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
    if (deps.now() >= deadline) {
      return {
        found: [],
        conversation,
        waitedMs: deps.now() - start,
        timedOut: true,
        error: lastError,
      };
    }
    if (await waitUnlessAborted(deps, pollMs)) return abortedResult();
  }
}

// Whether anything worth responding to appeared on the pull request since
// `seen` was captured: a comment from anyone, or the reviewer's thumbs-up —
// the one reaction the next round would act on. Every other reaction is noise
// here just as it is in the wait loop.
async function answerLeftTrace(
  deps: Pick<LandDeps, "github">,
  pullRequest: number,
  reviewer: string,
  seen: Set<string>,
): Promise<boolean> {
  let after: ReviewNote[];
  try {
    after = await deps.github.conversation(pullRequest);
  } catch {
    // Unreadable is unknown, and unknown must not end the exchange early —
    // the next round's poll loop absorbs transient failures already.
    return true;
  }
  return after.some(
    (entry) =>
      !seen.has(entry.id) &&
      (entry.kind !== "reaction" ||
        (sameLogin(entry.author, reviewer) && isThumbsUpReaction(entry))),
  );
}

// The post-merge conversation is the close-reading record in land.json, so a
// transient API failure must not quietly become an empty list. Retry; the
// caller records an explicit gap when even the retries fail.
async function captureConversation(
  deps: Pick<LandDeps, "github">,
  pullRequest: number,
  attempts = 3,
): Promise<ReviewNote[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await deps.github.conversation(pullRequest);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  // When the harness last saw the reviewer say anything, on its own clock —
  // the anchor that makes the review timeout a rolling window over reviewer
  // silence rather than a fresh allowance per round.
  let reviewerLastSeenAt: number | undefined;

  if (arm.reviewer) {
    for (let round = 1; round <= config.reviewRounds; round += 1) {
      deps.phase?.("waiting for review");
      note(`waiting for ${arm.reviewer} on #${pullRequest.number}…`);
      const waited = await waitForReview(
        deps,
        pullRequest.number,
        arm.reviewer,
        seen,
        config.reviewTimeoutMs,
        config.reviewPollMs,
        config.reviewDebounceMs,
        reviewerLastSeenAt,
      );

      if (waited.aborted) {
        // The user quit. Refusing to merge is the point — recorded like any
        // other failed answer so the barrier holds and Greg leaves the box
        // unchecked, and teardown runs now instead of after the timeout.
        reviewRounds.push({
          round,
          reviewer: arm.reviewer,
          waitedMs: waited.waitedMs,
          timedOut: false,
          found: [],
          error: "the run was aborted while waiting for the reviewer",
        });
        note("the run was aborted while waiting for review — refusing to merge");
        return done("review-failed", { branch, pullRequest, reviewRounds });
      }

      if (waited.timedOut) {
        reviewRounds.push({
          round,
          reviewer: arm.reviewer,
          waitedMs: waited.waitedMs,
          timedOut: true,
          found: [],
          error: waited.error,
        });
        note(
          waited.error
            ? `the conversation could not be read while waiting (${waited.error}) — round ${round} recorded as a timeout, not as reviewer silence`
            : round === 1
              ? `no review within ${Math.round(config.reviewTimeoutMs / 1000)}s — merging unreviewed`
              : "no further review — done answering",
        );
        break;
      }

      const found = waited.found;
      const conversation = waited.conversation;
      reviewerLastSeenAt = deps.now();

      // Everything visible now counts as seen, including the arm's own replies:
      // the next round is only interested in what the reviewer says *after*
      // this answer.
      for (const entry of conversation) seen.add(entry.id);

      // A reviewer thumbs-up is the sole mechanical close signal. Other
      // reactions never enter `found`; prose is always handed to the arm.
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

      deps.phase?.("answering review");
      let answer: StreamResult;
      try {
        answer = await deps.reply(
          reviewPrompt(pullRequest.url, round, config.reviewRounds),
        );
      } catch (error) {
        // The real runner throws for transport failures, watchdog timeouts and
        // external aborts. Those are still failed review answers, not reasons
        // to escape the landing barrier without a durable outcome.
        answer = {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
          timedOut: false,
        };
      }
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
      const answered: ReviewRound = {
        round,
        reviewer: arm.reviewer,
        waitedMs: waited.waitedMs,
        timedOut: false,
        found,
        reviewedSha,
        respondedSha,
        respondedAt: new Date().toISOString(),
        // `response` is what the arm *said*; a session that errored said
        // nothing. Setting it unconditionally made every non-timed-out round
        // count as answered — including one whose Codex turn died on spawn —
        // so `answered` could never disagree with `rounds` and the headline
        // "did the reviewed arm engage with its review" was not measuring
        // engagement at all. The failure text is still kept, as `error`.
        response: answer.isError ? undefined : answer.output,
        error: answer.isError ? answer.output : undefined,
      };
      reviewRounds.push(answered);

      if (answer.isError) {
        note("the arm failed to answer the review — refusing to merge");
        return done("review-failed", {
          branch,
          pullRequest,
          reviewRounds,
        });
      }

      // The reviewer only responds to a ping — a pushed commit or a posted
      // comment — and its thumbs-up sign-off is an ACK to one. An answer turn
      // that left neither on the pull request (a clean review gives the arm
      // nothing to fix and nothing to say) gave the reviewer nothing to react
      // to, so waiting another round could only ever end in the full timeout.
      // The exchange is settled the moment an answer leaves no trace on the
      // record. On the last allowed round there is no next wait to spare, so
      // the check is skipped rather than spent on a read nobody uses.
      if (round < config.reviewRounds) {
        const pushed =
          reviewedSha !== undefined &&
          respondedSha !== undefined &&
          reviewedSha !== respondedSha;
        if (
          !pushed &&
          !(await answerLeftTrace(deps, pullRequest.number, arm.reviewer, seen))
        ) {
          answered.settled = true;
          note(
            `the answer pushed nothing and posted nothing on #${pullRequest.number} — nothing for ${arm.reviewer} to respond to, so the review is settled`,
          );
          break;
        }
      }
    }
  }

  return done("ready", { branch, pullRequest, reviewRounds });
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
  // An empty conversation and an unreadable one must not look alike in the
  // record: the comments stay re-fetchable from GitHub, but only if land.json
  // says they are missing rather than absent.
  let conversation: ReviewNote[] = [];
  try {
    conversation = await captureConversation(deps, record.pullRequest.number);
  } catch (error) {
    note(
      `conversation unavailable at merge time (${
        error instanceof Error ? error.message : String(error)
      }) — an empty list here is a gap, re-fetch it from GitHub`,
    );
  }

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

  const notes = [...record.notes, `not merged: ${reason}`];
  deps.note(`not merged: ${reason}`);
  let conversation: ReviewNote[] = [];
  if (record.pullRequest) {
    try {
      conversation = await captureConversation(deps, record.pullRequest.number);
    } catch (error) {
      // Same rule as mergeArm: an unreadable conversation is recorded as a
      // gap, never passed off as an empty one.
      const message = error instanceof Error ? error.message : String(error);
      notes.push(
        `conversation unavailable while blocking (${message}) — an empty list here is a gap, re-fetch it from GitHub`,
      );
      deps.note(`conversation unavailable while blocking (${message})`);
    }
  }
  return {
    ...record,
    status: "blocked",
    completedAt: new Date().toISOString(),
    conversation,
    notes,
  };
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
  if (record.status === "review-failed") {
    const error = record.reviewRounds.at(-1)?.error ?? "unknown error";
    return `pull request ${record.pullRequest?.number ?? "?"} could not answer required review: ${error}`;
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
