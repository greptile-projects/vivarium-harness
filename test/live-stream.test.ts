import { describe, expect, test } from "bun:test";
import {
  attachSessionUsage,
  cleanEnv,
  codexToolArguments,
  contextWindowFrom,
  sessionUsage,
  tokenUsageFrom,
} from "../src/live/stream.js";

const params = {
  prompt: "build the thing",
  cwd: "/workspace",
  sandbox: "workspace-write" as const,
};

describe("codexToolArguments", () => {
  test("carries the session's prompt, cwd and sandbox", () => {
    const args = codexToolArguments(params);
    expect(args.prompt).toBe("build the thing");
    expect(args.cwd).toBe("/workspace");
    expect(args.sandbox).toBe("workspace-write");
  });

  test("never asks for approval — no one is watching", () => {
    expect(codexToolArguments(params)["approval-policy"]).toBe("never");
  });

  // The isolation guarantee, stated as a test. codex_apps connectors (Linear,
  // GitHub) are account-scoped and arrive with the auth.json that arm-run.sh
  // mounts into every container, so no config.toml — and no second auth file
  // for the same account — can withhold them. Plugins are whatever the operator
  // happens to have installed, which is an uncontrolled variable in an A/B
  // experiment. Only this override withholds either, and only here: on the
  // mcp-server path `--disable apps` and `-c features.apps=false` on the argv
  // are both ignored. Drop this and every arm silently regains the experiment's
  // own Linear board, and Greg regains the operator's plugins.
  test("disables account connectors and plugins for every session", () => {
    expect(codexToolArguments(params).config).toEqual({
      features: { apps: false, plugins: false },
    });
  });

  // config.toml `mcp_servers` are explicit deployment configuration, not
  // ambient account state — the override must not touch them.
  test("leaves configured mcp_servers alone", () => {
    expect(codexToolArguments(params).config).not.toHaveProperty("mcp_servers");
  });
});

// What a session cost. Pinned here because this shape is Codex's, not ours: it
// only ever reached the live view's context meter before, so a drift in the
// payload would have silently emptied the one cost number in the record.
describe("tokenUsageFrom", () => {
  test("reads the thread's running totals off a token_count event", () => {
    expect(
      tokenUsageFrom({
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 900,
            cached_input_tokens: 400,
            output_tokens: 100,
            reasoning_output_tokens: 60,
            total_tokens: 1_000,
          },
          model_context_window: 400_000,
        },
      }),
    ).toEqual({
      inputTokens: 900,
      cachedInputTokens: 400,
      outputTokens: 100,
      reasoningOutputTokens: 60,
      totalTokens: 1_000,
      contextWindow: 400_000,
    });
  });

  test("ignores every other event, and a token_count with no totals", () => {
    expect(tokenUsageFrom({ type: "task_started" })).toBeUndefined();
    expect(tokenUsageFrom({ type: "token_count" })).toBeUndefined();
    expect(
      tokenUsageFrom({ type: "token_count", info: {} }),
    ).toBeUndefined();
  });
});

describe("contextWindowFrom", () => {
  test("takes the window from task_started or from token_count's info", () => {
    expect(
      contextWindowFrom({ type: "task_started", model_context_window: 272_000 }),
    ).toBe(272_000);
    expect(
      contextWindowFrom({
        type: "token_count",
        info: { model_context_window: 400_000 },
      }),
    ).toBe(400_000);
    expect(contextWindowFrom({ type: "item_started" })).toBeUndefined();
  });
});

// The environment a session inherits. This is an isolation guarantee as much as
// a publishing one: `cleanEnv` copies the whole environment, so a host-mode arm
// used to be handed *both* arms' GitHub tokens and the experiment's Linear key —
// which a session that runs `env` then writes into a transcript meant to be
// published.
describe("cleanEnv", () => {
  const source = {
    PATH: "/usr/bin",
    CONTROL_GH_TOKEN: "ghp_control",
    GREPTILE_GH_TOKEN: "ghp_greptile",
    VIVARIUM_GIT_TOKEN: "ghp_helper",
    LINEAR_API_KEY: "lin_api_secret",
  };

  test("strips every credential the harness holds for itself", () => {
    const env = cleanEnv(undefined, undefined, source);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CONTROL_GH_TOKEN).toBeUndefined();
    expect(env.GREPTILE_GH_TOKEN).toBeUndefined();
    expect(env.VIVARIUM_GIT_TOKEN).toBeUndefined();
    // features.apps=false already withholds the Linear connector; leaving the
    // API key in the environment was the same door with a different handle.
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("ghp_");
  });

  test("gives an arm exactly one token — its own", () => {
    const env = cleanEnv("/codex", "ghp_mine", source);
    expect(env.GH_TOKEN).toBe("ghp_mine");
    expect(env.GITHUB_TOKEN).toBe("ghp_mine");
    expect(env.CODEX_HOME).toBe("/codex");
    // And no trace of the other arm's.
    expect(JSON.stringify(env)).not.toContain("ghp_control");
    expect(JSON.stringify(env)).not.toContain("ghp_greptile");
  });

  test("Greg gets no token at all — he pushes nothing", () => {
    const env = cleanEnv("/codex", undefined, source);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("session usage on a thrown session", () => {
  // The expensive case is the one that dies — a watchdog abort forty minutes in
  // was not free — so the usage has to survive the throw.
  test("rides out on the error and reads back", () => {
    const error = attachSessionUsage(new Error("watchdog aborted"), {
      totalTokens: 41_000,
    });
    expect(sessionUsage(error)).toEqual({ totalTokens: 41_000 });
  });

  test("is invisible to JSON and to callers that do not ask", () => {
    // A non-enumerable symbol: an error carrying usage must still serialize and
    // compare like the plain error it is.
    const error = attachSessionUsage(new Error("boom"), { totalTokens: 1 });
    expect(Object.keys(error as object)).toEqual([]);
    expect((error as Error).message).toBe("boom");
  });

  test("says nothing when there was nothing to say", () => {
    expect(sessionUsage(new Error("boom"))).toBeUndefined();
    expect(sessionUsage(attachSessionUsage(new Error("b"), undefined))).toBeUndefined();
    expect(sessionUsage("not an error")).toBeUndefined();
    expect(sessionUsage(undefined)).toBeUndefined();
  });
});
