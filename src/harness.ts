import {
  RunArtifacts,
  type PersistedArmResult,
} from "./artifacts.js";
import type { ArmConfig, ArmName, HarnessConfig, SandboxMode } from "./config.js";
import type { Baseline, GitHubFactory } from "./github.js";
import { gitHubForArm } from "./github.js";
import {
  landArm,
  landingError,
  landingSummary,
  prepareArm,
  type LandingRecord,
} from "./land.js";
import { workerPrompt } from "./prompt.js";
import { harnessProvenance, type HarnessProvenance } from "./provenance.js";
import {
  runArmStreaming,
  sessionUsage,
  type CodexMsg,
  type StreamParams,
  type StreamResult,
} from "./live/stream.js";

export type ArmResult = PersistedArmResult;

export type ArmEventSink = (arm: string, msg: CodexMsg) => void;

// Fired the moment an individual arm settles, independent of the other arms
// still running — lets a live view retire that arm's panel immediately
// instead of waiting for the whole Promise.all to resolve.
export type ArmCompleteSink = (result: ArmResult) => void;

// Everything the run can tell a watcher. Grouped rather than passed
// positionally because landing added two more: the arm is doing observable
// work (waiting on a review, merging) long after its Codex events stop.
export interface HarnessSinks {
  onEvent?: ArmEventSink;
  onArmComplete?: ArmCompleteSink;
  // Human-readable progress from the landing phase — the only part of a run
  // that is not a codex/event.
  onArmNote?: (arm: string, note: string) => void;
  onLanding?: (record: LandingRecord) => void;
}

// Injectable so tests can simulate arms without spawning a real Codex process.
export type AttemptRunner = (
  params: StreamParams,
  onEvent: (msg: CodexMsg) => void,
) => Promise<StreamResult>;

// The rest of the outside world, injected for the same reason: tests run the
// whole harness without git, gh, or a clock.
export interface HarnessDeps {
  runner?: AttemptRunner;
  github?: GitHubFactory;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  // Which harness commit is producing this run. Injected for the same reason as
  // the rest of this: the default shells out to git, and the suite does not.
  provenance?: () => Promise<HarnessProvenance>;
}

export interface HarnessRunResult {
  runId: string;
  artifactDir: string;
  status: "completed" | "completed_with_failures";
  results: ArmResult[];
  landings: LandingRecord[];
}

// Where and how this arm's Codex runs: in its container via `docker exec`, or
// directly on the host against the checkout. Shared by the build attempts and
// the review rounds so the two cannot drift apart.
export function armExecution(
  arm: ArmConfig,
  config: HarnessConfig,
): { workspace: string; exec?: string[]; sandbox: SandboxMode } {
  const containerized = arm.container !== undefined;
  const workspace = containerized ? arm.workspace ?? "/workspace" : arm.repo;
  return {
    workspace,
    exec: containerized
      ? ["docker", "exec", "-i", "-w", workspace, arm.container as string]
      : undefined,
    sandbox: arm.sandbox ?? config.sandbox,
  };
}

export function codexArguments(
  prompt: string,
  repo: string,
  sandbox: SandboxMode,
): Record<string, unknown> {
  return {
    prompt,
    cwd: repo,
    sandbox,
    "approval-policy": "never",
  };
}

export function retryPrompt(
  previousError: string,
  recovery: number,
  totalRecoveries: number,
): string {
  return `Autonomous recovery attempt ${recovery} of ${totalRecoveries}.

The previous attempt failed with:
${previousError}

Diagnose the root cause, inspect the current repository state, and continue the original task from where it stopped. Resolve blockers yourself, retry with a different approach when necessary, and use the available tools and repository context. Do not ask for human help or wait for instructions.`;
}

