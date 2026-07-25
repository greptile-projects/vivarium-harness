import { describe, expect, it } from "bun:test";
import {
  parseArgs,
  parseRunMode,
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
    expect(config.arms.map((arm) => [arm.name, arm.repo])).toEqual([
      ["control", "/tmp/control"],
      ["greptile", "/tmp/greptile"],
    ]);
    // The one asymmetry between the arms, and it comes from configuration
    // rather than from a name check somewhere downstream.
    expect(config.arms[0].reviewer).toBeUndefined();
    expect(config.arms[1].reviewer).toBe("greptile-apps[bot]");
  });

  it("gives a containerized arm full access and a host arm a sandbox", () => {
    const containerized = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      CONTROL_CONTAINER: "vivarium-control",
    });
    // The container is the isolation boundary; inside it the arm needs the
    // network to push a branch and answer a review.
    expect(containerized.arms[0].sandbox).toBe("danger-full-access");
    expect(containerized.arms[1].sandbox).toBe("workspace-write");

    // An explicit setting still wins for both arms.
    const explicit = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      CONTROL_CONTAINER: "vivarium-control",
      CODEX_SANDBOX: "workspace-write",
    });
    expect(explicit.arms.map((arm) => arm.sandbox)).toEqual([
      "workspace-write",
      "workspace-write",
    ]);
  });

  it("passes each arm's GitHub token through for landing", () => {
    const config = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      CONTROL_GH_TOKEN: "ghp_control",
      GREPTILE_GH_TOKEN: "ghp_greptile",
    });
    expect(config.arms.map((arm) => arm.ghToken)).toEqual([
      "ghp_control",
      "ghp_greptile",
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

describe("run mode", () => {
  it("defaults to the ladder loop with no arguments", () => {
    const mode = parseRunMode([], true);

    expect(mode.kind).toBe("ladder");
    expect(mode.planOnly).toBe(false);
    expect(mode.unbounded).toBe(false);
    expect(mode.ticket).toBeUndefined();
  });

  it("treats --ticket and --demo as one-ticket runs", () => {
    expect(parseRunMode(["--ticket", "ENG-1"], true)).toMatchObject({
      kind: "ticket",
      ticket: "ENG-1",
    });
    expect(parseRunMode(["--demo"], true).kind).toBe("demo");
  });

  it("keeps --plan-only and --unbounded on the ladder", () => {
    const mode = parseRunMode(["--plan-only", "--unbounded"], true);

    expect(mode.kind).toBe("ladder");
    expect(mode.planOnly).toBe(true);
    expect(mode.unbounded).toBe(true);
  });

  // Silently ignoring one of two typed flags is the failure mode worth
  // guarding: it would look like the run honoured both.
  it("rejects ladder options combined with a one-ticket run", () => {
    expect(() => parseRunMode(["--ticket", "ENG-1", "--plan-only"], true)).toThrow(
      /--plan-only/,
    );
    expect(() => parseRunMode(["--demo", "--unbounded"], true)).toThrow(
      /--unbounded/,
    );
  });

  it("rejects --ticket without a value instead of falling back to the ladder", () => {
    expect(() => parseRunMode(["--ticket", "--json"], true)).toThrow(
      /--ticket requires a value/,
    );
  });

  it("resolves the view from the flags, then the terminal", () => {
    expect(parseRunMode([], true).useTui).toBe(true);
    expect(parseRunMode([], false).useTui).toBe(false);
    expect(parseRunMode(["--tui"], false).useTui).toBe(true);
    expect(parseRunMode(["--no-tui"], true).useTui).toBe(false);
    // --json is for machines; it must not fight the TUI for the terminal.
    expect(parseRunMode(["--json"], true)).toMatchObject({
      json: true,
      useTui: false,
    });
    expect(parseRunMode(["--json", "--tui"], false).useTui).toBe(true);
  });

  it("leaves the run alive when the view is quit unless asked otherwise", () => {
    // The default matters: `q` is how you stop watching a climb meant to run
    // for days, and it must not also kill hours of arm work.
    expect(parseRunMode([], true).abortOnQuit).toBe(false);
    expect(parseRunMode(["--abort-on-quit"], true).abortOnQuit).toBe(true);
  });

  it("rejects --abort-on-quit when there is no view to quit", () => {
    // The flag arms a key in a view that will not exist, so the run it was
    // meant to be able to kill would run to completion regardless.
    expect(() => parseRunMode(["--abort-on-quit", "--no-tui"], true)).toThrow(
      /no live view/,
    );
    expect(() => parseRunMode(["--abort-on-quit", "--json"], true)).toThrow(
      /no live view/,
    );
    expect(() => parseRunMode(["--abort-on-quit"], false)).toThrow(
      /no live view/,
    );
    // Explicitly asking for the view makes it coherent again.
    expect(
      parseRunMode(["--abort-on-quit", "--tui"], false).abortOnQuit,
    ).toBe(true);
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
