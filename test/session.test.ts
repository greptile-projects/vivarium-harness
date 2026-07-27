import { describe, expect, test } from "bun:test";
import {
  cleanEnv as sessionEnv,
  codexToolArguments,
} from "../src/harness/session.js";

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

// Bun loads .env into the harness process, so process.env holds KOMODO_REPO,
// TUATARA_REPO, both <ARM>_GH_TOKENs and LINEAR_API_KEY. Forwarding all of it
// meant one `env | grep REPO` told a host-mode arm it was one of two and where
// the other one lived — and handed it the other arm's token, which reaches the
// other arm's repository around its own token's scope.
describe("session environment", () => {
  test("forwards an allowlist, not the harness's whole environment", () => {
    const before = { ...process.env };
    process.env.KOMODO_REPO = "/tmp/komodo";
    process.env.TUATARA_REPO = "/tmp/tuatara";
    process.env.KOMODO_GH_TOKEN = "ghp_komodo";
    process.env.TUATARA_GH_TOKEN = "ghp_tuatara";
    process.env.LINEAR_API_KEY = "lin_api_secret";
    process.env.PATH = "/usr/bin";

    try {
      const env = sessionEnv("/tmp/codex");

      // Nothing that names the other arm, or lets you reach it.
      expect(env.KOMODO_REPO).toBeUndefined();
      expect(env.TUATARA_REPO).toBeUndefined();
      expect(env.KOMODO_GH_TOKEN).toBeUndefined();
      expect(env.TUATARA_GH_TOKEN).toBeUndefined();
      expect(env.LINEAR_API_KEY).toBeUndefined();
      expect(Object.values(env)).not.toContain("ghp_tuatara");

      // What a session genuinely needs still arrives.
      expect(env.PATH).toBe("/usr/bin");
      expect(env.CODEX_HOME).toBe("/tmp/codex");
    } finally {
      process.env = before;
    }
  });

  test("passes through the arm's own GitHub token", () => {
    const before = { ...process.env };
    process.env.GH_TOKEN = "ghp_this_arm";
    try {
      expect(sessionEnv().GH_TOKEN).toBe("ghp_this_arm");
    } finally {
      process.env = before;
    }
  });
});