export async function runArm(
  arm: ArmConfig,
  prompt: string,
  config: HarnessConfig,
  artifacts: RunArtifacts,
  runner: AttemptRunner = runArmStreaming,
  onEvent: ArmEventSink = () => {},
  // Abort the whole arm, retries included. Without the check in the loop below
  // an abort would only kill the attempt in flight and the retry loop would
  // immediately start another one — the opposite of stopping.
  signal?: AbortSignal,
): Promise<ArmResult> {
  let threadId: string | undefined;
  let previousError = "The previous attempt did not complete.";
  let finalResult: ArmResult | undefined;

  // In container mode the arm's codex runs via `docker exec` and sees its
  // checkout at the in-container workspace path; otherwise it runs on the host
  // against the checkout directly.
  const { workspace, exec, sandbox } = armExecution(arm, config);

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    // Aborted between attempts: stop here rather than spending a retry on a
    // run the human has already asked to end.
    if (signal?.aborted) break;

    const startedAt = new Date();
    const recovery = retryPrompt(
      previousError,
      attempt - 1,
      config.maxAttempts - 1,
    );
    // Continue the same Codex thread across retries when one exists; otherwise
    // restart fresh, prepending the recovery context to the original task.
    const continuing = threadId !== undefined;
    const attemptPrompt =
      attempt === 1
        ? prompt
        : continuing
          ? recovery
          : `${prompt}\n\n${recovery}`;
    const request = continuing
      ? { tool: "codex-reply", threadId, prompt: attemptPrompt }
      : {
          tool: "codex",
          ...(arm.container ? { container: arm.container } : {}),
          ...codexArguments(attemptPrompt, workspace, sandbox),
        };
    const artifactDir = await artifacts.startAttempt(
      arm,
      request,
      startedAt.toISOString(),
      attempt,
    );

    const stderrLog = artifacts.attemptStderrLog(arm.name, attempt);
    const base = {
      arm: arm.name,
      repo: arm.repo,
      attempt,
      maxAttempts: config.maxAttempts,
      startedAt: startedAt.toISOString(),
      artifactDir,
      stderrLog,
    };

    try {
      const result = await runner(
        {
          arm: arm.name,
          prompt: attemptPrompt,
          cwd: workspace,
          sandbox,
          codexHome: config.codexHome,
          idleTimeoutMs: config.idleTimeoutMs,
          threadId,
          exec,
          signal,
          stderrPath: stderrLog,
          ghToken: arm.ghToken,
        },
        (msg) => onEvent(arm.name, msg),
      );
      threadId = result.threadId ?? threadId;

      if (result.isError) {
        previousError = result.output || "arm reported an error";
        finalResult = await artifacts.finishArm(
          {
            ...base,
            status: "failed",
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt.getTime(),
            threadId,
            error: previousError,
            usage: result.usage,
          },
          result.raw,
        );
        continue;
      }

      return await artifacts.finishArm(
        {
          ...base,
          status: "succeeded",
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          threadId,
          output: result.output,
          usage: result.usage,
        },
        result.raw,
      );
    } catch (error) {
      previousError = error instanceof Error ? error.message : String(error);
      finalResult = await artifacts.finishArm({
        ...base,
        status: "failed",
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        threadId,
        error: previousError,
        // A thrown session still spent what it spent — the watchdog abort is the
        // expensive case, not the cheap one.
        usage: sessionUsage(error),
      });
    }
  }

  if (!finalResult) {
    throw new Error(
      signal?.aborted
        ? `${arm.name} aborted before its first attempt started`
        : `${arm.name} arm completed without a result`,
    );
  }
  return finalResult;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runHarness(
  config: HarnessConfig,
  sinks: HarnessSinks = {},
  // Tears down every arm at once — see runArm.
  signal?: AbortSignal,
  deps: HarnessDeps = {},
): Promise<HarnessRunResult> {
  const prompt = workerPrompt(config.ticket);
  const provenance = await (deps.provenance ?? harnessProvenance)();
  const artifacts = await RunArtifacts.create(config, prompt, provenance);
  const runner = deps.runner ?? runArmStreaming;
  const github = deps.github ?? gitHubForArm;
  const wait = deps.wait ?? sleep;
  const now = deps.now ?? Date.now;
  const onEvent: ArmEventSink = sinks.onEvent ?? (() => {});
  const note = (arm: ArmName, text: string): void =>
    sinks.onArmNote?.(arm, text);

  try {
    // Both checkouts go back to origin's default branch *before* either session
    // starts: a subticket has to begin where the last one landed, and doing it
    // up front means a sync failure costs nothing already in flight.
    const baselines: Partial<Record<ArmName, Baseline>> = {};
    for (const arm of config.arms) {
      const baseline = await prepareArm(arm, config, {
        github: github(arm),
        note: (text) => note(arm.name, text),
      });
      if (baseline) baselines[arm.name] = baseline;
    }
    await artifacts.recordBaselines(baselines);

    const landings: LandingRecord[] = [];
    const results = await Promise.all(
      config.arms.map(async (arm) => {
        const result = await runArm(
          arm,
          prompt,
          config,
          artifacts,
          runner,
          onEvent,
          signal,
        );

        // The work is not done when the session says it is: the pull request
        // still has to be found, answered for (if this arm has a reviewer), and
        // merged. That happens on the same Codex thread and the same event
        // sinks, so the live view keeps watching one continuous arm.
        const { workspace, exec, sandbox } = armExecution(arm, config);
        const record = await landArm(arm, config, result, {
          github: github(arm),
          note: (text) => note(arm.name, text),
          wait,
          now,
          reply: (reviewPrompt) =>
            runner(
              {
                arm: arm.name,
                prompt: reviewPrompt,
                cwd: workspace,
                sandbox,
                codexHome: config.codexHome,
                idleTimeoutMs: config.idleTimeoutMs,
                threadId: result.threadId,
                exec,
                signal,
                stderrPath: artifacts.reviewStderrLog(arm.name),
                ghToken: arm.ghToken,
              },
              (msg) => onEvent(arm.name, msg),
            ),
        });
        landings.push(record);

        const failure = landingError(record);
        const landed = await artifacts.recordLanding(
          record,
          failure
            ? { ...result, status: "failed", error: failure }
            : result,
        );
        note(arm.name, landingSummary(record));

        sinks.onLanding?.(record);
        sinks.onArmComplete?.(landed);
        return landed;
      }),
    );

    await artifacts.complete(results);
    const status = results.some((result) => result.status === "failed")
      ? "completed_with_failures"
      : "completed";
    return {
      runId: artifacts.runId,
      artifactDir: artifacts.directory,
      status,
      results,
      landings,
    };
  } catch (error) {
    await artifacts.fail(error);
    throw error;
  }
}
