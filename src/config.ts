import { homedir } from "node:os";
import { join } from "node:path";
import { realpath, stat } from "node:fs/promises";

export type ArmName = "control" | "greptile";

export interface ArmConfig {
  name: ArmName;
  // Host path to the arm's checkout: the bind-mount source and where the
  // harness runs its own file ops (artifacts, greptile review).
  repo: string;
  // When set, the arm's codex runs via `docker exec` in this container instead
  // of on the host, giving each arm an isolated filesystem.
  container?: string;
  // Codex's cwd inside the container (defaults to /workspace). Ignored when the
  // arm runs on the host.
  workspace?: string;
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

function maxAttemptsFromEnv(value: string | undefined): number {
  if (value === undefined) return 3;
  const attempts = Number(value);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("MAX_ATTEMPTS must be a positive integer");
  }
  return attempts;
}

function idleTimeoutFromEnv(value: string | undefined): number {
  if (value === undefined) return 600_000;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1_000) {
    throw new Error(
      "CODEX_IDLE_TIMEOUT_MS must be an integer of at least 1000 (milliseconds)",
    );
  }
  return ms;
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
      {
        name: "control",
        repo: env.CONTROL_REPO,
        container: env.CONTROL_CONTAINER,
        workspace: env.CONTROL_WORKSPACE,
      },
      {
        name: "greptile",
        repo: env.GREPTILE_REPO,
        container: env.GREPTILE_CONTAINER,
        workspace: env.GREPTILE_WORKSPACE,
      },
    ],
    sandbox: sandboxFromEnv(env.CODEX_SANDBOX),
    resultsDir: env.RESULTS_DIR ?? "results",
    codexHome: env.CODEX_HOME ?? join(homedir(), ".codex"),
    maxAttempts: maxAttemptsFromEnv(env.MAX_ATTEMPTS),
    idleTimeoutMs: idleTimeoutFromEnv(env.CODEX_IDLE_TIMEOUT_MS),
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
  CONTROL_CONTAINER=<name>    Run the control arm's codex via docker exec in
                          this container (checkout mounted at the workspace
                          path). Unset runs on the host with no isolation.
  GREPTILE_CONTAINER=<name>   Same, for the greptile arm.
  CONTROL_WORKSPACE=<path>    Codex cwd inside the container. Defaults to
  GREPTILE_WORKSPACE=<path>   /workspace.
  CODEX_SANDBOX=<mode>    Defaults to workspace-write
  RESULTS_DIR=<path>      Defaults to ./results
  CODEX_HOME=<path>       Defaults to ~/.codex; used to copy transcripts
  MAX_ATTEMPTS=<count>    Defaults to 3 autonomous attempts per arm
  CODEX_IDLE_TIMEOUT_MS=<ms>  Abort an arm after this much event silence
                          (activity watchdog). Defaults to 600000 (10m)

The caller supplies only --ticket. Repository and tool isolation are deployment
configuration, not per-ticket orchestration inputs.`;
