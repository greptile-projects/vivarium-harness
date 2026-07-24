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
  // Tear this session down from outside — the human quitting the live view
  // under --abort-on-quit. It joins the same abort path the watchdog uses, so
  // the MCP client is closed and its codex subprocess dies with it rather than
  // being orphaned by a bare process exit.
  signal?: AbortSignal;
}

export interface StreamResult {
  threadId?: string;
  output: string;
  isError: boolean;
  timedOut: boolean;
  raw?: unknown;
}

// Whatever the host's Codex is set up with, a harness session gets neither
// account connectors nor plugins:
//
//   apps    — the `codex_apps` connectors (Linear, GitHub, …) are **account**-
//             scoped: they ride in on `$CODEX_HOME/auth.json` alone, not on
//             anything in config.toml. arm-run.sh mounts the host's auth.json
//             into every arm container, so without this an "isolated" arm can
//             still read the experiment's own Linear board and reach the
//             account's GitHub — around its per-arm GH_TOKEN. Neither a bare
//             CODEX_HOME nor a second auth file for the same account withholds
//             them; only this flag does.
//   plugins — whatever the operator happens to have installed (greptile,
//             github@openai-curated, the bundled sites/browser/computer-use
//             set) would otherwise be an uncontrolled variable in the
//             experiment, and would hand Greg tools the plan is supposed to be
//             blind to. Containerized arms have no config.toml and so no
//             plugins anyway; this closes the host-mode path and Greg's, which
//             always runs on the host against the operator's real CODEX_HOME.
//
// `mcp_servers` from config.toml are deliberately **left alone** — they are
// explicit deployment configuration, not ambient account state.
//
// This has to be set *here*, in the tool call. On the `codex mcp-server` path
// the process-level switches are silently ignored — `--disable apps` and
// `-c features.apps=false` on the argv both leave the connectors live (verified
// against codex 0.145.0; they do work for `codex exec`, which is the trap).
// What the session actually honours is `config`, the per-call override of
// CODEX_HOME/config.toml. `codex-reply` needs no equivalent: it continues a
// thread that was already created with this override.
const AMBIENT_TOOLING_OFF = {
  features: { apps: false, plugins: false },
} as const;

// Arguments for a fresh `codex` tool call. Pure and exported so a test can pin
// the kill-switches — the rest of this module spawns real processes and cannot
// be exercised offline.
export function codexToolArguments(
  params: Pick<StreamParams, "prompt" | "cwd" | "sandbox">,
): Record<string, unknown> {
  return {
    prompt: params.prompt,
    cwd: params.cwd,
    sandbox: params.sandbox,
    "approval-policy": "never",
    config: AMBIENT_TOOLING_OFF,
  };
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
    name: `vivarium-${params.arm}`,
    version: "0.1.0",
  });

  // Activity watchdog: each `codex/event` resets the idle timer; a stretch of
  // silence longer than idleTimeoutMs aborts the call. This catches wedged
  // runs quickly instead of waiting out the 24h hard ceiling.
  const idleTimeoutMs = params.idleTimeoutMs ?? 600_000;
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  // An external abort (the human quitting under --abort-on-quit) funnels into
  // the same controller the watchdog uses, so there is one teardown path
  // rather than two. `aborted` is tracked separately from `timedOut` so the
  // recorded error says which of the two stopped the session.
  let aborted = false;
  const onExternalAbort = (): void => {
    aborted = true;
    controller.abort(params.signal?.reason);
  };
  if (params.signal?.aborted) onExternalAbort();
  else params.signal?.addEventListener("abort", onExternalAbort, { once: true });
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
          : codexToolArguments(params),
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
    if (aborted) {
      throw new Error(`${params.arm} aborted: the live view was quit`);
    }
    if (timedOut) {
      throw new Error(
        `watchdog aborted ${params.arm}: no activity for ${idleTimeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    params.signal?.removeEventListener("abort", onExternalAbort);
    // Best-effort cleanup; never let a close error mask the original outcome.
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
}
