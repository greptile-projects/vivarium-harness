import {
  RunArtifacts,
  type PersistedArmResult,
} from "./artifacts.js";
import type { ArmConfig, ArmName, HarnessConfig, SandboxMode } from "./config.js";
import type { Baseline, GitHubFactory } from "./github.js";
import { gitHubForArm } from "./github.js";
import {
  blockArm,
  landingError,
  landingSummary,
  mergeArm,
  prepareArm,
  reviewArm,
  type LandingRecord,
} from "./land.js";
import { retryPrompt, workerPrompt } from "./prompts.js";
import {
  codexToolArguments,
  runArmStreaming,
  type CodexMsg,
  type StreamParams,
  type StreamResult,
} from "./session.js";

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
  // Not configurable: arm-run.sh always bind-mounts the checkout at /workspace,
  // so a different cwd here would just point Codex at a path that isn't there.
  const workspace = containerized ? "/workspace" : arm.repo;
  return {
    workspace,
    exec: containerized
      ? ["docker", "exec", "-i", "-w", workspace, arm.container as string]
      : undefined,
    sandbox: arm.sandbox ?? config.sandbox,
  };
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
    // The recorded request is built from the same function that builds the
    // real tool call, so request.json shows what was actually sent — the
    // ambient-tooling kill-switches included.
    const request = continuing
      ? { tool: "codex-reply", threadId, prompt: attemptPrompt }
      : {
          tool: "codex",
          ...(arm.container ? { container: arm.container } : {}),
          ...codexToolArguments({ prompt: attemptPrompt, cwd: workspace, sandbox }),
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
          sandbox,
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
  const artifacts = await RunArtifacts.create(config, prompt);
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
      const baseline = await prepareArm({
        github: github(arm),
        note: (text) => note(arm.name, text),
      });
      if (baseline) baselines[arm.name] = baseline;
    }
    await artifacts.recordBaselines(baselines);

    const landDeps = (arm: ArmConfig, result: { threadId?: string }) => {
      const { workspace, exec, sandbox } = armExecution(arm, config);
      return {
        github: github(arm),
        note: (text: string) => note(arm.name, text),
        wait,
        now,
        reply: (reviewPrompt: string) =>
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
            },
            (msg) => onEvent(arm.name, msg),
          ),
      };
    };

    // BUILD — both arms concurrently.
    const built = await Promise.all(
      config.arms.map((arm) =>
        runArm(arm, prompt, config, artifacts, runner, onEvent, signal),
      ),
    );

    // BARRIER. Landing is the only irreversible thing the harness does, and it
    // is per-arm, so without a gate here one arm can permanently merge a rung
    // the other never built: the two mains diverge by a subticket and there is
    // no way back. Re-running lets the arm that already merged re-solve a
    // solved ticket in seconds and "win"; checking the box by hand means the
    // failed arm never builds that feature at all and every later rung is built
    // on a codebase missing it. Losing the rung loudly is strictly better, so
    // if any session failed, nobody reviews and nobody merges.
    const buildFailed = built.some((result) => result.status === "failed");
    if (buildFailed) {
      for (const arm of config.arms) {
        note(
          arm.name,
          "an arm's session failed — holding both back so neither lands alone",
        );
      }
    }

    // REVIEW — concurrently, and only when both arms have something to land.
    // This phase adds comments and answers them; it never touches either main,
    // so it is safe to run before the merge barrier.
    const reviewed = buildFailed
      ? built.map(
          (result, index) =>
            ({
              arm: config.arms[index]!.name,
              status: result.status === "failed" ? "not-attempted" : "blocked",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              reviewer: config.arms[index]!.reviewer,
              reviewRounds: [],
              conversation: [],
              notes: [],
            }) satisfies LandingRecord,
        )
      : await Promise.all(
          config.arms.map((arm, index) =>
            reviewArm(arm, config, built[index]!, landDeps(arm, built[index]!)),
          ),
        );

    // MERGE BARRIER. Every arm has to be mergeable before any arm merges. An
    // arm that is "skipped" (not a GitHub checkout) blocks nothing — there was
    // never anything to keep in step.
    const blockers = reviewed.filter(
      (record) => record.status !== "ready" && record.status !== "skipped",
    );
    const landings = await Promise.all(
      reviewed.map((record, index) => {
        const arm = config.arms[index]!;
        const deps = landDeps(arm, built[index]!);
        return blockers.length > 0
          ? blockArm(
              record,
              blockers
                .map((blocker) => `${blocker.arm} is ${blocker.status}`)
                .join(", "),
              deps,
            )
          : mergeArm(record, deps);
      }),
    );

    const results = await Promise.all(
      landings.map(async (record, index) => {
        const result = built[index]!;
        const failure = landingError(record);
        const landed = await artifacts.recordLanding(
          record,
          failure ? { ...result, status: "failed", error: failure } : result,
        );
        note(record.arm, landingSummary(record));
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
