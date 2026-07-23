import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArmConfig, ArmName, HarnessConfig } from "./config.js";

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
  schemaVersion: 2;
  runId: string;
  status: "running" | "completed" | "completed_with_failures" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
  arms: Partial<
    Record<
      ArmName,
      {
        final: PersistedArmResult;
        attempts: PersistedArmResult[];
      }
    >
  >;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

async function findTranscript(
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
      schemaVersion: 2,
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
    const artifacts = new RunArtifacts(
      runId,
      directory,
      resolve(config.codexHome),
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
          arms: config.arms,
          sandbox: config.sandbox,
          resultsDir: resolve(config.resultsDir),
          codexHome: resolve(config.codexHome),
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
      const source = await findTranscript(
        join(this.codexHome, "sessions"),
        result.threadId,
      );
      if (source) {
        const destination = join(directory, "transcript.jsonl");
        await copyFile(source, destination);
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
    this.manifestWrite = this.manifestWrite.then(() =>
      atomicWrite(join(this.directory, "manifest.json"), json(this.manifest)),
    );
    await this.manifestWrite;
  }
}
