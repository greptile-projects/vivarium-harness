import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ArmConfig, ArmName, HarnessConfig } from "./config.js";
import {
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./github.js";

export type TranscriptCapture = (
  arm: ArmName,
  threadId: string,
  destination: string,
) => Promise<string | undefined>;

export interface ArmEnvironment {
  // Sandbox names are generated per subticket. Every downstream operation
  // must use this runtime config rather than the configured name prefixes.
  config: HarnessConfig;
  captureTranscript?: TranscriptCapture;
  cleanup(): Promise<void>;
}

export type EnvironmentFactory = (
  config: HarnessConfig,
  runId: string,
  note: (arm: ArmName, text: string) => void,
) => Promise<ArmEnvironment>;

interface RuntimeArm {
  arm: ArmConfig;
  sandboxName: string;
  scratch: string;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+/, "");
}

function runtimeEnvironment(
  config: HarnessConfig,
  runId: string,
): { runtimes: RuntimeArm[]; ladderMount: string } {
  const suffix = safeName(runId.slice(-12) || randomUUID().slice(0, 12));
  return {
    runtimes: config.arms.map((arm) => {
      const base = safeName(arm.sandboxName as string);
      const sandboxName = `${base}-${suffix}`;
      return {
        arm: { ...arm, sandboxName },
        sandboxName,
        scratch: join(tmpdir(), `${sandboxName}-host`),
      };
    }),
    ladderMount: join(tmpdir(), `vivarium-ladder-${suffix}`),
  };
}

function commandError(label: string, result: CommandResult): Error {
  return new Error(
    `${label}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
  );
}

async function cleanupRuntime(
  runtimes: RuntimeArm[],
  ladderMount: string,
  exec: CommandRunner,
): Promise<void> {
  const errors: string[] = [];
  for (const runtime of runtimes) {
    const secret = await exec("sbx", [
      "secret",
      "rm",
      runtime.sandboxName,
      "github",
      "--force",
    ]);
    if (
      secret.code !== 0 &&
      !/not found|does not exist|no secret/i.test(
        `${secret.stdout}\n${secret.stderr}`,
      )
    ) {
      errors.push(
        commandError(
          `remove credential for ${runtime.sandboxName}`,
          secret,
        ).message,
      );
    }
    const sandbox = await exec("sbx", ["rm", "--force", runtime.sandboxName]);
    if (
      sandbox.code !== 0 &&
      !/not found|does not exist|no sandbox/i.test(
        `${sandbox.stdout}\n${sandbox.stderr}`,
      )
    ) {
      errors.push(
        commandError(`remove sandbox ${runtime.sandboxName}`, sandbox).message,
      );
    }
    await rm(runtime.scratch, { recursive: true, force: true }).catch((error) => {
      errors.push(`remove scratch ${runtime.scratch}: ${String(error)}`);
    });
  }
  await rm(ladderMount, { recursive: true, force: true }).catch((error) => {
    errors.push(`remove ladder snapshot ${ladderMount}: ${String(error)}`);
  });
  if (errors.length > 0) {
    throw new Error(`ephemeral arm cleanup failed:\n${errors.join("\n")}`);
  }
}

export async function provisionArmEnvironment(
  config: HarnessConfig,
  runId: string,
  note: (arm: ArmName, text: string) => void,
  exec: CommandRunner = runCommand,
): Promise<ArmEnvironment> {
  const isolated = config.arms.every((arm) => arm.sandboxName !== undefined);
  if (!isolated) {
    return { config, async cleanup() {} };
  }

  const { runtimes, ladderMount } = runtimeEnvironment(config, runId);
  try {
    await mkdir(ladderMount, { recursive: true, mode: 0o755 });
    const ladderSnapshot = join(ladderMount, "LADDER.md");
    await copyFile(resolve("LADDER.md"), ladderSnapshot);

    await Promise.all(
      runtimes.map(async (runtime) => {
        note(
          runtime.arm.name,
          `starting fresh environment ${runtime.sandboxName}`,
        );
        const result = await exec(
          resolve("scripts/sandbox-run.sh"),
          [runtime.arm.name],
          {
            env: {
              VIVARIUM_SANDBOX_NAME: runtime.sandboxName,
              VIVARIUM_WORKSPACE_MOUNT: runtime.scratch,
              VIVARIUM_LADDER_MOUNT: ladderMount,
              VIVARIUM_RUN_ID: runId,
            },
          },
        );
        if (result.code !== 0) {
          throw commandError(
            `could not provision ${runtime.arm.name} environment`,
            result,
          );
        }
        note(runtime.arm.name, "fresh clone and services ready");
      }),
    );

    // Balanced mode prevents arbitrary private-network access, but sandboxes
    // are intentionally addressable by name and can reach host-published
    // ports through special aliases. Add explicit per-run denies before
    // either Codex session starts. A policy error is an isolation failure, not
    // a warning.
    await Promise.all(
      runtimes.map(async (runtime) => {
        const peer = runtimes.find(
          (candidate) => candidate.sandboxName !== runtime.sandboxName,
        )!;
        for (const target of [
          peer.sandboxName,
          "host.docker.internal",
          "gateway.docker.internal",
          "localhost",
          "127.0.0.1",
          "::1",
        ]) {
          const result = await exec("sbx", [
            "policy",
            "deny",
            "network",
            "--sandbox",
            runtime.sandboxName,
            target,
          ]);
          if (result.code !== 0) {
            throw commandError(
              `could not isolate ${runtime.sandboxName} from ${target}`,
              result,
            );
          }
        }
      }),
    );
  } catch (error) {
    await cleanupRuntime(runtimes, ladderMount, exec).catch(() => {});
    throw error;
  }

  const runtimeConfig: HarnessConfig = {
    ...config,
    arms: runtimes.map((runtime) => runtime.arm) as [ArmConfig, ArmConfig],
  };
  const runtimeByName = new Map(
    runtimes.map((runtime) => [runtime.arm.name, runtime]),
  );

  const captureTranscript: TranscriptCapture = async (
    arm,
    threadId,
    destination,
  ) => {
    const sandboxName = runtimeByName.get(arm)?.sandboxName;
    if (!sandboxName) return undefined;
    const found = await exec("sbx", [
      "exec",
      sandboxName,
      "find",
      "/home/agent/.codex/sessions",
      "-type",
      "f",
      "-name",
      `*-${threadId}.jsonl`,
      "-print",
      "-quit",
    ]);
    if (found.code !== 0) {
      throw commandError(`find transcript in ${sandboxName}`, found);
    }
    const source = found.stdout.trim();
    if (!source) return undefined;
    if (
      !source.startsWith("/home/agent/.codex/sessions/") ||
      source.includes("\n")
    ) {
      throw new Error(`unsafe transcript path reported by ${sandboxName}`);
    }
    const copied = await exec("sbx", [
      "cp",
      `${sandboxName}:${source}`,
      destination,
    ]);
    if (copied.code !== 0) {
      throw commandError(`copy transcript from ${sandboxName}`, copied);
    }
    return `${sandboxName}:${source}`;
  };

  return {
    config: runtimeConfig,
    captureTranscript,
    async cleanup() {
      for (const runtime of runtimes) {
        note(runtime.arm.name, "destroying ephemeral environment");
      }
      await cleanupRuntime(runtimes, ladderMount, exec);
    },
  };
}
