import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ArmConfig,
  ArmName,
  HarnessConfig,
  SubticketRef,
} from "./config.js";
import type { Baseline } from "./github.js";
import type { LandingRecord } from "./land.js";
import type { TokenUsage } from "./session.js";
import type { HarnessProvenance } from "./provenance.js";

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
  // What this session had spent when it ended, successfully or not. Cumulative
  // for the *thread*, so retries that continue one do not add up — see
  // `totalTokens`.
  usage?: TokenUsage;
  // Where the codex subprocess's stderr for this attempt was teed.
  stderrLog?: string;
}

// An arm's config with the token taken out. `config.json` is written into the
// directory this experiment intends to publish, and `ArmConfig.ghToken` is a
// live GitHub token with write access to the arm's repo — so every run was
// writing two working credentials into the artifact record. The presence flag
// stays, because "did the harness act as the arm or fall back to the operator's
// gh auth" is a real question about how a run behaved.
export interface RedactedArmConfig extends Omit<ArmConfig, "ghToken"> {
  ghTokenPresent: boolean;
}

export function redactArmConfig(arm: ArmConfig): RedactedArmConfig {
  const { ghToken, ...rest } = arm;
  return { ...rest, ghTokenPresent: ghToken !== undefined };
}

// Everything about *how* the run was configured, as opposed to what it was
// asked to build. The landing knobs are here because `land.json` records
// `timedOut: true` without saying what it timed out against: a round that gave
// up is a different observation at a 15-minute budget than at a four-hour one,
// and the default has already moved once.
export interface RunConfigRecord {
  arms: RedactedArmConfig[];
  sandbox: string;
  resultsDir: string;
  codexHome: string;
  containerImage: string;
  maxAttempts: number;
  idleTimeoutMs: number;
  land: boolean;
  reviewRounds: number;
  reviewTimeoutMs: number;
  reviewPollMs: number;
  reviewDebounceMs: number;
  subticket?: SubticketRef;
  logDir?: string;
  ladderPath?: string;
  harness?: HarnessProvenance;
}

export function runConfigRecord(
  config: HarnessConfig,
  harness?: HarnessProvenance,
): RunConfigRecord {
  return {
    arms: config.arms.map(redactArmConfig),
    sandbox: config.sandbox,
    resultsDir: resolve(config.resultsDir),
    codexHome: resolve(config.codexHome),
    containerImage: config.containerImage,
    maxAttempts: config.maxAttempts,
    idleTimeoutMs: config.idleTimeoutMs,
    land: config.land,
    reviewRounds: config.reviewRounds,
    reviewTimeoutMs: config.reviewTimeoutMs,
    reviewPollMs: config.reviewPollMs,
    reviewDebounceMs: config.reviewDebounceMs,
    subticket: config.subticket,
    logDir: config.logDir ? resolve(config.logDir) : undefined,
    ladderPath: config.ladderPath ? resolve(config.ladderPath) : undefined,
    harness,
  };
}

// One arm's spend across everything it ran: build attempts and review rounds.
//
// Codex reports `total_token_usage` cumulatively per **thread**, so summing the
// snapshots would multiply-count a retry that continued one — three attempts on
// one thread would read as roughly six times the real spend. Take the largest
// snapshot per thread and sum *those*: a retry that had to start a fresh thread
// really did spend twice, and that is the only case where two numbers add.
export function totalTokens(
  entries: Array<{ threadId?: string; usage?: TokenUsage }>,
): number | undefined {
  const perThread = new Map<string, number>();
  entries.forEach((entry, index) => {
    const total = entry.usage?.totalTokens;
    if (total === undefined) return;
    // No thread id means the session never got far enough to report one; it
    // cannot be shown to share a thread with anything, so it counts alone.
    const key = entry.threadId ?? `#${index}`;
    perThread.set(key, Math.max(perThread.get(key) ?? 0, total));
  });
  if (perThread.size === 0) return undefined;
  return [...perThread.values()].reduce((sum, value) => sum + value, 0);
}

