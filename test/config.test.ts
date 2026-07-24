import { describe, expect, it } from "bun:test";
import {
  parseArgs,
  IDLE_TIMEOUT_MS,
  MAX_ATTEMPTS,
  RESULTS_DIR,
} from "../src/config.js";
import { codexArguments } from "../src/harness.js";
import { workerPrompt } from "../src/prompt.js";

const env = {
  CONTROL_REPO: "/tmp/control",
  GREPTILE_REPO: "/tmp/greptile",
};

describe("parseArgs", () => {
  it("accepts only the ticket as a per-run input", () => {
    const config = parseArgs(["--ticket", "ENG-123"], env);

    expect(config.ticket).toBe("ENG-123");
    expect(config.arms).toEqual([
      { name: "control", repo: "/tmp/control" },
      { name: "greptile", repo: "/tmp/greptile" },
    ]);
  });

  it("requires static arm configuration", () => {
    expect(() => parseArgs(["--ticket", "ENG-123"], {})).toThrow(
      /CONTROL_REPO.*GREPTILE_REPO/,
    );
  });

  it("uses the fixed experiment constants, not env overrides", () => {
    const config = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      // These are no longer configurable; they must be ignored.
      MAX_ATTEMPTS: "5",
      RESULTS_DIR: "/somewhere/else",
      CODEX_IDLE_TIMEOUT_MS: "1000",
    });
    expect(config.maxAttempts).toBe(MAX_ATTEMPTS);
    expect(config.resultsDir).toBe(RESULTS_DIR);
    expect(config.idleTimeoutMs).toBe(IDLE_TIMEOUT_MS);
  });
});

describe("worker fan-out", () => {
  it("constructs the shared prompt exactly once from the ticket", () => {
    const prompt = workerPrompt("ENG-123");

    expect(prompt).toContain("ENG-123");
    expect(prompt).not.toMatch(/control arm|greptile arm/i);
  });

  it("varies only cwd between Codex calls", () => {
    const prompt = workerPrompt("ENG-123");
    const control = codexArguments(prompt, "/tmp/control", "workspace-write");
    const greptile = codexArguments(prompt, "/tmp/greptile", "workspace-write");
    const { cwd: controlCwd, ...controlShared } = control;
    const { cwd: greptileCwd, ...greptileShared } = greptile;

    expect(controlCwd).not.toBe(greptileCwd);
    expect(controlShared).toEqual(greptileShared);
  });
});
