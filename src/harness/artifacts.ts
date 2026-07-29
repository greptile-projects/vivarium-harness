import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ArmConfig,
  ArmName,
  HarnessConfig,
  RunDestination,
} from "./config.js";
import type { TranscriptCapture } from "./environment.js";
import type { Baseline } from "./github.js";
import type { LandingRecord } from "./land.js";

export interface PersistedArmResult {
  arm: ArmName;
  repo: string;
  attempt: number;
  maxAttempts: number;
  status: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  threadId?: string;
  output?: string;
  error?: string;
  artifactDir: string;
  transcript?: string;
  transcriptSource?: string;
  transcriptStatus?:
    | "copied"
    | "partial"
    | "not-found"
    | "copy-failed"
    | "unavailable-no-thread-id";
  transcriptError?: string;
}

// The single JSON record of one run — everything but the raw texts (the
// ticket, the prompt, the transcripts), which stay as their own readable files
// beside it. Version 4 is the per-rung layout: what used to be manifest.json +
// baselines.json + <arm>/land.json is one file, and the run is filed under its
// ladder coordinates (results/rung-01/run/1.2) rather than an opaque run id.
export const RUN_RECORD_FILE = "run.json";

export interface RunRecord {
  schemaVersion: 4;
  runId: string;
  // The ladder coordinates this run built, when the destination named them.
  subticket?: RunDestination["subticket"];
  status: "running" | "completed" | "completed_with_failures" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
  cleanupError?: string;
  // The arm setup the run was made with, tokens redacted — the record is meant
  // to be published; a token is the one part that must not be. Its *presence*
  // is still recorded: "did this arm push under its own identity" is worth
  // knowing later.
  config: Record<string, unknown>;
  // Where each arm's checkout stood before the run — the two should match, and
  // when they do not that is the finding, not a detail.
  baselines?: Partial<Record<ArmName, Baseline>>;
  arms: Partial<
    Record<
      ArmName,
      {
        final: PersistedArmResult;
        attempts: PersistedArmResult[];
        landing?: LandingRecord;
      }
    >
  >;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Shared with state.ts — every durable record in results/ goes through the
// same temp-file + rename move.
export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

// Exported so Greg's planning session — which runs outside `runHarness` and so
// has no RunArtifacts of its own — can recover its transcript the same way.
export async function findTranscript(
  directory: string,
  threadId: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
      return path;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = await findTranscript(join(directory, entry.name), threadId);
    if (match) return match;
  }
  return undefined;
}

