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
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  codexHome?: string;
  timeoutMs?: number;
}

export interface StreamResult {
  threadId?: string;
  output: string;
  isError: boolean;
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
 * `codex/event` notification to `onEvent` as it arrives. Unlike the
 * `@openai/agents` client the harness uses, this registers a notification
 * handler, so the live stream is observed instead of discarded.
 */
export async function runArmStreaming(
  params: StreamParams,
  onEvent: EventSink,
): Promise<StreamResult> {
  const transport = new StdioClientTransport({
    command: "codex",
    args: ["mcp-server"],
    env: cleanEnv(params.codexHome),
    cwd: params.cwd,
  });
  const client = new Client({
    name: `terrarium-${params.arm}`,
    version: "0.1.0",
  });

  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== "codex/event") return;
    const raw = notification.params as
      | { msg?: CodexMsg; _meta?: CodexEventMeta }
      | undefined;
    if (raw?.msg) onEvent(raw.msg, raw._meta ?? {});
  };

  await client.connect(transport);
  try {
    const result = (await client.callTool(
      {
        name: "codex",
        arguments: {
          prompt: params.prompt,
          cwd: params.cwd,
          sandbox: params.sandbox,
          "approval-policy": "never",
        },
        _meta: { progressToken: `${params.arm}-progress` },
      },
      undefined,
      // Codex streams custom `codex/event` notifications, not standard
      // `notifications/progress`, so the SDK cannot reset this on activity —
      // it is a hard ceiling on a single arm's run. 24h fits a long rung.
      { timeout: params.timeoutMs ?? 86_400_000 },
    )) as {
      structuredContent?: { threadId?: string };
      content?: unknown;
      isError?: boolean;
    };

    return {
      threadId: result.structuredContent?.threadId,
      output: extractOutput(result),
      isError: Boolean(result.isError),
    };
  } finally {
    await client.close();
  }
}
