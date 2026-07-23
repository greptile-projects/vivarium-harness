import { homedir } from "node:os";
import { join } from "node:path";
import { realpath, stat } from "node:fs/promises";

// Fixed for the experiment — not configurable. Artifacts always land in
// ./results, each arm gets three autonomous attempts, and a stalled arm is
// aborted after ten minutes of event silence.
export const RESULTS_DIR = "results";
export const MAX_ATTEMPTS = 3;
export const IDLE_TIMEOUT_MS = 600_000;

export type ArmName = "control" | "greptile";

export interface ArmConfig {
  name: ArmName;
  repo: string;
}

export interface HarnessConfig {
  ticket: string;
  arms: [ArmConfig, ArmConfig];
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  resultsDir: string;
  codexHome: string;
  maxAttempts: number;
  idleTimeoutMs: number;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function sandboxFromEnv(
  value: string | undefined,
): HarnessConfig["sandbox"] {
  const sandbox = value ?? "workspace-write";
  if (
    sandbox !== "read-only" &&
    sandbox !== "workspace-write" &&
    sandbox !== "danger-full-access"
  ) {
    throw new Error(
      "CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access",
    );
  }
  return sandbox;
}

export function parseArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): HarnessConfig {
  if (args.includes("--help")) {
    throw new Error("HELP");
  }

  const ticket = valueAfter(args, "--ticket");
  if (!ticket) {
    throw new Error("--ticket is required");
  }
  if (!env.CONTROL_REPO || !env.GREPTILE_REPO) {
    throw new Error("CONTROL_REPO and GREPTILE_REPO must be configured");
  }

  return {
    ticket,
    arms: [
      { name: "control", repo: env.CONTROL_REPO },
      { name: "greptile", repo: env.GREPTILE_REPO },
    ],
    sandbox: sandboxFromEnv(env.CODEX_SANDBOX),
    resultsDir: RESULTS_DIR,
    codexHome: env.CODEX_HOME ?? join(homedir(), ".codex"),
    maxAttempts: MAX_ATTEMPTS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  };
}

export async function validateConfig(
  config: HarnessConfig,
): Promise<HarnessConfig> {
  const canonicalRepos = await Promise.all(
    config.arms.map(async (arm) => {
      const repo = await realpath(arm.repo);
      const info = await stat(repo);
      if (!info.isDirectory()) {
        throw new Error(`${repo} is not a directory`);
      }
      return repo;
    }),
  );

  if (canonicalRepos[0] === canonicalRepos[1]) {
    throw new Error("CONTROL_REPO and GREPTILE_REPO must be different checkouts");
  }

  return {
    ...config,
    arms: config.arms.map((arm, index) => ({
      ...arm,
      repo: canonicalRepos[index],
    })) as [ArmConfig, ArmConfig],
  };
}

export const usage = `Usage:
  bun start -- --ticket <linear-ticket-description>

Required environment:
  CONTROL_REPO=<path>     Checkout without access to Greptile comments
  GREPTILE_REPO=<path>    Checkout with access to Greptile comments

Optional environment:
  CODEX_SANDBOX=<mode>    Defaults to workspace-write
  CODEX_HOME=<path>       Defaults to ~/.codex; used to copy transcripts

The caller supplies only --ticket. Repository and tool isolation are deployment
configuration, not per-ticket orchestration inputs. Results dir (./results),
attempts per arm (3), and the idle watchdog (10m) are fixed constants.`;
