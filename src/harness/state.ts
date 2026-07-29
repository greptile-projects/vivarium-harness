import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, RUN_RECORD_FILE, type RunRecord } from "./artifacts.js";
import type { LandingRecord, LandingStatus } from "./land.js";

// The climb's durable record, and the deliberate counterpart to `LADDER.md`.
//
// The ladder crosses the isolation boundary — it is bind-mounted read-only into
// both containers and it is Greg's entire prompt — so it must never carry a
// pull request URL (which names both repositories), an arm name, or a harness
// path. `results/` is the opposite: never mounted, never in a prompt, so it can
// hold everything worth combing through later. The ladder answers "where are
// we"; this answers "what happened".
//
// There is no separate state file to keep in sync. The record IS the artifact
// tree, filed by ladder coordinates:
//
//   results/rung-01/plan/plan.json      Greg's planning turns for that rung
//   results/rung-01/plan/<thread>.jsonl …and their raw transcripts
//   results/rung-01/run/1.2/run.json    one subticket's whole run
//
// `readClimbState` reassembles the climb by scanning that tree. Reads fail
// open — an unreadable rung or run is skipped, never fatal: this is a record
// for humans and must not stop the experiment it is recording.

const RUNG_DIR = /^rung-(\d+)$/;

export function rungDirectory(resultsDir: string, milestone: number): string {
  return join(resultsDir, `rung-${String(milestone).padStart(2, "0")}`);
}

export function planDirectory(resultsDir: string, milestone: number): string {
  return join(rungDirectory(resultsDir, milestone), "plan");
}

export function subticketRunDirectory(
  resultsDir: string,
  milestone: number,
  number: string,
): string {
  return join(rungDirectory(resultsDir, milestone), "run", number);
}

export interface StateArmRecord {
  arm: string;
  status: LandingStatus;
  pullRequest?: { number: number; url: string; title: string };
  // The reviewed arm's story in four numbers: rounds it was given, rounds it
  // answered, how long the whole conversation ran, and how much of that was
  // inline comments on the diff. The two counts are kept apart because
  // `comments` also holds review summaries, issue comments and reactions — fine
  // as a measure of how much traffic a pull request drew, misleading as a count
  // of findings, which is what the live view shows.
  rounds: number;
  answered: number;
  comments: number;
  // Optional: records written before this field existed have none, and the view
  // shows nothing rather than a number it would have to guess.
  diffComments?: number;
}

export interface StateSubticketRecord {
  number: string;
  milestone: number;
  title: string;
  runId: string;
  artifactDir: string;
  status: string;
  completedAt: string;
  arms: StateArmRecord[];
}

// Greg's own planning turn. `threadId` is what makes the raw Codex transcript
// findable afterwards — without it the session file is one of hundreds under
// CODEX_HOME with nothing tying it to a milestone.
export interface StatePlannerRecord {
  milestone: number;
  threadId?: string;
  transcript?: string;
  plannedAt: string;
}

export interface ClimbState {
  planner: StatePlannerRecord[];
  subtickets: StateSubticketRecord[];
}

// One rung's planning record, at rung-NN/plan/plan.json. Turns accumulate: a
// milestone that took two attempts is worth seeing as two.
interface PlanRecord {
  milestone: number;
  turns: StatePlannerRecord[];
}

export function armRecord(record: LandingRecord): StateArmRecord {
  return {
    arm: record.arm,
    status: record.status,
    pullRequest: record.pullRequest
      ? {
          number: record.pullRequest.number,
          url: record.pullRequest.url,
          title: record.pullRequest.title,
        }
      : undefined,
    rounds: record.reviewRounds.length,
    answered: record.reviewRounds.filter(
      (round) => round.response !== undefined,
    ).length,
    comments: record.conversation.length,
    diffComments: record.conversation.filter(
      (note) => note.kind === "review-comment",
    ).length,
  };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// "1.10" sorts after "1.9": compare dotted subticket numbers component-wise.
function compareNumbers(left: string, right: string): number {
  const l = left.split(".").map(Number);
  const r = right.split(".").map(Number);
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const diff = (l[index] ?? 0) - (r[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function subticketFromRun(
  record: RunRecord,
  artifactDir: string,
): StateSubticketRecord | undefined {
  if (!record.subticket) return undefined;
  return {
    number: record.subticket.number,
    milestone: record.subticket.milestone,
    title: record.subticket.title,
    runId: record.runId,
    artifactDir,
    status: record.status,
    completedAt: record.completedAt ?? record.startedAt,
    arms: Object.values(record.arms ?? {})
      .filter((arm) => arm?.landing)
      .map((arm) => armRecord(arm!.landing!)),
  };
}

// Reassemble the climb from the rung directories. Every failure is a skip: a
// missing results/ is an empty climb, an unreadable run.json loses one row.
export async function readClimbState(resultsDir: string): Promise<ClimbState> {
  const state: ClimbState = { planner: [], subtickets: [] };

  let entries: string[];
  try {
    entries = await readdir(resultsDir);
  } catch {
    return state;
  }

  const rungs = entries
    .map((name) => ({ name, match: name.match(RUNG_DIR) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match![1]) - Number(b.match![1]));

  for (const rung of rungs) {
    const rungDir = join(resultsDir, rung.name);

    const plan = await readJson<PlanRecord>(join(rungDir, "plan", "plan.json"));
    if (plan && Array.isArray(plan.turns)) state.planner.push(...plan.turns);

    let runs: string[];
    try {
      runs = await readdir(join(rungDir, "run"));
    } catch {
      continue;
    }
    for (const name of runs.sort(compareNumbers)) {
      const directory = join(rungDir, "run", name);
      const record = await readJson<RunRecord>(
        join(directory, RUN_RECORD_FILE),
      );
      if (!record) continue;
      const subticket = subticketFromRun(record, directory);
      if (subticket) state.subtickets.push(subticket);
    }
  }

  return state;
}

// Record one planning turn into its rung's plan.json. Turns accumulate across
// attempts; a re-read tolerates a corrupt file by starting the list over
// rather than refusing to record the turn that just happened.
export async function recordPlannerSession(
  resultsDir: string,
  record: StatePlannerRecord,
): Promise<void> {
  const directory = planDirectory(resultsDir, record.milestone);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "plan.json");
  const existing = await readJson<PlanRecord>(path);
  const turns = Array.isArray(existing?.turns) ? existing.turns : [];
  await atomicWrite(
    path,
    `${JSON.stringify(
      { milestone: record.milestone, turns: [...turns, record] },
      null,
      2,
    )}\n`,
  );
}
