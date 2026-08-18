import {
  RunArtifacts,
  type PersistedArmResult,
} from "./artifacts.js";
import type { ArmPhase } from "./arms.js";
import type { ArmConfig, ArmName, HarnessConfig, SandboxMode } from "./config.js";
import type { Baseline, GitHubFactory } from "./github.js";
import { gitHubForArm } from "./github.js";
import {
  provisionArmEnvironment,
  type EnvironmentFactory,
  type TranscriptCapture,
} from "./environment.js";
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
  createArmSession,
  runArmStreaming,
  type ArmSession,
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
  // What the arm has moved on to. Announced at each transition rather than
  // inferred from the notes: the notes are prose and get rewritten, and a view
  // that guessed at them would start lying the next time one is reworded.
  onArmPhase?: (arm: string, phase: ArmPhase) => void;
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
  sessionFactory?: typeof createArmSession;
  github?: GitHubFactory;
  environment?: EnvironmentFactory;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface HarnessRunResult {
  runId: string;
  artifactDir: string;
  status: "completed" | "completed_with_failures";
  results: ArmResult[];
  landings: LandingRecord[];
}

// Where and how this arm's Codex runs: in its Firecracker microVM via `sbx
// exec`, or directly on the host against the checkout. Shared by the build
// attempts and review rounds so the two cannot drift apart.
export function armExecution(
  arm: ArmConfig,
  config: HarnessConfig,
): { workspace: string; exec?: string[]; sandbox: SandboxMode } {
  const isolated = arm.sandboxName !== undefined;
  // Not configurable: sandbox-run.sh always clones the arm's remote into
  // /workspace, so a different cwd here would point outside the checkout.
  const workspace = isolated ? "/workspace" : arm.repo;
  return {
    workspace,
    exec: isolated
      ? [
          "sbx",
          "exec",
          "-i",
          "-w",
          workspace,
          "-e",
          "GH_TOKEN=proxy-managed",
          "-e",
          "GITHUB_TOKEN=proxy-managed",
          arm.sandboxName as string,
        ]
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
  captureTranscript?: TranscriptCapture,
): Promise<ArmResult> {
  let threadId: string | undefined;
  let previousError = "The previous attempt did not complete.";
  let finalResult: ArmResult | undefined;

  // In sandbox mode the arm's Codex runs via `sbx exec` and sees its checkout
  // at the microVM path; otherwise it runs on the host directly.
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
          ...(arm.sandboxName ? { sandboxName: arm.sandboxName } : {}),
          ...codexToolArguments({
            prompt: attemptPrompt,
            cwd: workspace,
            sandbox,
            fastMode: config.fastMode,
          }),
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
          fastMode: config.fastMode,
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
          captureTranscript,
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
        captureTranscript,
      );
    } catch (error) {
      previousError = error instanceof Error ? error.message : String(error);
      finalResult = await artifacts.finishArm(
        {
          ...base,
          status: "failed",
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          threadId,
          error: previousError,
        },
        undefined,
        captureTranscript,
      );
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

// Resolves early on abort — and clears the timer, so a quit does not leave a
// pending setTimeout keeping the process alive for the rest of a poll interval
// after landing and teardown have already returned. Exported for that test
// alone: it is the production wait behind every landing-phase poll.
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export async function runHarness(
  config: HarnessConfig,
  sinks: HarnessSinks = {},
  // Tears down every arm at once — see runArm.
  signal?: AbortSignal,
  deps: HarnessDeps = {},
): Promise<HarnessRunResult> {
  // parseArgs leaves the ticket blank on purpose — the ladder loop fills it
  // per subticket. A run reaching here without one is a wiring bug, and both
  // arms would otherwise burn a full session on an empty instruction.
  if (!config.ticket.trim()) {
    throw new Error("runHarness needs a ticket; the ladder loop supplies one per subticket");
  }
  const prompt = workerPrompt(config.ticket);
  const artifacts = await RunArtifacts.create(config, prompt);
  const workBranch = `vivarium/${artifacts.runId}`;
  let runner = deps.runner;
  const github = deps.github ?? gitHubForArm;
  const environmentFactory = deps.environment ?? provisionArmEnvironment;
  const wait = deps.wait ?? sleep;
  const now = deps.now ?? Date.now;
  const onEvent: ArmEventSink = sinks.onEvent ?? (() => {});
  const note = (arm: ArmName, text: string): void =>
    sinks.onArmNote?.(arm, text);
  const phase = (arm: ArmName, label: ArmPhase): void =>
    sinks.onArmPhase?.(arm, label);
  let environment: Awaited<ReturnType<EnvironmentFactory>> | undefined;
  let runtimeConfig = config;
  const baselines: Partial<Record<ArmName, Baseline>> = {};
  const sessions = new Map<ArmName, ArmSession>();

  try {
    environment = await environmentFactory(config, artifacts.runId, note);
    runtimeConfig = environment.config;
    // Both checkouts get the same run-unique branch name from origin's default
    // branch *before* either session starts. Besides keeping their starting
    // points aligned, this gives immediate-stop rollback an explicit identity
    // no concurrent branch can impersonate after the baseline snapshot.
    for (const arm of runtimeConfig.arms) {
      phase(arm.name, "preparing");
      const baseline = await prepareArm(
        {
          github: github(arm),
          note: (text) => note(arm.name, text),
        },
        workBranch,
      );
      if (baseline) baselines[arm.name] = baseline;
    }
    await artifacts.recordBaselines(baselines);

    // One MCP server per arm and subticket. `codex-reply` resolves thread IDs
    // inside that server's registry, so retries and review rounds must not
    // replace it with a fresh process. Preparation stays ahead of this: a sync
    // failure should not start either expensive worker.
    if (!runner) {
      for (const arm of runtimeConfig.arms) {
        const execution = armExecution(arm, runtimeConfig);
        sessions.set(
          arm.name,
          await (deps.sessionFactory ?? createArmSession)({
            arm: arm.name,
            cwd: execution.workspace,
            codexHome: runtimeConfig.codexHome,
            exec: execution.exec,
          }),
        );
      }
      runner = (params, onEvent) => {
        const session = sessions.get(params.arm as ArmName);
        if (!session) throw new Error(`no Codex session for ${params.arm}`);
        return session.run(params, onEvent);
      };
    }

    const landDeps = (arm: ArmConfig, result: { threadId?: string }) => {
      const { workspace, exec, sandbox } = armExecution(arm, runtimeConfig);
      return {
        github: github(arm),
        note: (text: string) => note(arm.name, text),
        phase: (label: ArmPhase) => phase(arm.name, label),
        wait,
        now,
        // The same abort that tears down the sessions: without it a quit
        // during "waiting for review" sits out the rest of the review timeout.
        signal,
        reply: (reviewPrompt: string) =>
          runner!(
            {
              arm: arm.name,
              prompt: reviewPrompt,
              cwd: workspace,
              sandbox,
              fastMode: runtimeConfig.fastMode,
              codexHome: runtimeConfig.codexHome,
              idleTimeoutMs: runtimeConfig.idleTimeoutMs,
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
      runtimeConfig.arms.map((arm) => {
        phase(arm.name, "building");
        return runArm(
          arm,
          prompt,
          runtimeConfig,
          artifacts,
          runner!,
          onEvent,
          signal,
          environment?.captureTranscript,
        ).then((result) => {
          // Each arm reaches the build barrier independently. Mark an early
          // finisher immediately so its displayed duration does not charge it
          // for a slower peer's remaining build time.
          phase(arm.name, "waiting on peer");
          return result;
        });
      }),
    );

    // Both builds have reached the barrier, so their clocks resume together
    // for pull-request discovery and the reversible landing phase.
    for (const arm of runtimeConfig.arms) phase(arm.name, "landing");

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
      for (const arm of runtimeConfig.arms) {
        phase(arm.name, "held back");
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
              arm: runtimeConfig.arms[index]!.name,
              status: result.status === "failed" ? "not-attempted" : "blocked",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              reviewer: runtimeConfig.arms[index]!.reviewer,
              reviewRounds: [],
              conversation: [],
              notes: [],
            }) satisfies LandingRecord,
        )
      : await Promise.all(
          runtimeConfig.arms.map((arm, index) =>
            reviewArm(
              arm,
              runtimeConfig,
              built[index]!,
              landDeps(arm, built[index]!),
            ),
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
        const arm = runtimeConfig.arms[index]!;
        const deps = landDeps(arm, built[index]!);
        phase(arm.name, blockers.length > 0 ? "held back" : "merging");
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
          environment?.captureTranscript,
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
  } finally {
    await Promise.allSettled(
      [...sessions.values()].map((session) => session.close()),
    );
    const cleanupErrors: string[] = [];
    // A confirmed immediate stop is a rollback boundary, not merely a process
    // kill. The session is closed first so it cannot push again while the
    // harness closes its open PR and removes the feature ref. Use the exact
    // runtime arms owned by this call; the recovery script's prefix scan is
    // intentionally too broad to run while another climb may be active.
    if (signal?.aborted) {
      await Promise.all(
        runtimeConfig.arms.map(async (arm) => {
          const baseline = baselines[arm.name];
          // No recorded baseline means this arm never reached worker
          // execution, so there is no run-created GitHub state to discard.
          if (!baseline) return;
          note(arm.name, "discarding interrupted GitHub work");
          try {
            const outcome = await github(arm).discardCurrentWork(baseline);
            const removed = [
              outcome.pullRequestClosed && outcome.pullRequest !== undefined
                ? `closed PR #${outcome.pullRequest}`
                : undefined,
              outcome.branchDeleted && outcome.branch
                ? `deleted remote branch ${outcome.branch}`
                : undefined,
            ].filter((entry): entry is string => entry !== undefined);
            note(
              arm.name,
              removed.length > 0
                ? `interrupted GitHub cleanup: ${removed.join("; ")}`
                : "interrupted GitHub cleanup: nothing was pushed",
            );
          } catch (cleanupError) {
            const message =
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError);
            cleanupErrors.push(`${arm.name}: ${message}`);
            note(
              arm.name,
              `interrupted GitHub cleanup was incomplete: ${message}`,
            );
          }
        }),
      );
    }
    if (environment) {
      try {
        await environment.cleanup();
      } catch (cleanupError) {
        const message =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        cleanupErrors.push(message);
        for (const arm of environment.config.arms) {
          note(
            arm.name,
            `ephemeral cleanup failed after the run settled: ${message}`,
          );
        }
      }
    }
    if (cleanupErrors.length > 0) {
      // Cleanup follows completed landing and is therefore diagnostic only:
      // rejecting here would make Greg repeat a subticket whose pull requests
      // may already be merged. An immediate stop exits nonzero already; retain
      // any incomplete rollback in the same durable diagnostic without
      // masking the run's primary outcome.
      await artifacts
        .recordCleanupError(new Error(cleanupErrors.join("\n")))
        .catch(() => {});
    }
    await artifacts.release();
  }
}
