import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
  // watchdog). Default 4 minutes; set <= 0 to disable.
  idleTimeoutMs?: number;
  // When set, continue an existing Codex thread (codex-reply) instead of
  // starting a fresh session.
  threadId?: string;
  // Where to tee the codex subprocess's stderr. Unset leaves the SDK's default
  // (`inherit`), which writes it to the harness's own terminal — under the
  // fullscreen view that means painting it onto the alternate screen, which is
  // discarded on exit. So the one output that explains *why* a session died
  // (a container that is not running, a bad mount, an auth failure, a codex
  // panic) was the one output nothing kept: `error.txt` gets the MCP-level
  // message and nothing else.
  stderrPath?: string;
  // This arm's own GitHub token, passed through as GH_TOKEN. See cleanEnv: the
  // harness's copies of *both* arms' tokens are stripped, so this is the only
  // credential a session sees.
  ghToken?: string;
  // Tear this session down from outside — the human quitting the live view
  // under --abort-on-quit. It joins the same abort path the watchdog uses, so
  // the MCP client is closed and its codex subprocess dies with it rather than
  // being orphaned by a bare process exit.
  signal?: AbortSignal;
}

// What one session cost. Codex reports it on `token_count` events, which until
// now only ever reached the live view's context meter and the tee — so "how much
// did each arm spend" existed as a number on a screen and a line in a
// gitignored log, and nowhere in the durable record beside the wall-clock
// duration that *was* persisted.
//
// These are the totals Codex reports for the **thread**, not for one turn, so
// they are cumulative across the attempts and review rounds that share a
// thread: take the last value per thread, never the sum (see `totalTokens` in
// artifacts.ts).
export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
}

