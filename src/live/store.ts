import type { CodexMsg } from "./stream.js";

export type ArmStatus = "starting" | "working" | "done" | "failed";

export interface ArmState {
  arm: string;
  status: ArmStatus;
  model?: string;
  activity: string;
  tokens?: number;
  contextWindow?: number;
  events: number;
  startedAt: number;
  endedAt?: number;
  answer?: string;
  error?: string;
  threadId?: string;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Turn an `item_started`/`item_completed` payload into a short activity line.
function describeItem(item: unknown): string | undefined {
  const record = (item ?? {}) as Record<string, unknown>;
  const type = str(record.type);
  switch (type) {
    case "Reasoning":
      return "reasoning…";
    case "AgentMessage":
    case "AssistantMessage":
      return "writing answer…";
    case "CommandExecution": {
      const command = str(record.command);
      return command ? `$ ${command.slice(0, 48)}` : "running command…";
    }
    case "FileChange":
      return "editing files…";
    case "McpToolCall": {
      const server = str(record.server);
      return server ? `tool: ${server}` : "calling tool…";
    }
    case "WebSearch":
      return "searching web…";
    case "UserMessage":
      return undefined;
    default:
      return type ?? undefined;
  }
}

// Compact one-line summary for the progress.log tee.
export function summarize(msg: CodexMsg): string {
  switch (msg.type) {
    case "session_configured":
      return `model ${str(msg.model) ?? "?"}`;
    case "mcp_startup_update":
      return `mcp ${str(msg.server) ?? "?"} starting`;
    case "task_started":
      return `turn started (ctx ${num(msg.model_context_window) ?? "?"})`;
    case "item_started":
    case "item_completed":
      return describeItem(msg.item) ?? msg.type;
    case "agent_message":
      return `answer: ${(str(msg.message) ?? "").slice(0, 60)}`;
    case "token_count": {
      const info = msg.info as
        | { total_token_usage?: { total_tokens?: unknown } }
        | undefined;
      return `tokens ${num(info?.total_token_usage?.total_tokens) ?? "?"}`;
    }
    case "task_complete":
      return `done in ${num(msg.duration_ms) ?? "?"}ms`;
    default:
      return msg.type;
  }
}

function initialArm(arm: string): ArmState {
  return {
    arm,
    status: "starting",
    activity: "connecting…",
    events: 0,
    startedAt: Date.now(),
  };
}

export class LiveStore {
  readonly arms = new Map<string, ArmState>();
  private readonly listeners = new Set<() => void>();

  register(arm: string): void {
    if (!this.arms.has(arm)) this.arms.set(arm, initialArm(arm));
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ArmState[] {
    return [...this.arms.values()];
  }

  applyEvent(arm: string, msg: CodexMsg): void {
    const state = this.arms.get(arm);
    if (!state) return;
    state.events += 1;
    if (state.status === "starting") state.status = "working";

    switch (msg.type) {
      case "session_configured":
        state.model = str(msg.model) ?? state.model;
        state.threadId = str(msg.thread_id) ?? state.threadId;
        break;
      case "task_started":
        state.contextWindow = num(msg.model_context_window) ?? state.contextWindow;
        break;
      case "mcp_startup_update":
        state.activity = `starting MCP: ${str(msg.server) ?? "?"}`;
        break;
      case "mcp_startup_complete":
        state.activity = "tools ready";
        break;
      case "item_started":
      case "item_completed": {
        const activity = describeItem(msg.item);
        if (activity) state.activity = activity;
        break;
      }
      case "agent_message_content_delta":
        state.activity = "responding…";
        state.answer = `${state.answer ?? ""}${str(msg.delta) ?? ""}`;
        break;
      case "agent_message":
        state.answer = str(msg.message) ?? state.answer;
        break;
      case "token_count": {
        const info = msg.info as
          | { total_token_usage?: { total_tokens?: unknown } }
          | undefined;
        state.tokens = num(info?.total_token_usage?.total_tokens) ?? state.tokens;
        break;
      }
      default:
        break;
    }
    this.emit();
  }

  finish(arm: string, result: { error?: string; threadId?: string }): void {
    const state = this.arms.get(arm);
    if (!state) return;
    state.endedAt = Date.now();
    state.threadId = result.threadId ?? state.threadId;
    // Leave `activity` on the last real thing the arm was doing — the status
    // word is already shown in the panel title/status, and the error/answer
    // lines carry the outcome.
    if (result.error) {
      state.status = "failed";
      state.error = result.error;
    } else {
      state.status = "done";
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
