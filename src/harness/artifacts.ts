import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArmConfig, ArmName, HarnessConfig } from "./config.js";
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
  transcriptStatus?: "copied" | "not-found" | "unavailable-no-thread-id";
}

interface RunManifest {
  // 3 adds the landing record: the commit each arm started from, the pull
  // request it opened, the review rounds it answered, and how it merged.
  schemaVersion: 3;
  runId: string;
  status: "running" | "completed" | "completed_with_failures" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
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

export class RunArtifacts {
  readonly runId: string;
  readonly directory: string;
  private readonly codexHome: string;
  private manifest: RunManifest;
  private manifestWrite: Promise<void> = Promise.resolve();

  private constructor(
    runId: string,
    directory: string,
    codexHome: string,
    startedAt: string,
  ) {
    this.runId = runId;
    this.directory = directory;
    this.codexHome = codexHome;
    this.manifest = {
      schemaVersion: 3,
      runId,
      status: "running",
      startedAt,
      arms: {},
    };
  }

  static async create(
    config: HarnessConfig,
    prompt: string,
  ): Promise<RunArtifacts> {
    const startedAt = new Date().toISOString();
    const runId = `${startedAt.replaceAll(":", "-")}-${randomUUID()}`;
    const directory = resolve(config.resultsDir, runId);
    const globalCodexHome = resolve(config.codexHome);
    const artifacts = new RunArtifacts(
      runId,
      directory,
      globalCodexHome,
      startedAt,
    );

    await mkdir(directory, { recursive: true });
    await Promise.all([
      atomicWrite(join(directory, "manifest.json"), json(artifacts.manifest)),
      atomicWrite(join(directory, "ticket.txt"), `${config.ticket}\n`),
      atomicWrite(join(directory, "prompt.txt"), `${prompt}\n`),
      atomicWrite(
        join(directory, "config.json"),
        json({
          // The record is meant to be published; a token is the one part of an
          // arm's config that must not be. Its presence is still recorded —
          // "did this arm push under its own identity" is worth knowing later.
          arms: config.arms.map((arm) => ({
            ...arm,
            ghToken: arm.ghToken ? "[redacted]" : undefined,
          })),
          sandbox: config.sandbox,
          resultsDir: resolve(config.resultsDir),
          codexHome: resolve(config.codexHome),
          containerImage: config.containerImage,
          maxAttempts: config.maxAttempts,
          idleTimeoutMs: config.idleTimeoutMs,
        }),
      ),
    ]);
    return artifacts;
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

    if (result.threadId) {
      const destination = join(directory, "transcript.jsonl");
      const source = captureTranscript
        ? await captureTranscript(
            result.arm,
            result.threadId,
            destination,
          )
        : await findTranscript(join(this.codexHome, "sessions"), result.threadId);
      if (source) {
        if (!captureTranscript) await copyFile(source, destination);
        persisted.transcript = destination;
        persisted.transcriptSource = source;
        persisted.transcriptStatus = "copied";
      } else {
        persisted.transcriptStatus = "not-found";
      }
    } else {
      persisted.transcriptStatus = "unavailable-no-thread-id";
    }

    await atomicWrite(join(directory, "status.json"), json(persisted));
    const previous = this.manifest.arms[result.arm];
    this.manifest.arms[result.arm] = {
      final: persisted,
      attempts: [...(previous?.attempts ?? []), persisted],
    };
    await this.writeManifest();
    return persisted;
  }

  // The commit each arm starts from, written before either session launches so
  // an interrupted run still says where it began.
  async recordBaselines(
    baselines: Partial<Record<ArmName, Baseline>>,
  ): Promise<void> {
    this.manifest.baselines = baselines;
    await Promise.all([
      atomicWrite(join(this.directory, "baselines.json"), json(baselines)),
      this.writeManifest(),
    ]);
  }

  // What happened to the arm's work after its session ended: the pull request,
  // the review rounds, the merge. Lands beside that arm's attempts as
  // `<arm>/land.json` and replaces the arm's final result, because a session
  // that opened no pull request is a failed arm however it reported itself.
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
    await mkdir(join(this.directory, record.arm), { recursive: true });
    await atomicWrite(
      join(this.directory, record.arm, "land.json"),
      json(record),
    );

    // Retried from scratch, not only when the first copy succeeded: Codex can
    // flush the session file after the session settles, and the review rounds
    // run long after that — a transcript recorded `not-found` at finishArm is
    // usually on disk by now, and leaving it `not-found` forever loses the
    // whole session record over a timing accident.
    if (persisted.threadId) {
      const destination =
        persisted.transcript ??
        join(persisted.artifactDir, "transcript.jsonl");
      const source = captureTranscript
        ? await captureTranscript(
            persisted.arm,
            persisted.threadId,
            destination,
          )
        : await findTranscript(join(this.codexHome, "sessions"), persisted.threadId);
      if (source) {
        if (!captureTranscript) await copyFile(source, destination);
        persisted.transcript = destination;
        persisted.transcriptSource = source;
        persisted.transcriptStatus = "copied";
      }
    }

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

    const previous = this.manifest.arms[record.arm];
    this.manifest.arms[record.arm] = {
      final: persisted,
      attempts: previous?.attempts ?? [persisted],
      landing: record,
    };
    await this.writeManifest();
    return persisted;
  }

  async complete(results: PersistedArmResult[]): Promise<void> {
    this.manifest.status = results.some((result) => result.status === "failed")
      ? "completed_with_failures"
      : "completed";
    this.manifest.completedAt = new Date().toISOString();
    await this.writeManifest();
  }

  async fail(error: unknown): Promise<void> {
    this.manifest.status = "failed";
    this.manifest.completedAt = new Date().toISOString();
    this.manifest.error = error instanceof Error ? error.message : String(error);
    await atomicWrite(join(this.directory, "error.txt"), `${this.manifest.error}\n`);
    await this.writeManifest();
  }

  private attemptDirectory(arm: ArmName, attempt: number): string {
    return join(this.directory, arm, `attempt-${String(attempt).padStart(2, "0")}`);
  }

  private async writeManifest(): Promise<void> {
    const write = this.manifestWrite.then(() =>
      atomicWrite(join(this.directory, "manifest.json"), json(this.manifest)),
    );
    // Keep the serialization chain from poisoning: the stored promise always
    // resolves, so one transient write failure doesn't cascade into every
    // later finishArm/complete. The current caller still sees the error.
    this.manifestWrite = write.catch(() => {});
    await write;
  }
}