export interface StreamResult {
  threadId?: string;
  output: string;
  isError: boolean;
  timedOut: boolean;
  raw?: unknown;
  // The last usage snapshot seen on this session, when Codex reported one.
  usage?: TokenUsage;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// Pull the usage snapshot out of a `token_count` event. Pure and exported so the
// shape Codex sends is pinned by a test — the rest of this module spawns real
// processes and cannot be exercised offline.
export function tokenUsageFrom(msg: CodexMsg): TokenUsage | undefined {
  if (msg.type !== "token_count") return undefined;
  const info = msg.info as
    | {
        total_token_usage?: Record<string, unknown>;
        model_context_window?: unknown;
      }
    | undefined;
  const total = info?.total_token_usage;
  if (!total) return undefined;
  return {
    inputTokens: num(total.input_tokens),
    cachedInputTokens: num(total.cached_input_tokens),
    outputTokens: num(total.output_tokens),
    reasoningOutputTokens: num(total.reasoning_output_tokens),
    totalTokens: num(total.total_tokens),
    contextWindow: num(info?.model_context_window),
  };
}

// The context window is announced on `task_started` and repeated inside
// `token_count`; take it from whichever arrives.
export function contextWindowFrom(msg: CodexMsg): number | undefined {
  const direct = num(msg.model_context_window);
  if (direct !== undefined) return direct;
  const info = msg.info as { model_context_window?: unknown } | undefined;
  return num(info?.model_context_window);
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

// What a Codex session is allowed to inherit. An allowlist, not a copy of
// `process.env`: Bun loads `.env`, so the harness process holds `KOMODO_REPO`,
// `TUATARA_REPO`, both `<ARM>_GH_TOKEN`s and `LINEAR_API_KEY`. Forwarding all
// of it meant one `env | grep REPO` told a host-mode arm it was one of two and
// where the other one lived — and handed it the other arm's token, which
// reaches the other arm's repository around its own token's scope. Container
// mode never had the problem (`docker exec` forwards no host environment); this
// closes the host path, which `validateConfig` now also makes hard to enter by
// accident.
//
// It is also what keeps a credential out of the *record*: a session that runs
// `env`, or a tool that dumps its environment on failure, writes whatever it was
// given into a transcript this experiment intends to publish.
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  // The arm's own GitHub credentials, set per-arm by the caller rather than
  // read from the ambient environment.
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CODEX_HOME",
];

export function cleanEnv(
  codexHome?: string,
  // The arm's own token, which is what the allowlist comment above means by "set
  // per-arm by the caller": passed explicitly it wins over any ambient GH_TOKEN,
  // so an arm acts as itself rather than as whoever launched the harness.
  ghToken?: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  if (codexHome) env.CODEX_HOME = codexHome;
  if (ghToken) {
    env.GH_TOKEN = ghToken;
    env.GITHUB_TOKEN = ghToken;
  }
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

  // Capturing stderr means not inheriting it, which also keeps a chatty codex
  // from painting over the fullscreen view.
  if (params.stderrPath) {
    await mkdir(dirname(params.stderrPath), { recursive: true });
  }
  const transport = new StdioClientTransport({
    command,
    args: [...prefixArgs, ...(exec.length > 0 ? ["codex"] : []), "mcp-server"],
    env: cleanEnv(params.codexHome, params.ghToken),
    // Only anchor the host spawn dir when running locally; under `docker exec`
    // params.cwd is an in-container path that need not exist on the host.
    cwd: exec.length > 0 ? undefined : params.cwd,
    stderr: params.stderrPath ? "pipe" : undefined,
  });

  // Append, and stamp each session: review rounds all write to one file per arm,
  // so without a header a reader cannot tell which round a stack trace came
  // from. The stream is opened before connect() so a subprocess that dies during
  // the handshake — the case this exists for — still lands its output.
  let stderrFile: ReturnType<typeof createWriteStream> | undefined;
  if (params.stderrPath) {
    stderrFile = createWriteStream(params.stderrPath, { flags: "a" });
    stderrFile.write(
      `\n=== ${new Date().toISOString()} ${params.arm} ${command} ${
        params.threadId ? `(reply ${params.threadId})` : "(fresh session)"
      } ===\n`,
    );
    transport.stderr?.pipe(stderrFile, { end: false });
  }
  const client = new Client({
    name: `vivarium-${params.arm}`,
    version: "0.1.0",
  });

  // Activity watchdog: each `codex/event` resets the idle timer; a stretch of
  // silence longer than idleTimeoutMs aborts the call. This catches wedged
  // runs quickly instead of waiting out the 24h hard ceiling.
  const idleTimeoutMs = params.idleTimeoutMs ?? 240_000;
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

  // The last usage snapshot Codex reported on this session, kept so the result
  // carries it into the artifacts instead of it living only on the event stream.
  let usage: TokenUsage | undefined;
  let contextWindow: number | undefined;

  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== "codex/event") return;
    bumpWatchdog();
    const raw = notification.params as
      | { msg?: CodexMsg; _meta?: CodexEventMeta }
      | undefined;
    if (!raw?.msg) return;
    contextWindow = contextWindowFrom(raw.msg) ?? contextWindow;
    const reported = tokenUsageFrom(raw.msg);
    if (reported) usage = reported;
    onEvent(raw.msg, raw._meta ?? {});
  };

  // Usage as recorded, with the context window filled in from whichever event
  // carried it. Built at every exit so a session that fails partway still
  // reports what it had spent getting there.
  const recordedUsage = (): TokenUsage | undefined => {
    if (!usage) {
      return contextWindow === undefined ? undefined : { contextWindow };
    }
    return { ...usage, contextWindow: usage.contextWindow ?? contextWindow };
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
      usage: recordedUsage(),
    };
  } catch (error) {
    // A session that dies is exactly the one whose spend is interesting — a
    // watchdog abort forty minutes in was not free — so the usage rides out on
    // the error rather than being dropped with the frame.
    if (aborted) {
      throw attachSessionUsage(
        new Error(`${params.arm} aborted: the live view was quit`),
        recordedUsage(),
      );
    }
    if (timedOut) {
      throw attachSessionUsage(
        new Error(
          `watchdog aborted ${params.arm}: no activity for ${idleTimeoutMs}ms`,
        ),
        recordedUsage(),
      );
    }
    throw attachSessionUsage(error, recordedUsage());
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    params.signal?.removeEventListener("abort", onExternalAbort);
    // Best-effort cleanup; never let a close error mask the original outcome.
    try {
      await client.close();
    } catch {
      // ignore
    }
    // Closed after the client, so anything the subprocess wrote on its way down
    // is already through the pipe. `end: false` on the pipe above is what makes
    // closing here ours to do.
    stderrFile?.end();
  }
}

// Usage carried on a thrown session failure. A property on the error rather
// than a second channel: every caller already has the error in hand, and the
// alternative is threading a mutable out-param through the retry loop.
const SESSION_USAGE = Symbol.for("vivarium.sessionUsage");

export function attachSessionUsage(
  error: unknown,
  usage: TokenUsage | undefined,
): unknown {
  if (usage && typeof error === "object" && error !== null) {
    Object.defineProperty(error, SESSION_USAGE, {
      value: usage,
      enumerable: false,
    });
  }
  return error;
}

export function sessionUsage(error: unknown): TokenUsage | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const usage = (error as Record<symbol, unknown>)[SESSION_USAGE];
  return usage as TokenUsage | undefined;
}
