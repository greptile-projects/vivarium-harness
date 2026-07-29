import { armsForDisplay } from "../harness/arms.js";
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
  // Inline comments on the diff, both sides of the exchange. Undefined when the
  // record predates the field (an older run record) — the row then says
  // nothing rather than printing a number it cannot stand behind.
  diffComments?: number;
}

const PR_LIMIT = 100;

// Comments *on the diff*, which is what the pull-request rows count. The full
// conversation also holds the pull request's own description, each review's
// summary body, and reactions; folding those in inflated a two-finding review
// into "6 comments" and made the number useless for comparing arms.
export function diffCommentCount(record: LandingRecord): number {
  return record.conversation.filter((note) => note.kind === "review-comment")
    .length;
}

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
    diffComments: diffCommentCount(record),
  };
}

// One subticket as the plan file has it — the four fields the climb tab needs,
// so the view never has to import the ladder parser (and `greg-tile/` and
// `view/` stay ignorant of each other, as they are everywhere else).
export interface PlanSubticket {
  number: string;
  milestone: number;
  title: string;
  done: boolean;
}

// What one arm did with one subticket, as the climb tab shows it.
export interface ClimbArm {
  arm: string;
  status: LandingStatus;
  pullRequest?: { number: number; url: string };
  rounds: number;
  answered: number;
  diffComments?: number;
}

// One rung of the climb, merged from the two sources that know about it: the
// ladder says what was planned and whether the box is checked, the rung
// directories (and the run in flight) say what each arm landed.
export interface ClimbSubticket {
  number: string;
  milestone: number;
  title: string;
  state: "built" | "building" | "pending";
  arms: ClimbArm[];
}

// "1.10" sorts after "1.9": compare the dotted numbers component-wise rather
// than as strings.
export function compareSubticketNumbers(left: string, right: string): number {
  const l = left.split(".").map(Number);
  const r = right.split(".").map(Number);
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const diff = (l[index] ?? 0) - (r[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

// Bounded so a run that goes all night cannot grow the process without limit —
// the complete feed is always in `progress.log`.
const LOG_LIMIT = 2000;
const NOTE_LIMIT = 500;

// Everything the live view renders. The climb sets a phase per milestone,
// swaps which Codex sessions are live between planning and building, and
// writes notes — one model for all of it means the panes render from one
// source of truth instead of each wiring keeping its own copy.
export class LiveModel {
  readonly live = new LiveStore();
  subtitle: string;
  finished = false;

  // Replaced (never mutated) on append so React sees a new identity.
  private notesLines: Line[] = [];
  private logLines: Line[] = [];
  // The plan as the ladder file has it, in file order.
  private planned: PlanSubticket[] = [];
  // What each rung landed, keyed by subticket number — seeded from the rung
  // directories and topped up as the run in flight lands its own.
  private landed = new Map<
    string,
    { milestone: number; title: string; arms: ClimbArm[] }
  >();
  // The subticket the climb is building right now, as its ladder heading
  // number ("1.2"). Marks the rung in the climb tab, and is what a landing
  // arriving mid-run is filed under.
  currentSubticket?: string;
  private prs = new Map<string, PullRequestEntry[]>();
  private nextId = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly title: string,
    subtitle: string,
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

  // Whether there is a plan to show yet — before the first milestone is
  // planned there is none, and the climb tab is absent rather than open and
  // empty. State alone is enough: a ladder we could not read still leaves
  // every rung the experiment has already landed.
  hasPlan(): boolean {
    return this.planned.length > 0 || this.landed.size > 0;
  }

  // Replace the plan. Called at startup and again after each phase, because
  // Greg appends rungs as he plans and the loop checks boxes as it builds — a
  // pane pinned to the plan as it was an hour ago would quietly stop showing
  // where the climb is.
  setPlan(subtickets: PlanSubticket[], current?: string): void {
    this.planned = subtickets.map((subticket) => ({
      number: subticket.number,
      milestone: subticket.milestone,
      title: subticket.title,
      done: subticket.done,
    }));
    this.currentSubticket = current;
    this.emit();
  }

  // The climb as one list, oldest rung first: what has been built (with what
  // each arm landed on it), the rung in flight, and what is still queued.
  climb(): ClimbSubticket[] {
    const planned = this.planned.map((subticket) => ({
      number: subticket.number,
      milestone: subticket.milestone,
      title: subticket.title,
      state: subticket.done
        ? ("built" as const)
        : subticket.number === this.currentSubticket
          ? ("building" as const)
          : ("pending" as const),
      arms: this.landed.get(subticket.number)?.arms ?? [],
    }));

    // Rungs that landed but are no longer in the file — a hand-edited or
    // rewritten ladder. They still happened, so they are still shown.
    const inPlan = new Set(planned.map((subticket) => subticket.number));
    const orphans: ClimbSubticket[] = [...this.landed.entries()]
      .filter(([number]) => !inPlan.has(number))
      .map(([number, record]) => ({
        number,
        milestone: record.milestone,
        title: record.title,
        state: "built" as const,
        arms: record.arms,
      }))
      .sort((left, right) => compareSubticketNumbers(left.number, right.number));

    return [...orphans, ...planned];
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
  // the ones from this process. The rung directories under `results/` are the
  // only place that history survives — the ladder deliberately does not carry
  // it.
  seedFromState(state: ClimbState): void {
    for (const subticket of state.subtickets) {
      this.landed.set(subticket.number, {
        milestone: subticket.milestone,
        title: subticket.title,
        arms: armsForDisplay(
          subticket.arms.map((arm) => ({
            arm: arm.arm,
            status: arm.status,
            pullRequest: arm.pullRequest
              ? { number: arm.pullRequest.number, url: arm.pullRequest.url }
              : undefined,
            rounds: arm.rounds,
            answered: arm.answered,
            diffComments: arm.diffComments,
          })),
        ),
      });
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
          diffComments: arm.diffComments,
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
    this.recordClimbArm(record);
    const entry = pullRequestEntry(record);
    if (!entry) {
      this.emit();
      return;
    }
    const existing = this.prs.get(record.arm) ?? [];
    const without = existing.filter((pr) => pr.url !== entry.url);
    const next = [...without, entry];
    this.prs.set(
      record.arm,
      next.length > PR_LIMIT ? next.slice(next.length - PR_LIMIT) : next,
    );
    this.emit();
  }

  // File a landing under the rung being built, so the climb tab fills in as the
  // run goes rather than only after the rung directories are next read. The
  // rung in flight is by definition the current one — nothing else is running.
  private recordClimbArm(record: LandingRecord): void {
    const number = this.currentSubticket;
    if (!number) return;
    const planned = this.planned.find(
      (subticket) => subticket.number === number,
    );
    const existing = this.landed.get(number) ?? {
      milestone: planned?.milestone ?? 0,
      title: planned?.title ?? number,
      arms: [],
    };
    const arm: ClimbArm = {
      arm: record.arm,
      status: record.status,
      pullRequest: record.pullRequest
        ? { number: record.pullRequest.number, url: record.pullRequest.url }
        : undefined,
      rounds: record.reviewRounds.length,
      answered: record.reviewRounds.filter(
        (round) => round.response !== undefined,
      ).length,
      diffComments: diffCommentCount(record),
    };
    this.landed.set(number, {
      ...existing,
      arms: armsForDisplay([
        ...existing.arms.filter((entry) => entry.arm !== record.arm),
        arm,
      ]),
    });
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
  // when the caller has something better to say than what is already there in
  // the final frame.
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
