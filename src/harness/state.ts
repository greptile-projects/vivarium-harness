import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite } from "./artifacts.js";
import type { HarnessRunResult } from "./harness.js";
import type { LandingRecord, LandingStatus } from "./land.js";

// The climb's durable record, and the deliberate counterpart to `LADDER.md`.
//
// The ladder crosses the isolation boundary — it is bind-mounted read-only into
// both containers and it is Greg's entire prompt — so it must never carry a
// pull request URL (which names both repositories), an arm name, or a harness
// path. An arm that read those would learn it is one of two, and Greg would see
// the builders he is documented as blind to.
//
// This file is the opposite: written to `results/`, never mounted, never in a
// prompt. Because nothing downstream reads it, it can hold everything worth
// combing through later. The ladder answers "where are we"; this answers
// "what happened".
export const STATE_FILE = "state.json";
export const STATE_VERSION = 1;

export interface StateArmRecord {
  arm: string;
  status: LandingStatus;
  pullRequest?: { number: number; url: string; title: string };
  // The reviewed arm's story in three numbers: rounds it was given, rounds it
  // answered, and how long the conversation ran.
  rounds: number;
  answered: number;
  comments: number;
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
  schemaVersion: number;
  updatedAt: string;
  planner: StatePlannerRecord[];
  subtickets: StateSubticketRecord[];
}

export function statePath(resultsDir: string): string {
  return join(resultsDir, STATE_FILE);
}

function empty(): ClimbState {
  return {
    schemaVersion: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    planner: [],
    subtickets: [],
  };
}

// Missing or unreadable state is an empty climb, never an error: this file is a
// record for humans, and a corrupt one must not stop the experiment it is
// recording. A later write replaces it wholesale.
export async function readClimbState(path: string): Promise<ClimbState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return empty();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ClimbState>;
    return {
      schemaVersion: parsed.schemaVersion ?? STATE_VERSION,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      planner: parsed.planner ?? [],
      subtickets: parsed.subtickets ?? [],
    };
  } catch {
    return empty();
  }
}

async function write(path: string, state: ClimbState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(
    path,
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
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
  };
}

export function subticketRecord(
  subticket: { number: string; milestone: number; title: string },
  run: HarnessRunResult,
): StateSubticketRecord {
  return {
    number: subticket.number,
    milestone: subticket.milestone,
    title: subticket.title,
    runId: run.runId,
    artifactDir: run.artifactDir,
    status: run.status,
    completedAt: new Date().toISOString(),
    arms: run.landings.map(armRecord),
  };
}

// Record a built subticket. Re-running the same subticket replaces its entry
// rather than appending a second one — the ladder only has one box for it, and
// two rows for one rung would misread as two rungs.
export async function recordSubticket(
  path: string,
  record: StateSubticketRecord,
): Promise<void> {
  const state = await readClimbState(path);
  state.subtickets = [
    ...state.subtickets.filter((entry) => entry.number !== record.number),
    record,
  ];
  await write(path, state);
}

// Record one planning turn. Unlike subtickets these accumulate: a milestone
// that took two attempts is worth seeing as two.
export async function recordPlannerSession(
  path: string,
  record: StatePlannerRecord,
): Promise<void> {
  const state = await readClimbState(path);
  state.planner = [...state.planner, record];
  await write(path, state);
}
