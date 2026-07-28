import type { ArmPhase } from "../harness/arms.js";
import type { CodexMsg } from "../harness/session.js";

export type ArmStatus = "starting" | "working" | "done" | "failed";

export interface ArmState {
  arm: string;
  status: ArmStatus;
  // What the run says this arm has moved on to, when it is more specific than
  // its status: waiting on a review, merging, held back by its peer. Set by the
  // harness at each transition, never guessed from the activity text.
  phase?: ArmPhase;
  model?: string;
  activity: string;
  // The last `ACTIVITY_HISTORY` activity lines, oldest first — what the arm's
  // own tab shows so a single `activity` string is not the whole story.
  recent: string[];
  tokens?: number;
  contextWindow?: number;
  events: number;
  startedAt: number;
  endedAt?: number;
  answer?: string;
  error?: string;
  threadId?: string;
}

// Enough to fill a tall pane, bounded so a long run cannot grow without limit.
const ACTIVITY_HISTORY = 200;

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

// Events worth surfacing as transitions; deltas and raw items stay in the
// stream but out of the human-readable tee.
export const NOISY = new Set([
  "agent_message_content_delta",
  "raw_response_item",
  "raw_response_completed",
  "item_completed",
  "user_message",
]);

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
        | { last_token_usage?: { total_tokens?: unknown } }
        | undefined;
      return `context tokens ${num(info?.last_token_usage?.total_tokens) ?? "?"}`;
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
    recent: [],
    events: 0,
    startedAt: Date.now(),
  };
}

// Set the arm's current activity and remember it. Consecutive repeats collapse
// (a burst of reasoning items would otherwise fill the history with one word).
function setActivity(state: ArmState, activity: string): void {
  state.activity = activity;
  if (state.recent[state.recent.length - 1] === activity) return;
  state.recent.push(activity);
  if (state.recent.length > ACTIVITY_HISTORY) state.recent.shift();
}

export class LiveStore {
  readonly arms = new Map<string, ArmState>();
  private readonly listeners = new Set<() => void>();

  register(arm: string): void {
    if (!this.arms.has(arm)) this.arms.set(arm, initialArm(arm));
    this.emit();
  }

  // Clear every panel so the store can be reused for the next phase of a
  // multi-phase run (Greg alternates planning and building sessions).
  reset(): void {
    this.arms.clear();
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
        setActivity(state, `starting MCP: ${str(msg.server) ?? "?"}`);
        break;
      case "mcp_startup_complete":
        setActivity(state, "tools ready");
        break;
      case "item_started":
      case "item_completed": {
        const activity = describeItem(msg.item);
        if (activity) setActivity(state, activity);
        break;
      }
      case "agent_message_content_delta":
        setActivity(state, "responding…");
        state.answer = `${state.answer ?? ""}${str(msg.delta) ?? ""}`;
        break;
      case "agent_message":
        state.answer = str(msg.message) ?? state.answer;
        break;
      case "token_count": {
        const info = msg.info as
          | { last_token_usage?: { total_tokens?: unknown } }
          | undefined;
        // `total_token_usage` accumulates every model call in the session, so
        // dividing it by one context window eventually reports impossible
        // values. The latest call is the context currently occupying that
        // window; cached input is already a subset of its input token count.
        state.tokens = num(info?.last_token_usage?.total_tokens) ?? state.tokens;
        break;
      }
      default:
        break;
    }
    this.emit();
  }

  // Progress that is not a codex/event: the landing phase (waiting on a
  // review, merging) is the arm working with its session idle, and it belongs
  // on the same activity trail rather than in a second place.
  note(arm: string, text: string): void {
    const state = this.arms.get(arm);
    if (!state) return;
    setActivity(state, text);
    this.emit();
  }

  // What the arm has moved on to. A phase arriving before the arm's first
  // codex/event also gets it off "starting": preparing the checkout is real
  // work, and it happens before any session exists.
  phase(arm: string, phase: ArmPhase): void {
    const state = this.arms.get(arm);
    if (!state) return;
    state.phase = phase;
    if (state.status === "starting") state.status = "working";
    this.emit();
  }

  finish(arm: string, result: { error?: string; threadId?: string }): void {
    const state = this.arms.get(arm);
    if (!state) return;
    state.endedAt = Date.now();
    state.threadId = result.threadId ?? state.threadId;
    // The arm has settled: "merging" would outlive the merge it described.
    state.phase = undefined;
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
