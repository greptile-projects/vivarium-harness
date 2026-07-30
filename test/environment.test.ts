import { describe, expect, it } from "bun:test";
import type { HarnessConfig } from "../src/harness/config.js";
import { provisionArmEnvironment } from "../src/harness/environment.js";
import type {
  CommandResult,
  CommandRunner,
} from "../src/harness/github.js";

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
});

function config(isolated = true): HarnessConfig {
  return {
    ticket: "1.1 Build it",
    arms: [
      {
        name: "komodo",
        repo: isolated
          ? "https://github.com/org/komodo.git"
          : "/tmp/komodo",
        sandboxName: isolated ? "vivarium-komodo" : undefined,
        ghToken: "komodo-token",
      },
      {
        name: "tuatara",
        repo: isolated
          ? "https://github.com/org/tuatara.git"
          : "/tmp/tuatara",
        sandboxName: isolated ? "vivarium-tuatara" : undefined,
        ghToken: "tuatara-token",
      },
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
  };
}

function recorder(
  reply?: (
    command: string,
    args: string[],
  ) => CommandResult | undefined,
) {
  const calls: Array<{
    command: string;
    args: string[];
    env?: Record<string, string>;
  }> = [];
  const exec: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    return reply?.(command, args) ?? ok();
  };
  return { calls, exec };
}

describe("ephemeral arm environments", () => {
  it("creates unique per-subticket sandboxes and isolates their networks", async () => {
    const { calls, exec } = recorder();
    const environment = await provisionArmEnvironment(
      config(),
      "run-abcdefghijkl",
      () => {},
      exec,
    );

    const names = environment.config.arms.map((arm) => arm.sandboxName);
    expect(names).toEqual([
      "vivarium-komodo-abcdefghijkl",
      "vivarium-tuatara-abcdefghijkl",
    ]);
    const launches = calls.filter((call) =>
      call.command.endsWith("scripts/sandbox-run.sh"),
    );
    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      const sandbox = launch.env?.VIVARIUM_SANDBOX_NAME;
      expect(sandbox).toMatch(/^vivarium-(komodo|tuatara)-abcdefghijkl$/);
      expect(launch.env?.VIVARIUM_WORKSPACE_MOUNT).toBe(
        `/tmp/${sandbox}-host`,
      );
      expect(launch.env?.VIVARIUM_LADDER_MOUNT).toBe(
        "/tmp/vivarium-ladder-abcdefghijkl",
      );
      expect(launch.env?.VIVARIUM_RUN_ID).toBe("run-abcdefghijkl");
      expect(JSON.stringify(launch)).not.toContain("CODEX_HOME");
    }
    const denies = calls.filter(
      (call) =>
        call.command === "sbx" &&
        call.args.slice(0, 3).join(" ") === "policy deny network",
    );
    expect(denies).toHaveLength(12);
    expect(denies.some((call) => call.args.at(-1) === names[0])).toBe(true);
    expect(denies.some((call) => call.args.at(-1) === names[1])).toBe(true);
    expect(
      denies.filter((call) => call.args.at(-1) === "host.docker.internal"),
    ).toHaveLength(2);

    await environment.cleanup();
    for (const sandbox of names) {
      expect(
        calls.some(
          (call) =>
            call.command === "sbx" &&
            call.args.join(" ") ===
              `secret rm ${sandbox} github --force`,
        ),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.command === "sbx" &&
            call.args.join(" ") === `rm --force ${sandbox}`,
        ),
      ).toBe(true);
    }
  });

  it("finds and copies only the current thread transcript", async () => {
    const { calls, exec } = recorder((command, args) => {
      if (command === "sbx" && args.includes("find")) {
        return ok(
          "/home/agent/.codex/sessions/2026/07/27/rollout-current-thread.jsonl\n",
        );
      }
      return undefined;
    });
    const environment = await provisionArmEnvironment(
      config(),
      "run-abcdefghijkl",
      () => {},
      exec,
    );
    const arm = environment.config.arms[0];
    const source = await environment.captureTranscript?.(
      arm.name,
      "current-thread",
      "/tmp/transcript.jsonl",
    );

    expect(source).toBe(
      `${arm.sandboxName}:/home/agent/.codex/sessions/2026/07/27/rollout-current-thread.jsonl`,
    );
    const find = calls.find(
      (call) => call.command === "sbx" && call.args.includes("find"),
    );
    expect(find?.args).toContain("*-current-thread.jsonl");
    const copy = calls.find(
      (call) => call.command === "sbx" && call.args[0] === "cp",
    );
    expect(copy?.args).toEqual([
      "cp",
      `${arm.sandboxName}:/home/agent/.codex/sessions/2026/07/27/rollout-current-thread.jsonl`,
      "/tmp/transcript.jsonl",
    ]);
  });

  it("cleans up every runtime when provisioning one arm fails", async () => {
    const { calls, exec } = recorder((command, args) => {
      if (
        command.endsWith("scripts/sandbox-run.sh") &&
        args[0] === "tuatara"
      ) {
        return { code: 1, stdout: "", stderr: "clone failed" };
      }
      return undefined;
    });

    await expect(
      provisionArmEnvironment(config(), "run-abcdefghijkl", () => {}, exec),
    ).rejects.toThrow(/clone failed/);
    expect(
      calls.filter(
        (call) => call.command === "sbx" && call.args[0] === "rm",
      ),
    ).toHaveLength(2);
  });

  it("leaves the explicit host smoke path unchanged", async () => {
    const { calls, exec } = recorder();
    const original = config(false);
    const environment = await provisionArmEnvironment(
      original,
      "run-abcdefghijkl",
      () => {},
      exec,
    );

    expect(environment.config).toBe(original);
    expect(environment.captureTranscript).toBeUndefined();
    await environment.cleanup();
    expect(calls).toEqual([]);
  });
});
