import { MCPServerStdio } from "@openai/agents";
import {
  RunArtifacts,
  type PersistedArmResult,
} from "./artifacts.js";
import type { ArmConfig, HarnessConfig } from "./config.js";
import { workerPrompt } from "./prompt.js";

export type ArmResult = PersistedArmResult;

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

function resultText(result: Awaited<ReturnType<MCPServerStdio["callToolResult"]>>): string {
  const structured = result.structuredContent as
    | { content?: unknown }
    | undefined;
  if (typeof structured?.content === "string") {
    return structured.content;
  }

  const content = result.content as Array<{
    type?: string;
    text?: unknown;
  }>;
  const text = content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  return text || JSON.stringify(result.structuredContent ?? result.content);
}

function resultThreadId(
  result: Awaited<ReturnType<MCPServerStdio["callToolResult"]>>,
): string | undefined {
  const structured = result.structuredContent as
    | { threadId?: unknown }
    | undefined;
  if (typeof structured?.threadId === "string") {
    return structured.threadId;
  }

  const content = result.content as Array<{
    _meta?: { threadId?: unknown };
  }>;
  return content.find((item) => typeof item._meta?.threadId === "string")?._meta
    ?.threadId as string | undefined;
}

export async function runArm(
  server: Pick<MCPServerStdio, "callToolResult">,
  arm: ArmConfig,
  prompt: string,
  config: HarnessConfig,
  artifacts: RunArtifacts,
): Promise<ArmResult> {
  let threadId: string | undefined;
  let previousError = "The previous attempt did not complete.";
  let finalResult: ArmResult | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const startedAt = new Date();
    const recovery = retryPrompt(
      previousError,
      attempt - 1,
      config.maxAttempts - 1,
    );
    const toolName = threadId ? "codex-reply" : "codex";
    const request = threadId
      ? { prompt: recovery, threadId }
      : codexArguments(
          attempt === 1 ? prompt : `${prompt}\n\n${recovery}`,
          arm.repo,
          config.sandbox,
        );
    const artifactDir = await artifacts.startAttempt(
      arm,
      request,
      startedAt.toISOString(),
      attempt,
    );

    try {
      const response = await server.callToolResult(toolName, request);
      threadId = resultThreadId(response) ?? threadId;
      if (response.isError) {
        previousError = resultText(response);
        finalResult = await artifacts.finishArm({
          arm: arm.name,
          repo: arm.repo,
          attempt,
          maxAttempts: config.maxAttempts,
          status: "failed",
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          threadId,
          error: previousError,
          artifactDir,
        }, response);
        continue;
      }

      return await artifacts.finishArm({
        arm: arm.name,
        repo: arm.repo,
        attempt,
        maxAttempts: config.maxAttempts,
        status: "succeeded",
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        threadId,
        output: resultText(response),
        artifactDir,
      }, response);
    } catch (error) {
      previousError = error instanceof Error ? error.message : String(error);
      finalResult = await artifacts.finishArm({
        arm: arm.name,
        repo: arm.repo,
        attempt,
        maxAttempts: config.maxAttempts,
        status: "failed",
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        threadId,
        error: previousError,
        artifactDir,
      });
    }
  }

  if (!finalResult) {
    throw new Error(`${arm.name} arm completed without a result`);
  }
  return finalResult;
}

async function runArmIsolated(
  arm: ArmConfig,
  prompt: string,
  config: HarnessConfig,
  artifacts: RunArtifacts,
): Promise<ArmResult> {
  // Each arm gets its own codex mcp-server process so the two arms never share
  // an in-flight connection or per-process state (e.g. the active cwd). This
  // keeps them genuinely parallel and independent, as the experiment requires.
  const server = new MCPServerStdio({
    name: `Codex CLI (${arm.name})`,
    fullCommand: "codex mcp-server",
    clientSessionTimeoutSeconds: 86_400,
  });
  await server.connect();
  try {
    return await runArm(server, arm, prompt, config, artifacts);
  } finally {
    await server.close();
  }
}

export async function runHarness(
  config: HarnessConfig,
): Promise<HarnessRunResult> {
  const prompt = workerPrompt(config.ticket);
  const artifacts = await RunArtifacts.create(config, prompt);

  try {
    const results = await Promise.all(
      config.arms.map((arm) =>
        runArmIsolated(arm, prompt, config, artifacts),
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
