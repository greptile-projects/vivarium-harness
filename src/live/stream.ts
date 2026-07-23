import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A `codex/event` notification carries the same event stream Codex writes to
// its rollout transcript, but delivered live over the MCP connection while the
// tool call is still running. `msg.type` discriminates the event; we keep it
// loosely typed at this boundary and narrow in the reducer.
export interface CodexMsg {
  type: string;
  [key: string]: unknown;
}

export interface CodexEventMeta {
  requestId?: number;
  threadId?: string;
}

export type EventSink = (msg: CodexMsg, meta: CodexEventMeta) => void;

export interface StreamParams {
  arm: string;
  prompt: string;
  // The cwd Codex runs in — a host path locally, or the in-container workspace
  // (e.g. /workspace) when exec wraps the launch in `docker exec`.
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  codexHome?: string;
  // Command prefix that launches `codex mcp-server` somewhere other than the
  // host — e.g. ["docker", "exec", "-i", "<container>"] for per-arm container
  // isolation. Empty/undefined runs codex directly on the host.
  exec?: string[];
  // Hard ceiling on a single arm's run (default 24h).
  timeoutMs?: number;
  // Abort the run if no `codex/event` arrives for this long (activity
  // watchdog). Default 10 minutes; set <= 0 to disable.
  idleTimeoutMs?: number;
  // When set, continue an existing Codex thread (codex-reply) instead of
  // starting a fresh session.
  threadId?: string;
}

export interface StreamResult {
  threadId?: string;
  output: string;
  isError: boolean;
  timedOut: boolean;
  raw?: unknown;
}

function cleanEnv(codexHome?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}

function extractOutput(result: {
  structuredContent?: unknown;
  content?: unknown;
}): string {
  const structured = result.structuredContent as
    | { content?: unknown }
    | undefined;
  if (typeof structured?.content === "string") return structured.content;

  const content = (result.content ?? []) as Array<{
    type?: string;
    text?: unknown;
  }>;
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

/**
 * Run one Codex session over its own stdio MCP process, forwarding every
 * `codex/event` notification to `onEvent` as it arrives. Registering a
 * notification handler is what lets the harness observe the live event
 * stream — and drive the activity watchdog — instead of discarding it.
 */
export async function runArmStreaming(
  params: StreamParams,
  onEvent: EventSink,
): Promise<StreamResult> {
  const exec = params.exec ?? [];
  const [command, ...prefixArgs] = exec.length > 0 ? exec : ["codex"];
  const transport = new StdioClientTransport({
    command,
    args: [...prefixArgs, ...(exec.length > 0 ? ["codex"] : []), "mcp-server"],
    env: cleanEnv(params.codexHome),
    // Only anchor the host spawn dir when running locally; under `docker exec`
    // params.cwd is an in-container path that need not exist on the host.
    cwd: exec.length > 0 ? undefined : params.cwd,
  });
  const client = new Client({
    name: `terrarium-${params.arm}`,
    version: "0.1.0",
  });

  // Activity watchdog: each `codex/event` resets the idle timer; a stretch of
  // silence longer than idleTimeoutMs aborts the call. This catches wedged
  // runs quickly instead of waiting out the 24h hard ceiling.
  const idleTimeoutMs = params.idleTimeoutMs ?? 600_000;
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const bumpWatchdog = (): void => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new Error(`no codex/event for ${idleTimeoutMs}ms`),
      );
    }, idleTimeoutMs);
  };

  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== "codex/event") return;
    bumpWatchdog();
    const raw = notification.params as
      | { msg?: CodexMsg; _meta?: CodexEventMeta }
      | undefined;
    if (raw?.msg) onEvent(raw.msg, raw._meta ?? {});
  };

  try {
    // connect() spawns the codex mcp-server subprocess; keep it inside the
    // try so a failed handshake still hits the finally cleanup below.
    await client.connect(transport);
    bumpWatchdog();
    const continuing = params.threadId !== undefined;
    const result = (await client.callTool(
      {
        name: continuing ? "codex-reply" : "codex",
        arguments: continuing
          ? { threadId: params.threadId, prompt: params.prompt }
          : {
              prompt: params.prompt,
              cwd: params.cwd,
              sandbox: params.sandbox,
              "approval-policy": "never",
            },
        _meta: { progressToken: `${params.arm}-progress` },
      },
      undefined,
      { timeout: params.timeoutMs ?? 86_400_000, signal: controller.signal },
    )) as {
      structuredContent?: { threadId?: string };
      content?: unknown;
      isError?: boolean;
    };

    return {
      threadId: result.structuredContent?.threadId,
      output: extractOutput(result),
      isError: Boolean(result.isError),
      timedOut: false,
      raw: result,
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `watchdog aborted ${params.arm}: no activity for ${idleTimeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    // Best-effort cleanup; never let a close error mask the original outcome.
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
}