interface RunManifest {
  // 4 adds the run's own provenance and cost: which harness commit produced it,
  // which ladder rung it was building, where its progress logs went, what the
  // landing phase was configured to allow, and what each arm spent.
  schemaVersion: 4;
  runId: string;
  status: "running" | "completed" | "completed_with_failures" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
  // Which rung, which harness, which logs — see RunConfigRecord.
  config: RunConfigRecord;
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
        // Total tokens this arm spent, review rounds included.
        tokens?: number;
      }
    >
  >;
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function atomicWrite(
  path: string,
  contents: string,
): Promise<void> {
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
  // Per-arm host CODEX_HOME, used to locate that arm's transcript. Containerized
  // arms write sessions inside the container, so their home differs from the
  // run-wide one; arms absent here fall back to `codexHome`.
  private readonly armCodexHomes: Record<string, string>;
  private manifest: RunManifest;
  private manifestWrite: Promise<void> = Promise.resolve();

  private constructor(
    runId: string,
    directory: string,
    codexHome: string,
    startedAt: string,
    armCodexHomes: Record<string, string>,
    config: RunConfigRecord,
  ) {
    this.runId = runId;
    this.directory = directory;
    this.codexHome = codexHome;
    this.armCodexHomes = armCodexHomes;
    this.manifest = {
      schemaVersion: 4,
      runId,
      status: "running",
      startedAt,
      config,
      arms: {},
    };
  }

  static async create(
    config: HarnessConfig,
    prompt: string,
    // Which harness commit is producing this run. Passed in rather than read
    // here so the suite never shells out to git.
    harness?: HarnessProvenance,
  ): Promise<RunArtifacts> {
    const startedAt = new Date().toISOString();
    const runId = `${startedAt.replaceAll(":", "-")}-${randomUUID()}`;
    const directory = resolve(config.resultsDir, runId);
    const globalCodexHome = resolve(config.codexHome);
    const armCodexHomes: Record<string, string> = {};
    for (const arm of config.arms) {
      armCodexHomes[arm.name] = arm.codexHome
        ? resolve(arm.codexHome)
        : globalCodexHome;
    }
    const record = runConfigRecord(config, harness);
    const artifacts = new RunArtifacts(
      runId,
      directory,
      globalCodexHome,
      startedAt,
      armCodexHomes,
      record,
    );

    await mkdir(directory, { recursive: true });
    await Promise.all([
      atomicWrite(join(directory, "manifest.json"), json(artifacts.manifest)),
      atomicWrite(join(directory, "ticket.txt"), `${config.ticket}\n`),
      atomicWrite(join(directory, "prompt.txt"), `${prompt}\n`),
      // Redacted: see redactArmConfig. This file used to carry both arms' live
      // GitHub tokens.
      atomicWrite(join(directory, "config.json"), json(record)),
      artifacts.snapshotLadder(config.ladderPath),
    ]);
    return artifacts;
  }

  // The ladder as it stood when this run started. Read rather than copied, so
  // the symlink each checkout sees is followed to the real file. Best-effort: a
  // missing ladder is an ad-hoc `--ticket` run, and an unreadable one must not
  // stop a climb — `config.json` still names the path it tried, so an absent
  // `ladder.md` beside a present `ladderPath` says the read failed.
  private async snapshotLadder(ladderPath?: string): Promise<void> {
    if (!ladderPath) return;
    try {
      const ladder = await readFile(ladderPath, "utf8");
      await atomicWrite(join(this.directory, "ladder.md"), ladder);
    } catch {
      // ignore
    }
  }

  // Where this arm's codex stderr for one attempt is teed. Handed to the runner
  // so the subprocess's own diagnostics land beside the attempt they belong to.
  attemptStderrLog(arm: ArmName, attempt: number): string {
    return join(this.attemptDirectory(arm, attempt), "codex-stderr.log");
  }

  // The review rounds all continue one thread and are not attempts, so they
  // share one file per arm; each session stamps a header into it.
  reviewStderrLog(arm: ArmName): string {
    return join(this.directory, arm, "review-codex-stderr.log");
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
      const codexHome = this.armCodexHomes[result.arm] ?? this.codexHome;
      const source = await findTranscript(
        join(codexHome, "sessions"),
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
    const attempts = [...(previous?.attempts ?? []), persisted];
    this.manifest.arms[result.arm] = {
      ...previous,
      final: persisted,
      attempts,
      tokens: totalTokens(attempts),
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
  ): Promise<PersistedArmResult> {
    const persisted = { ...result };
    await mkdir(join(this.directory, record.arm), { recursive: true });

    // The diff goes to its own file and `land.json` names it instead of
    // embedding it: a patch encoded as a JSON string is unreadable, and
    // `land.json` is the file a human opens first.
    const { diff, ...withoutDiff } = record;
    const diffFile = diff
      ? join(this.directory, record.arm, "pull-request.diff")
      : undefined;
    if (diff && diffFile) await atomicWrite(diffFile, diff);
    await atomicWrite(
      join(this.directory, record.arm, "land.json"),
      json({ ...withoutDiff, diffFile }),
    );

    if (persisted.threadId && persisted.transcript) {
      const codexHome = this.armCodexHomes[persisted.arm] ?? this.codexHome;
      const source = await findTranscript(
        join(codexHome, "sessions"),
        persisted.threadId,
      );
      if (source) await copyFile(source, persisted.transcript);
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
    const attempts = previous?.attempts ?? [persisted];
    this.manifest.arms[record.arm] = {
      final: persisted,
      attempts,
      // Same split as land.json — the manifest is an index, not a place to
      // inline a patch.
      landing: { ...withoutDiff, diffFile },
      // The review rounds are more turns on the arm's own thread, so their
      // cumulative snapshots supersede the build attempt's — the same reason
      // the transcript is re-copied here.
      tokens: totalTokens([
        ...attempts,
        ...record.reviewRounds.map((round) => ({
          threadId: persisted.threadId,
          usage: round.usage,
        })),
      ]),
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
