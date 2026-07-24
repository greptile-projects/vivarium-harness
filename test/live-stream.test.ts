import { describe, expect, test } from "bun:test";
import { codexToolArguments } from "../src/live/stream.js";

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
  // for the same account — can withhold them. Only this override can, and only
  // here: on the mcp-server path `--disable apps` and `-c features.apps=false`
  // on the argv are both ignored. Drop this and every arm silently regains the
  // experiment's own Linear board.
  test("disables account connectors for every session", () => {
    expect(codexToolArguments(params).config).toEqual({
      features: { apps: false },
    });
  });
});
