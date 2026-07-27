import { resolve } from "node:path";
import { runCommand, type CommandRunner } from "./github.js";

// Which harness produced a run. The experiment is meant to run for months and
// every knob that shapes an arm's behaviour — the worker prompt, the review
// round count, the watchdog, the sandbox — lives in this repo and will change
// over that time. Without this, two runs a month apart are not comparable and
// nothing in the record says why: `manifest.json` looked identical whether the
// prompt asked for a pull request or not.
//
// `dirty` matters as much as `commit`: a run made from an edited working tree
// was produced by code that exists nowhere, and an analysis should know that
// before it trusts the commit.
export interface HarnessProvenance {
  commit?: string;
  branch?: string;
  dirty?: boolean;
  // Set when the commit could not be read at all (not a checkout, no git on
  // PATH). Recorded rather than omitted — an absent field reads identically to
  // a run made before provenance existed.
  error?: string;
}

// The harness repo root, resolved from this module rather than from the process
// cwd: `bun start` runs from the root today, but a systemd unit or a cron entry
// need not, and a wrong answer here is a silently wrong record. Works from both
// `src/` and the compiled `dist/`, which sit at the same depth.
//
// `dir` is Bun's and `dirname` is Node's; falling back to the cwd rather than
// letting `resolve(undefined)` throw, because this is provenance — a field on the
// record — and it must never be what stops a run.
export function harnessRoot(): string {
  const here = import.meta as { dir?: string; dirname?: string };
  const directory = here.dir ?? here.dirname;
  return directory ? resolve(directory, "..") : process.cwd();
}

export async function harnessProvenance(
  exec: CommandRunner = runCommand,
  root: string = harnessRoot(),
): Promise<HarnessProvenance> {
  const git = (args: string[]): Promise<{ code: number; stdout: string }> =>
    exec("git", ["-C", root, ...args]);

  try {
    const head = await git(["rev-parse", "HEAD"]);
    if (head.code !== 0) {
      return { error: `git rev-parse HEAD failed in ${root}` };
    }
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await git(["status", "--porcelain"]);
    return {
      commit: head.stdout.trim(),
      branch:
        branch.code === 0 && branch.stdout.trim() !== "HEAD"
          ? branch.stdout.trim()
          : undefined,
      // A failed `status` is not a clean tree — say unknown rather than guess.
      dirty: status.code === 0 ? status.stdout.trim().length > 0 : undefined,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
