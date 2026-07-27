import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  parseRunMode,
  validateConfig,
  CONTAINER_IMAGE,
  IDLE_TIMEOUT_MS,
  MAX_ATTEMPTS,
  RESULTS_DIR,
  type HarnessConfig,
} from "../src/harness/config.js";
import { codexToolArguments } from "../src/harness/session.js";
import { workerPrompt } from "../src/harness/prompts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const env = {
  KOMODO_REPO: "/tmp/komodo",
  TUATARA_REPO: "/tmp/tuatara",
};

describe("parseArgs", () => {
  it("accepts only the ticket as a per-run input", () => {
    const config = parseArgs(["--ticket", "ENG-123"], env);

    expect(config.ticket).toBe("ENG-123");
    expect(config.arms.map((arm) => [arm.name, arm.repo])).toEqual([
      ["komodo", "/tmp/komodo"],
      ["tuatara", "/tmp/tuatara"],
    ]);
    // The one asymmetry between the arms, and it comes from configuration
    // rather than from a name check somewhere downstream.
    expect(config.arms[0].reviewer).toBeUndefined();
    expect(config.arms[1].reviewer).toBe("greptile-apps[bot]");
    expect(config.containerImage).toBe(CONTAINER_IMAGE);
  });

  // "" is falsy where the landing phase checks `arm.reviewer`, so an empty
  // GREPTILE_BOT_LOGIN= line in .env would otherwise switch off every review
  // round — the experiment's whole variable — while the run reported itself
  // normal.
  it("treats a blank reviewer login as unset, never as no reviewer", () => {
    const blank = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      GREPTILE_BOT_LOGIN: "",
    });
    expect(blank.arms[1].reviewer).toBe("greptile-apps[bot]");

    const spaces = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      GREPTILE_BOT_LOGIN: "   ",
    });
    expect(spaces.arms[1].reviewer).toBe("greptile-apps[bot]");

    const custom = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      GREPTILE_BOT_LOGIN: "other-reviewer[bot]",
    });
    expect(custom.arms[1].reviewer).toBe("other-reviewer[bot]");
  });

  it("shares the configured image with container launchers", () => {
    const config = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      VIVARIUM_IMAGE: "vivarium-arm:test",
    });

    expect(config.containerImage).toBe("vivarium-arm:test");
  });

  it("gives a containerized arm full access and a host arm a sandbox", () => {
    const containerized = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      KOMODO_CONTAINER: "vivarium-komodo",
    });
    // The container is the isolation boundary; inside it the arm needs the
    // network to push a branch and answer a review.
    expect(containerized.arms[0].sandbox).toBe("danger-full-access");
    expect(containerized.arms[1].sandbox).toBe("workspace-write");

    // An explicit setting still wins for both arms.
    const explicit = parseArgs(["--ticket", "ENG-123"], {
      ...env,
      KOMODO_CONTAINER: "vivarium-komodo",
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
      KOMODO_GH_TOKEN: "ghp_control",
      TUATARA_GH_TOKEN: "ghp_greptile",
    });
    expect(config.arms.map((arm) => arm.ghToken)).toEqual([
      "ghp_control",
      "ghp_greptile",
    ]);
  });

  it("requires static arm configuration", () => {
    expect(() => parseArgs(["--ticket", "ENG-123"], {})).toThrow(
      /KOMODO_REPO.*TUATARA_REPO/,
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

  it("treats --ticket as a one-ticket run", () => {
    expect(parseRunMode(["--ticket", "ENG-1"], true)).toMatchObject({
      kind: "ticket",
      ticket: "ENG-1",
    });
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
    expect(() => parseRunMode(["--ticket", "ENG-1", "--unbounded"], true)).toThrow(
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

  it("takes no flag for what quitting means", () => {
    // Quitting the view stops the run, always — the safety is the in-view
    // confirmation, not an argv opt-in, so there is nothing here to parse and
    // nothing a caller can forget to pass.
    expect(parseRunMode([], true)).not.toHaveProperty("abortOnQuit");
    // A script still passing the old flag is asking for what now always
    // happens, so it keeps running rather than dying on an argument that has
    // stopped meaning anything.
    expect(() => parseRunMode(["--abort-on-quit", "--no-tui"], true)).not.toThrow();
  });
});

describe("worker fan-out", () => {
  it("constructs the shared prompt exactly once from the ticket", () => {
    const prompt = workerPrompt("ENG-123");

    expect(prompt).toContain("ENG-123");
    expect(prompt).not.toMatch(/komodo arm|tuatara arm/i);
  });

  it("varies only cwd between Codex calls", () => {
    const prompt = workerPrompt("ENG-123");
    const komodo = codexToolArguments({
      prompt,
      cwd: "/tmp/komodo",
      sandbox: "workspace-write",
    });
    const tuatara = codexToolArguments({
      prompt,
      cwd: "/tmp/tuatara",
      sandbox: "workspace-write",
    });
    const { cwd: controlCwd, ...controlShared } = komodo;
    const { cwd: greptileCwd, ...greptileShared } = tuatara;

    expect(controlCwd).not.toBe(greptileCwd);
    expect(controlShared).toEqual(greptileShared);
  });
});

// Isolation has to be all-or-nothing. Each arm derives `container` — and so its
// sandbox — from its own `<ARM>_CONTAINER`, so one unset variable leaves that
// arm running Codex on the host at workspace-write while the other runs in a
// container at danger-full-access: different sandbox, different tool reach, and
// the host-mode arm can read the other arm's checkout and .env directly. The
// manifest would record it as a perfectly normal run.
describe("validateConfig containerization", () => {
  const twoRepos = async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-cfg-"));
    temporaryDirectories.push(root);
    const komodo = join(root, "komodo");
    const tuatara = join(root, "tuatara");
    await mkdir(komodo, { recursive: true });
    await mkdir(tuatara, { recursive: true });
    return { komodo, tuatara };
  };

  const config = (
    komodo: string,
    tuatara: string,
    containers: { komodo?: string; tuatara?: string },
  ) =>
    ({
      ticket: "t",
      arms: [
        { name: "komodo", repo: komodo, container: containers.komodo },
        { name: "tuatara", repo: tuatara, container: containers.tuatara },
      ],
      sandbox: "workspace-write",
      resultsDir: "results",
      codexHome: "/tmp/codex",
      maxAttempts: 1,
      idleTimeoutMs: 1,
      reviewTimeoutMs: 1,
      reviewPollMs: 1,
      reviewDebounceMs: 0,
      reviewRounds: 1,
    }) as unknown as HarnessConfig;

  it("rejects one arm containerized and the other on the host", async () => {
    const { komodo, tuatara } = await twoRepos();
    await expect(
      validateConfig(config(komodo, tuatara, { komodo: "vivarium-komodo" })),
    ).rejects.toThrow(/TUATARA_CONTAINER/);
  });

  it("accepts both containerized", async () => {
    const resolved = await validateConfig(
      config(
        "https://github.com/example/vivarium-komodo.git",
        "https://github.com/example/vivarium-tuatara.git",
        {
        komodo: "vivarium-komodo",
        tuatara: "vivarium-tuatara",
        },
      ),
    );
    expect(resolved.arms.every((arm) => arm.container)).toBe(true);
    expect(resolved.arms.map((arm) => arm.repo)).toEqual([
      "https://github.com/example/vivarium-komodo.git",
      "https://github.com/example/vivarium-tuatara.git",
    ]);
  });

  it("rejects local checkout paths in container mode", async () => {
    const { komodo, tuatara } = await twoRepos();
    await expect(
      validateConfig(
        config(komodo, tuatara, {
          komodo: "vivarium-komodo",
          tuatara: "vivarium-tuatara",
        }),
      ),
    ).rejects.toThrow(/HTTPS GitHub clone URL/);
  });

  it("rejects the same container remote in both arms", async () => {
    await expect(
      validateConfig(
        config(
          "https://github.com/example/repo.git",
          "https://github.com/EXAMPLE/REPO",
          {
            komodo: "vivarium-komodo",
            tuatara: "vivarium-tuatara",
          },
        ),
      ),
    ).rejects.toThrow(/different GitHub repositories/);
  });

  it("rejects credentials embedded in a container remote", async () => {
    await expect(
      validateConfig(
        config(
          "https://secret@github.com/example/komodo.git",
          "https://github.com/example/tuatara.git",
          {
            komodo: "vivarium-komodo",
            tuatara: "vivarium-tuatara",
          },
        ),
      ),
    ).rejects.toThrow(/must not contain credentials/);
  });

  it("rejects duplicate ephemeral container name prefixes", async () => {
    await expect(
      validateConfig(
        config(
          "https://github.com/example/komodo.git",
          "https://github.com/example/tuatara.git",
          {
            komodo: "vivarium-arm",
            tuatara: "vivarium-arm",
          },
        ),
      ),
    ).rejects.toThrow(/different name prefixes/);
  });

  it("accepts neither containerized — the no-isolation smoke path", async () => {
    const { komodo, tuatara } = await twoRepos();
    const resolved = await validateConfig(config(komodo, tuatara, {}));
    expect(resolved.arms.some((arm) => arm.container)).toBe(false);
  });
});
