import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  atomicWrite,
  findTranscript,
  json,
  totalTokens,
} from "../artifacts.js";
import type { TokenUsage } from "../live/stream.js";
import type { HarnessProvenance } from "../provenance.js";

// The durable record of one planning session — the half of the experiment that
// had none. Every build attempt has written a request, a response, a transcript
// and a status since the beginning; Greg's sessions wrote nothing at all. The
// ladder text was the whole record, which means the reasoning behind a rung —
// why *this* next, what he thought the last rung had achieved, which of the
// prompt's rules he pushed against — was gone the moment the session ended, and
// even the rollout in `$CODEX_HOME/sessions` was unfindable afterwards because
// nothing recorded the thread id.
//
// Deliberately its own class rather than a mode of RunArtifacts: a planning
// session has no arms, no baselines, no landing, and its output is a diff to a
// markdown file. Sharing the manifest would mean a schema where half the fields
// are always absent.
export interface PlanAttemptRecord {
  attempt: number;
  status: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  threadId?: string;
  output?: string;
  error?: string;
  usage?: TokenUsage;
  artifactDir: string;
  stderrLog: string;
  transcript?: string;
  transcriptSource?: string;
  transcriptStatus?: "copied" | "not-found" | "unavailable-no-thread-id";
}

interface PlanManifest {
  schemaVersion: 1;
  planId: string;
  milestone: number;
  status: "running" | "planned" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
  ladderPath: string;
  codexHome: string;
  harness?: HarnessProvenance;
  attempts: PlanAttemptRecord[];
  // Total tokens across every attempt. Each planning attempt is a *fresh*
  // session (statelessness is the point), so unlike an arm's retries these are
  // separate threads and really do add up.
  tokens?: number;
}

export class PlanArtifacts {
  readonly directory: string;
  private readonly codexHome: string;
  private manifest: PlanManifest;
  private manifestWrite: Promise<void> = Promise.resolve();

  private constructor(
    directory: string,
    codexHome: string,
    manifest: PlanManifest,
  ) {
    this.directory = directory;
    this.codexHome = codexHome;
    this.manifest = manifest;
  }

  static async create(options: {
    resultsDir: string;
    codexHome: string;
    milestone: number;
    ladderPath: string;
    harness?: HarnessProvenance;
  }): Promise<PlanArtifacts> {
    const startedAt = new Date().toISOString();
    const planId = `plan-${startedAt.replaceAll(":", "-")}-milestone-${
      options.milestone
    }-${randomUUID()}`;
    const directory = resolve(options.resultsDir, planId);
    const manifest: PlanManifest = {
      schemaVersion: 1,
      planId,
      milestone: options.milestone,
      status: "running",
      startedAt,
      ladderPath: resolve(options.ladderPath),
      codexHome: resolve(options.codexHome),
      harness: options.harness,
      attempts: [],
    };

    await mkdir(directory, { recursive: true });
    const artifacts = new PlanArtifacts(
      directory,
      resolve(options.codexHome),
      manifest,
    );
    await artifacts.writeManifest();
    return artifacts;
  }

  // The prompt as sent, and the ladder exactly as Greg was shown it. Both per
  // attempt: a retry re-reads the file, so attempt 2's input is not attempt 1's
  // — and when a failed attempt half-appended a milestone, the difference
  // between those two files is the only place that is visible.
  async startAttempt(
    attempt: number,
    prompt: string,
    ladderBefore: string,
  ): Promise<{ artifactDir: string; stderrPath: string }> {
    const artifactDir = this.attemptDirectory(attempt);
    await mkdir(artifactDir, { recursive: true });
    await Promise.all([
      atomicWrite(join(artifactDir, "prompt.txt"), `${prompt}\n`),
      atomicWrite(join(artifactDir, "ladder-before.md"), ladderBefore),
    ]);
    return {
      artifactDir,
      stderrPath: join(artifactDir, "codex-stderr.log"),
    };
  }

  async finishAttempt(
    attempt: number,
    result: {
      status: "succeeded" | "failed";
      startedAt: string;
      threadId?: string;
      output?: string;
      error?: string;
      usage?: TokenUsage;
      raw?: unknown;
    },
  ): Promise<PlanAttemptRecord> {
    const artifactDir = this.attemptDirectory(attempt);
    const completedAt = new Date().toISOString();
    const record: PlanAttemptRecord = {
      attempt,
      status: result.status,
      startedAt: result.startedAt,
      completedAt,
      durationMs:
        new Date(completedAt).getTime() - new Date(result.startedAt).getTime(),
      threadId: result.threadId,
      output: result.output,
      error: result.error,
      usage: result.usage,
      artifactDir,
      stderrLog: join(artifactDir, "codex-stderr.log"),
    };

    if (result.raw !== undefined) {
      await atomicWrite(
        join(artifactDir, "response.json"),
        json(result.raw),
      );
    }
    if (result.output !== undefined) {
      await atomicWrite(join(artifactDir, "output.txt"), `${result.output}\n`);
    }
    if (result.error !== undefined) {
      await atomicWrite(join(artifactDir, "error.txt"), `${result.error}\n`);
    }

    // Same recovery as an arm's: match the rollout by thread id under the
    // session home this run used. Greg always runs on the host, so that is the
    // run-wide CODEX_HOME.
    if (record.threadId) {
      const source = await findTranscript(
        join(this.codexHome, "sessions"),
        record.threadId,
      );
      if (source) {
        const destination = join(artifactDir, "transcript.jsonl");
        await copyFile(source, destination);
        record.transcript = destination;
        record.transcriptSource = source;
        record.transcriptStatus = "copied";
      } else {
        record.transcriptStatus = "not-found";
      }
    } else {
      record.transcriptStatus = "unavailable-no-thread-id";
    }

    await atomicWrite(join(artifactDir, "status.json"), json(record));
    this.manifest.attempts.push(record);
    this.manifest.tokens = totalTokens(this.manifest.attempts);
    await this.writeManifest();
    return record;
  }

  // The ladder as it stands now. Written on success *and* failure: the file is
  // the planner's only output, so what it looks like after a session that threw
  // is the interesting artifact, not a detail to skip.
  async complete(
    status: "planned" | "failed",
    ladderAfter: string,
    error?: string,
  ): Promise<void> {
    this.manifest.status = status;
    this.manifest.completedAt = new Date().toISOString();
    this.manifest.error = error;
    await Promise.all([
      atomicWrite(join(this.directory, "ladder-after.md"), ladderAfter),
      this.writeManifest(),
    ]);
  }

  private attemptDirectory(attempt: number): string {
    return join(this.directory, `attempt-${String(attempt).padStart(2, "0")}`);
  }

  // Serialized the same way RunArtifacts serializes its manifest, and swallowing
  // per-link errors for the same reason: one failed write must not poison later
  // ones.
  private async writeManifest(): Promise<void> {
    const write = this.manifestWrite.then(() =>
      atomicWrite(join(this.directory, "manifest.json"), json(this.manifest)),
    );
    this.manifestWrite = write.catch(() => {});
    await write;
  }
}
