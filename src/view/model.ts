import type { LandingRecord, LandingStatus } from "../harness/land.js";
import type { ClimbState } from "../harness/state.js";
import { LiveStore } from "./store.js";

// One numbered line of scrollback. The id is stable so React keys survive the
// ring buffer dropping older entries.
export interface Line {
  id: number;
  text: string;
}

// One pull request an arm landed, as its own tab shows it. Kept on the model
// rather than in the store because the store is cleared between phases (Greg
// swaps sessions per milestone) and a climb's merged pull requests are exactly
// the thing that should accumulate across them.
export interface PullRequestEntry {
  arm: string;
  number: number;
  url: string;
  title: string;
  status: LandingStatus;
  // Review rounds this pull request went through, and how many of them the arm
  // actually answered — the reviewed arm's whole story in two numbers.
  rounds: number;
  answered: number;
  comments: number;
}

const PR_LIMIT = 100;

export function pullRequestEntry(
  record: LandingRecord,
): PullRequestEntry | undefined {
  const pr = record.pullRequest;
  if (!pr) return undefined;
  return {
    arm: record.arm,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    status: record.status,
    rounds: record.reviewRounds.length,
    answered: record.reviewRounds.filter(
      (round) => round.response !== undefined,
    ).length,
    comments: record.conversation.length,
  };
}

// Bounded so a run that goes all night cannot grow the process without limit —
// the complete feed is always in `progress.log`.
const LOG_LIMIT = 2000;
const NOTE_LIMIT = 500;

// Everything the live view renders, for *either* run mode. A one-ticket run and
// Greg's climb differ only in what they put here: the climb sets a phase per
// milestone, swaps which Codex sessions are live, and writes notes; a ticket run
// sets the subtitle once and never writes a note. Keeping one model means the
// two views cannot drift apart the way two copies of the wiring did.
export class LiveModel {
  readonly live = new LiveStore();
  subtitle: string;
  finished = false;

  // Replaced (never mutated) on append so React sees a new identity.
  private notesLines: Line[] = [];
  private logLines: Line[] = [];
  private ladderLines: Line[] = [];
  // The subticket the climb is building right now, as its ladder heading
  // number ("1.2"). Drives the highlight in the ladder pane.
  currentSubticket?: string;
  private prs = new Map<string, PullRequestEntry[]>();
  private nextId = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly title: string,
    subtitle: string,
    // Label for the notes tab, or undefined when this mode has no notes to
    // show (a one-ticket run). Set to "ladder" by Greg.
    readonly notesLabel?: string,
  ) {
    this.subtitle = subtitle;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    const unsubscribeLive = this.live.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      unsubscribeLive();
    };
  }

  notes(): Line[] {
    return this.notesLines;
  }

  log(): Line[] {
    return this.logLines;
  }

  // The ladder file as scrollback. Empty until `setLadder` runs, which is what
  // the ladder tab keys off — a one-ticket run never has one.
  ladder(): Line[] {
    return this.ladderLines;
  }

  hasLadder(): boolean {
    return this.ladderLines.length > 0;
  }

  // Replace the rendered ladder. Called at startup and again after each rung,
  // because Greg appends to the file as he plans — a pane pinned to the text as
  // it was an hour ago would quietly stop showing where the climb is.
  setLadder(text: string, current?: string): void {
    this.ladderLines = text
      .split("\n")
      .map((line) => ({ id: this.nextId++, text: line }));
    this.currentSubticket = current;
    this.emit();
  }

  // Enter a phase: swap the subtitle and replace the live sessions with the
  // ones this phase runs (Greg alone while planning, both arms while building).
  setPhase(subtitle: string, arms: string[]): void {
    this.subtitle = subtitle;
    this.live.reset();
    for (const arm of arms) this.live.register(arm);
    this.emit();
  }

  // Every pull request this arm has landed so far, oldest first.
  pullRequests(arm: string): PullRequestEntry[] {
    return this.prs.get(arm) ?? [];
  }

  // Seed the pull-request lists from the durable climb record so an arm's tab
  // opens showing every pull request the experiment has ever landed, not just
  // the ones from this process. `results/state.json` is the only place that
  // history survives — the ladder deliberately does not carry it.
  seedFromState(state: ClimbState): void {
    for (const subticket of state.subtickets) {
      for (const arm of subticket.arms) {
        if (!arm.pullRequest) continue;
        const existing = this.prs.get(arm.arm) ?? [];
        if (existing.some((pr) => pr.url === arm.pullRequest!.url)) continue;
        existing.push({
          arm: arm.arm,
          number: arm.pullRequest.number,
          url: arm.pullRequest.url,
          title: arm.pullRequest.title,
          status: arm.status,
          rounds: arm.rounds,
          answered: arm.answered,
          comments: arm.comments,
        });
        this.prs.set(
          arm.arm,
          existing.length > PR_LIMIT
            ? existing.slice(existing.length - PR_LIMIT)
            : existing,
        );
      }
    }
    this.emit();
  }

  // Record what an arm's work landed as. Re-recording the same pull request
  // (a re-run of the same subticket) replaces the earlier entry rather than
  // listing it twice.
  recordLanding(record: LandingRecord): void {
    const entry = pullRequestEntry(record);
    if (!entry) return;
    const existing = this.prs.get(record.arm) ?? [];
    const without = existing.filter((pr) => pr.url !== entry.url);
    const next = [...without, entry];
    this.prs.set(
      record.arm,
      next.length > PR_LIMIT ? next.slice(next.length - PR_LIMIT) : next,
    );
    this.emit();
  }

  // Loop log lines become durable scrollback in the notes tab.
  note(message: string): void {
    this.notesLines = append(
      this.notesLines,
      message.split("\n").filter((line) => line.trim()),
      () => this.nextId++,
      NOTE_LIMIT,
    );
    this.emit();
  }

  // The raw tee'd feed, verbatim from `attachLive`.
  appendLog(chunk: string): void {
    this.logLines = append(
      this.logLines,
      chunk.split("\n").filter((line) => line.length > 0),
      () => this.nextId++,
      LOG_LIMIT,
    );
    this.emit();
  }

  // Mark the run over so the view can unmount. The subtitle is only replaced
  // when the caller has something better to say than what is already there —
  // a ticket run's ticket stays worth reading in the final frame.
  finish(subtitle?: string): void {
    if (subtitle !== undefined) this.subtitle = subtitle;
    this.finished = true;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function append(
  existing: Line[],
  texts: string[],
  id: () => number,
  limit: number,
): Line[] {
  if (texts.length === 0) return existing;
  const next = [...existing, ...texts.map((text) => ({ id: id(), text }))];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