// A re-run of a failed subticket builds into the same directory — the ladder
// has one box for it, and the record should have one address. What the earlier
// run left behind is moved under superseded/<startedAt>/ rather than deleted,
// so the top level always holds the run that counted and the failures stay
// readable underneath it.
async function archiveSupersededRun(
  directory: string,
  startedAt: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  if (!entries.includes(RUN_RECORD_FILE)) return;

  const archive = join(
    directory,
    "superseded",
    startedAt.replaceAll(":", "-"),
  );
  await mkdir(archive, { recursive: true });
  for (const entry of entries) {
    if (entry === "superseded") continue;
    await rename(join(directory, entry), join(archive, entry));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

// The ladder has one stable destination per subticket, so that destination
// must have exactly one writer. A symlink is both the atomic exclusion and the
// owner record: unlike a lock file, there is no interval where the lock exists
// but its PID/run id have not been written yet. A process that died without
// reaching finally leaves a stale lock, which the next run can safely replace.
async function acquireDestinationLock(
  directory: string,
  runId: string,
): Promise<string> {
  const lock = `${directory}.lock`;
  const owner = `${process.pid}:${runId}`;
  await mkdir(dirname(directory), { recursive: true });

  for (;;) {
    try {
      await symlink(owner, lock);
      return lock;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }

    let current: string;
    try {
      current = await readlink(lock);
    } catch {
      throw new Error(`run destination is locked: ${directory}`);
    }
    const pid = Number(current.split(":", 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) {
      throw new Error(`run destination is already active: ${directory}`);
    }

    // Serialize stale-lock recovery too. Without this second atomic claim, two
    // starters could both inspect the dead owner and one could unlink the
    // other's newly acquired destination lock.
    const recovery = `${lock}.recovery`;
    try {
      await mkdir(recovery);
    } catch {
      throw new Error(`run destination is being recovered: ${directory}`);
    }
    try {
      if (await readlink(lock).catch(() => undefined) === current) {
        await unlink(lock).catch(() => {});
      }
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
  }
}

export class RunArtifacts {
  readonly runId: string;
  readonly directory: string;
  private readonly codexHome: string;
  private readonly destinationLock: string;
  private record: RunRecord;
  private recordWrite: Promise<void> = Promise.resolve();

  private constructor(
    runId: string,
    directory: string,
    codexHome: string,
    startedAt: string,
    config: HarnessConfig,
    destinationLock: string,
  ) {
    this.runId = runId;
    this.directory = directory;
    this.codexHome = codexHome;
    this.destinationLock = destinationLock;
    this.record = {
      schemaVersion: 4,
      runId,
      subticket: config.destination?.subticket,
      status: "running",
      startedAt,
      config: {
        arms: config.arms.map((arm) => ({
          ...arm,
          ghToken: arm.ghToken ? "[redacted]" : undefined,
        })),
        sandbox: config.sandbox,
        resultsDir: resolve(config.resultsDir),
        codexHome: resolve(config.codexHome),
        maxAttempts: config.maxAttempts,
        idleTimeoutMs: config.idleTimeoutMs,
      },
      arms: {},
    };
  }

  static async create(
    config: HarnessConfig,
    prompt: string,
  ): Promise<RunArtifacts> {
    const startedAt = new Date().toISOString();
    const runId = `${startedAt.replaceAll(":", "-")}-${randomUUID()}`;
    // Every run is filed by the destination the caller names — for the climb,
    // its ladder coordinates. There is no fallback directory: a run without an
    // address would be a record nothing can find again.
    if (!config.destination) {
      throw new Error(
        "run has no destination — the ladder loop supplies one per subticket",
      );
    }
    const directory = resolve(config.destination.directory);
    const globalCodexHome = resolve(config.codexHome);
    const destinationLock = await acquireDestinationLock(directory, runId);
    const artifacts = new RunArtifacts(
      runId,
      directory,
      globalCodexHome,
      startedAt,
      config,
      destinationLock,
    );

    try {
      await mkdir(directory, { recursive: true });
      await archiveSupersededRun(directory, startedAt);
      await Promise.all([
        atomicWrite(join(directory, RUN_RECORD_FILE), json(artifacts.record)),
        atomicWrite(join(directory, "ticket.md"), `${config.ticket}\n`),
        atomicWrite(join(directory, "prompt.md"), `${prompt}\n`),
      ]);
      return artifacts;
    } catch (error) {
      await artifacts.release();
      throw error;
    }
  }

  async startAttempt(
    arm: ArmConfig,
    request: Record<string, unknown>,
    startedAt: string,
    attempt: number,
  ): Promise<string> {
    const directory = this.attemptDirectory(arm.name, attempt);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      atomicWrite(join(directory, "request.json"), json(request)),
      atomicWrite(
        join(directory, "status.json"),
        json({
          arm: arm.name,
          repo: arm.repo,
          attempt,
          status: "running",
          startedAt,
        }),
      ),
    ]);
    return directory;
  }

  async finishArm(
    result: PersistedArmResult,
    rawResponse?: unknown,
    captureTranscript?: TranscriptCapture,
  ): Promise<PersistedArmResult> {
    const directory = result.artifactDir;
    const persisted = { ...result };

    if (rawResponse !== undefined) {
      await atomicWrite(join(directory, "response.json"), json(rawResponse));
    }
    if (result.output !== undefined) {
      await atomicWrite(join(directory, "output.txt"), `${result.output}\n`);
    }
    if (result.error !== undefined) {
      await atomicWrite(join(directory, "error.txt"), `${result.error}\n`);
    }

    await this.captureTranscript(persisted, captureTranscript);

    await atomicWrite(join(directory, "status.json"), json(persisted));
    const previous = this.record.arms[result.arm];
    this.record.arms[result.arm] = {
      final: persisted,
      attempts: [...(previous?.attempts ?? []), persisted],
    };
    await this.writeRecord();
    return persisted;
  }

  // The commit each arm starts from, written before either session launches so
  // an interrupted run still says where it began.
  async recordBaselines(
    baselines: Partial<Record<ArmName, Baseline>>,
  ): Promise<void> {
    this.record.baselines = baselines;
    await this.writeRecord();
  }

  // What happened to the arm's work after its session ended: the pull request,
  // the review rounds, the merge. Lands in run.json as the arm's `landing` and
  // replaces the arm's final result, because a session that opened no pull
  // request is a failed arm however it reported itself.
  //
  // The transcript is copied again here: the review rounds are more turns on
  // the same Codex thread, and the copy taken when the session first settled
  // stops short of them.
  async recordLanding(
    record: LandingRecord,
    result: PersistedArmResult,
    captureTranscript?: TranscriptCapture,
  ): Promise<PersistedArmResult> {
    const persisted = { ...result };
    const landing = await this.extractRoundDiffs(record);

    // Retried from scratch, not only when the first copy succeeded: Codex can
    // flush the session file after the session settles, and the review rounds
    // run long after that — a transcript recorded `not-found` at finishArm is
    // usually on disk by now, and leaving it `not-found` forever loses the
    // whole session record over a timing accident.
    await this.captureTranscript(persisted, captureTranscript);

    if (persisted.error !== undefined) {
      await atomicWrite(
        join(persisted.artifactDir, "error.txt"),
        `${persisted.error}\n`,
      );
    }
    await atomicWrite(
      join(persisted.artifactDir, "status.json"),
      json(persisted),
    );

    const previous = this.record.arms[record.arm];
    this.record.arms[record.arm] = {
      final: persisted,
      attempts: previous?.attempts ?? [persisted],
      landing,
    };
    await this.writeRecord();
    return persisted;
  }

  // A review round's diff is a raw text, and raw texts live as files: inline it
  // would bloat every rewrite of run.json for the life of the run. Each one
  // moves to <arm>/rounds/round-NN.diff and leaves a `diffFile` pointer in the
  // round. A failed write keeps the diff inline — worse to read, but the data
  // survives into run.json rather than vanishing over a filesystem hiccup.
  private async extractRoundDiffs(
    record: LandingRecord,
  ): Promise<LandingRecord> {
    if (!record.reviewRounds.some((round) => round.diff !== undefined)) {
      return record;
    }
    const directory = join(this.directory, record.arm, "rounds");
    await mkdir(directory, { recursive: true }).catch(() => {});
    const reviewRounds = await Promise.all(
      record.reviewRounds.map(async (round) => {
        if (round.diff === undefined) return round;
        const file = join(
          directory,
          `round-${String(round.round).padStart(2, "0")}.diff`,
        );
        try {
          await atomicWrite(
            file,
            round.diff.endsWith("\n") || round.diff === ""
              ? round.diff
              : `${round.diff}\n`,
          );
        } catch {
          return round;
        }
        const { diff: _diff, ...rest } = round;
        return { ...rest, diffFile: file };
      }),
    );
    return { ...record, reviewRounds };
  }

  async complete(results: PersistedArmResult[]): Promise<void> {
    this.record.status = results.some((result) => result.status === "failed")
      ? "completed_with_failures"
      : "completed";
    this.record.completedAt = new Date().toISOString();
    await this.writeRecord();
  }

  async fail(error: unknown): Promise<void> {
    this.record.status = "failed";
    this.record.completedAt = new Date().toISOString();
    this.record.error = error instanceof Error ? error.message : String(error);
    await atomicWrite(join(this.directory, "error.txt"), `${this.record.error}\n`);
    await this.writeRecord();
  }

  // Ephemeral teardown happens after the run's irreversible work. A failure
  // here must remain visible without rewriting a completed run as failed (or
  // replacing the primary error from an already-failed run).
  async recordCleanupError(error: unknown): Promise<void> {
    this.record.cleanupError =
      error instanceof Error ? error.message : String(error);
    await atomicWrite(
      join(this.directory, "cleanup-error.txt"),
      `${this.record.cleanupError}\n`,
    );
    await this.writeRecord();
  }

  // Held through environment cleanup: cleanup diagnostics are part of this
  // run's record and must land before a retry may archive it.
  async release(): Promise<void> {
    const owner = await readlink(this.destinationLock).catch(() => undefined);
    if (owner === `${process.pid}:${this.runId}`) {
      await unlink(this.destinationLock).catch(() => {});
    }
  }

  // Transcript export is evidence collection, not arm execution. Keep a
  // failed copy as an explicit diagnostic, but never make successful work
  // retry or prevent a ready pull request from merging because Docker or the
  // host session directory was temporarily unavailable.
  private async captureTranscript(
    persisted: PersistedArmResult,
    captureTranscript?: TranscriptCapture,
  ): Promise<void> {
    if (!persisted.threadId) {
      persisted.transcriptStatus = "unavailable-no-thread-id";
      return;
    }

    const destination =
      persisted.transcript ??
      join(persisted.artifactDir, "transcript.jsonl");
    const staging = `${destination}.${randomUUID()}.capture`;
    try {
      const source = captureTranscript
        ? await captureTranscript(
            persisted.arm,
            persisted.threadId,
            staging,
          )
        : await findTranscript(
            join(this.codexHome, "sessions"),
            persisted.threadId,
          );
      if (!source) {
        await rm(staging, { force: true }).catch(() => {});
        if (!persisted.transcript) persisted.transcriptStatus = "not-found";
        return;
      }
      if (!captureTranscript) await copyFile(source, staging);
      // A landing-time refresh must not write over the only durable copy until
      // the replacement is complete. `rename` is atomic within this artifact
      // directory, so a failed docker cp leaves the earlier transcript intact.
      await rename(staging, destination);
      persisted.transcript = destination;
      persisted.transcriptSource = source;
      persisted.transcriptStatus = "copied";
      delete persisted.transcriptError;
    } catch (error) {
      await rm(staging, { force: true }).catch(() => {});
      persisted.transcriptStatus = persisted.transcript
        ? "partial"
        : "copy-failed";
      persisted.transcriptError =
        error instanceof Error ? error.message : String(error);
    }
  }

  private attemptDirectory(arm: ArmName, attempt: number): string {
    return join(this.directory, arm, `attempt-${String(attempt).padStart(2, "0")}`);
  }

  private async writeRecord(): Promise<void> {
    const write = this.recordWrite.then(() =>
      atomicWrite(join(this.directory, RUN_RECORD_FILE), json(this.record)),
    );
    // Keep the serialization chain from poisoning: the stored promise always
    // resolves, so one transient write failure doesn't cascade into every
    // later finishArm/complete. The current caller still sees the error.
    this.recordWrite = write.catch(() => {});
    await write;
  }
}
