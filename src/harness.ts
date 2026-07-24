import {
  RunArtifacts,
  type PersistedArmResult,
} from "./artifacts.js";
import type { ArmConfig, HarnessConfig } from "./config.js";
import { workerPrompt } from "./prompt.js";
import {
  runArmStreaming,
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

// Injectable so tests can simulate arms without spawning a real Codex process.
export type AttemptRunner = (
  params: StreamParams,
  onEvent: (msg: CodexMsg) => void,
) => Promise<StreamResult>;

export interface HarnessRunResult {
  runId: string;
  artifactDir: string;
  status: "completed" | "completed_with_failures";
  results: ArmResult[];
}

export function codexArguments(
  prompt: string,
  repo: string,
  sandbox: HarnessConfig["sandbox"],
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
  const containerized = arm.container !== undefined;
  const workspace = containerized ? arm.workspace ?? "/workspace" : arm.repo;
  const exec = containerized
    ? ["docker", "exec", "-i", "-w", workspace, arm.container as string]
    : undefined;

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
          ...codexArguments(attemptPrompt, workspace, config.sandbox),
        };
    const artifactDir = await artifacts.startAttempt(
      arm,
      request,
      startedAt.toISOString(),
      attempt,
    );

    const base = {
      arm: arm.name,
      repo: arm.repo,
      attempt,
      maxAttempts: config.maxAttempts,
      startedAt: startedAt.toISOString(),
      artifactDir,
    };

    try {
      const result = await runner(
        {
          arm: arm.name,
          prompt: attemptPrompt,
          cwd: workspace,
          sandbox: config.sandbox,
          codexHome: config.codexHome,
          idleTimeoutMs: config.idleTimeoutMs,
          threadId,
          exec,
          signal,
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

export async function runHarness(
  config: HarnessConfig,
  onEvent: ArmEventSink = () => {},
  onArmComplete: ArmCompleteSink = () => {},
  // Tears down every arm at once — see runArm.
  signal?: AbortSignal,
): Promise<HarnessRunResult> {
  const prompt = workerPrompt(config.ticket);
  const artifacts = await RunArtifacts.create(config, prompt);

  try {
    const results = await Promise.all(
      config.arms.map((arm) =>
        runArm(
          arm,
          prompt,
          config,
          artifacts,
          runArmStreaming,
          onEvent,
          signal,
        ).then((result) => {
          onArmComplete(result);
          return result;
        }),
      ),
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
    };
  } catch (error) {
    await artifacts.fail(error);
    throw error;
  }
}
