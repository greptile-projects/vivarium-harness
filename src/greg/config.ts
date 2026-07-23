import { basename, resolve } from "node:path";
import { parseArgs, validateConfig, type HarnessConfig } from "../config.js";

const DEFAULT_NORTH_STAR =
  "Build a working clone of GitHub: a web application where users can host git repositories, browse code, open and review pull requests, and manage issues.";

const DEFAULT_MAX_RUNGS = 10;

export interface GregConfig {
  // The two-arm harness config, reused verbatim per rung. `ticket` is a
  // placeholder here; the loop overwrites it with each rung's description.
  base: HarnessConfig;
  northStar: string;
  // Canonical ladder path (absolute), outside both checkouts.
  ladderPath: string;
  // Filename the ladder is exposed as inside each repo.
  ladderLinkName: string;
  maxRungs: number;
  // Sandbox for Greg itself. Greg only reads and files Linear tickets, so it
  // defaults to read-only — separate from the builders' write sandbox.
  plannerSandbox: HarnessConfig["sandbox"];
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

function plannerSandboxFromEnv(
  value: string | undefined,
): HarnessConfig["sandbox"] {
  const sandbox = value ?? "read-only";
  if (
    sandbox !== "read-only" &&
    sandbox !== "workspace-write" &&
    sandbox !== "danger-full-access"
  ) {
    throw new Error(
      "GREG_SANDBOX must be read-only, workspace-write, or danger-full-access",
    );
  }
  return sandbox;
}

function maxRungsFrom(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RUNGS;
  const rungs = Number(value);
  if (!Number.isSafeInteger(rungs) || rungs < 1) {
    throw new Error("max rungs must be a positive integer");
  }
  return rungs;
}

export async function parseGregConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<GregConfig> {
  if (args.includes("--help")) {
    throw new Error("HELP");
  }

  // Reuse the harness env parsing/validation (arms, sandbox, codexHome, …).
  // The ticket is per-rung, so we pass a placeholder the loop overrides.
  const base = await validateConfig(
    parseArgs(["--ticket", "greg-planner"], env),
  );

  const northStar =
    valueAfter(args, "--north-star") ?? env.GREG_NORTH_STAR ?? DEFAULT_NORTH_STAR;
  const ladderPath = resolve(
    valueAfter(args, "--ladder") ?? env.GREG_LADDER ?? "LADDER.md",
  );
  const maxRungs = maxRungsFrom(
    valueAfter(args, "--max-rungs") ?? env.GREG_MAX_RUNGS,
  );

  return {
    base,
    northStar,
    ladderPath,
    ladderLinkName: basename(ladderPath),
    maxRungs,
    plannerSandbox: plannerSandboxFromEnv(env.GREG_SANDBOX),
  };
}

export const gregUsage = `Usage:
  bun run greg [options]

Greg Tile is a stateless planner loop on top of the two-arm harness. Each rung
he plans one next step toward the North Star, files a Linear ticket, appends it
to the ladder (mounted into both checkouts), then mechanically runs the harness.

Required environment (same as the harness):
  CONTROL_REPO=<path>     Checkout without access to Greptile comments
  GREPTILE_REPO=<path>    Checkout with access to Greptile comments

Options (flag overrides env):
  --north-star <text>     GREG_NORTH_STAR — the eventual goal (default: GitHub clone)
  --ladder <path>         GREG_LADDER — canonical ladder file (default: ./LADDER.md)
  --max-rungs <count>     GREG_MAX_RUNGS — rungs to climb before stopping (default: 10)

Optional environment:
  GREG_SANDBOX=<mode>     Greg's own sandbox (default read-only)

All harness environment (CODEX_SANDBOX, MAX_ATTEMPTS, RESULTS_DIR, CODEX_HOME,
CODEX_IDLE_TIMEOUT_MS) applies to the builder arms as usual.`;
