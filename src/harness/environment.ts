import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
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
  // Container names are generated per subticket. Every downstream operation
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
  container: string;
  volume: string;
  network: string;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+/, "");
}

function runtimeArms(config: HarnessConfig, runId: string): RuntimeArm[] {
  const suffix = safeName(runId.slice(-12) || randomUUID().slice(0, 12));
  return config.arms.map((arm) => {
    const base = safeName(arm.container as string);
    const container = `${base}-${suffix}`;
    return {
      arm: { ...arm, container },
      container,
      volume: `${container}-docker`,
      network: `${container}-net`,
    };
  });
}

function commandError(label: string, result: CommandResult): Error {
  return new Error(
    `${label}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
  );
}

async function cleanupRuntime(
  runtimes: RuntimeArm[],
  exec: CommandRunner,
): Promise<void> {
  const errors: string[] = [];
  for (const runtime of runtimes) {
    const container = await exec("docker", [
      "rm",
      "-f",
      "-v",
      runtime.container,
    ]);
    if (
      container.code !== 0 &&
      !/no such container/i.test(`${container.stdout}\n${container.stderr}`)
    ) {
      errors.push(
        commandError(`remove container ${runtime.container}`, container).message,
      );
    }

    const volume = await exec("docker", [
      "volume",
      "rm",
      "-f",
      runtime.volume,
    ]);
    if (
      volume.code !== 0 &&
      !/no such volume/i.test(`${volume.stdout}\n${volume.stderr}`)
    ) {
      errors.push(commandError(`remove volume ${runtime.volume}`, volume).message);
    }

    const network = await exec("docker", ["network", "rm", runtime.network]);
    if (
      network.code !== 0 &&
      !/not found|no such network/i.test(
        `${network.stdout}\n${network.stderr}`,
      )
    ) {
      errors.push(
        commandError(`remove network ${runtime.network}`, network).message,
      );
    }
  }
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
  const containerized = config.arms.every((arm) => arm.container !== undefined);
  if (!containerized) {
    return { config, async cleanup() {} };
  }

  const runtimes = runtimeArms(config, runId);
  try {
    await Promise.all(
      runtimes.map(async (runtime) => {
        note(runtime.arm.name, `starting fresh environment ${runtime.container}`);
        const result = await exec(resolve("scripts/arm-run.sh"), [
          runtime.arm.name,
        ], {
          env: {
            VIVARIUM_CONTAINER_NAME: runtime.container,
            VIVARIUM_DOCKER_VOLUME: runtime.volume,
            VIVARIUM_NETWORK_NAME: runtime.network,
            VIVARIUM_RUN_ID: runId,
          },
        });
        if (result.code !== 0) {
          throw commandError(
            `could not provision ${runtime.arm.name} environment`,
            result,
          );
        }
        note(runtime.arm.name, "fresh clone and services ready");
      }),
    );
  } catch (error) {
    await cleanupRuntime(runtimes, exec).catch(() => {});
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
    const container = runtimeByName.get(arm)?.container;
    if (!container) return undefined;
    const found = await exec("docker", [
      "exec",
      "-i",
      container,
      "find",
      "/codex/sessions",
      "-type",
      "f",
      "-name",
      `*-${threadId}.jsonl`,
      "-print",
      "-quit",
    ]);
    if (found.code !== 0) {
      throw commandError(`find transcript in ${container}`, found);
    }
    const source = found.stdout.trim();
    if (!source) return undefined;
    if (!source.startsWith("/codex/sessions/") || source.includes("\n")) {
      throw new Error(`unsafe transcript path reported by ${container}`);
    }
    const copied = await exec("docker", [
      "cp",
      `${container}:${source}`,
      destination,
    ]);
    if (copied.code !== 0) {
      throw commandError(`copy transcript from ${container}`, copied);
    }
    return `${container}:${source}`;
  };

  return {
    config: runtimeConfig,
    captureTranscript,
    async cleanup() {
      for (const runtime of runtimes) {
        note(runtime.arm.name, "destroying ephemeral environment");
      }
      await cleanupRuntime(runtimes, exec);
    },
  };
}
