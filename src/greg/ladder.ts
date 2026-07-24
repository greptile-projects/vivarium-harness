import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { HarnessRunResult } from "../harness.js";

// A milestone is one rung of the ladder (1, 2, 3, …). The loop assigns `number`.
export interface Milestone {
  number: number;
  title: string;
  ticket?: string;
  summary?: string;
}

// A subticket is a single PR-sized step under a milestone (1.1, 1.2, …). The
// loop assigns `number` as "<milestone>.<index>".
export interface Subticket {
  number: string;
  title: string;
  ticket?: string;
  description: string;
}

// Create the ladder file with its North Star header if it does not exist yet.
// Idempotent: an existing ladder is left untouched so its history survives
// across runs (the North Star header is written once, on first creation).
export async function initLadder(
  ladderPath: string,
  northStar: string,
): Promise<void> {
  if (await pathExists(ladderPath)) return;

  await mkdir(dirname(resolve(ladderPath)), { recursive: true });
  const header = `# Ladder

The ordered climb toward the North Star. Each milestone is one rung; its
subtickets (1.1, 1.2, …) are the single PR-sized steps that build it. Greg Tile
plans milestones and both arms build the subtickets. This file is mounted into
both checkouts so the builders can see where the work is going.

## North Star

${northStar.trim()}

---
`;
  await writeFile(ladderPath, header, "utf8");
}

// The whole ladder as text — this is the entire context a stateless Greg gets
// about what has been planned so far. Missing file reads as empty.
export async function readLadder(ladderPath: string): Promise<string> {
  try {
    return await readFile(ladderPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return "";
    throw error;
  }
}

// How many milestones the ladder already records — used to number the next one
// and to resume numbering after a paused run.
export function countMilestones(ladder: string): number {
  return (ladder.match(/^## Milestone \d+:/gm) ?? []).length;
}

// Record a milestone header before its subtickets are built.
export async function appendMilestone(
  ladderPath: string,
  milestone: Milestone,
): Promise<void> {
  const lines = [
    "",
    `## Milestone ${milestone.number}: ${milestone.title}`,
    "",
    `- **Linear:** ${milestone.ticket ?? "—"}`,
    ...(milestone.summary ? [`- **Summary:** ${milestone.summary}`] : []),
    "",
  ];
  await appendFile(ladderPath, lines.join("\n"), "utf8");
}

// Record a subticket just before the builders touch it, so the ladder always
// reflects intent even if the harness run below crashes.
export async function appendSubticket(
  ladderPath: string,
  subticket: Subticket,
): Promise<void> {
  const lines = [
    "",
    `### ${subticket.number} ${subticket.title}`,
    "",
    `- **Linear:** ${subticket.ticket ?? "—"}`,
    "",
    subticket.description.trim(),
    "",
  ];
  await appendFile(ladderPath, lines.join("\n"), "utf8");
}

// Annotate the subticket just built with what the mechanical harness run did to
// it, so the ladder doubles as the build history both arms can read.
export async function appendSubticketOutcome(
  ladderPath: string,
  run: HarnessRunResult,
): Promise<void> {
  const failed = run.results
    .filter((result) => result.status === "failed")
    .map((result) => result.arm);
  const detail = failed.length ? ` (failed arms: ${failed.join(", ")})` : "";
  await appendFile(
    ladderPath,
    `> **Run \`${run.runId}\`:** ${run.status}${detail} — \`${run.artifactDir}\`\n`,
    "utf8",
  );
}

export type LinkStatus = "created" | "exists" | "skipped-nonlink" | "error";

export interface LinkResult {
  repo: string;
  linkPath: string;
  status: LinkStatus;
  message: string;
}

// Ensure each repo exposes the ladder at `<repo>/<linkName>` via symlink. This
// is the local stand-in for the docker bind mount the experiment uses: the
// canonical ladder lives outside both checkouts, and each arm sees the same
// file. Never clobbers a pre-existing real file (that is likely a real mount).
export async function ensureLadderLinks(
  ladderPath: string,
  repos: string[],
  linkName: string = basename(ladderPath),
): Promise<LinkResult[]> {
  const canonical = resolve(ladderPath);
  const results: LinkResult[] = [];

  for (const repo of repos) {
    const linkPath = join(repo, linkName);
    try {
      const info = await lstat(linkPath).catch(() => null);
      if (info) {
        if (info.isSymbolicLink()) {
          const target = resolve(repo, await readlink(linkPath));
          if (target === canonical) {
            results.push({
              repo,
              linkPath,
              status: "exists",
              message: `ladder already linked at ${linkPath}`,
            });
            continue;
          }
        }
        results.push({
          repo,
          linkPath,
          status: "skipped-nonlink",
          message: `left existing ${linkPath} in place; mount the ladder here yourself`,
        });
        continue;
      }

      await symlink(canonical, linkPath);
      results.push({
        repo,
        linkPath,
        status: "created",
        message: `linked ladder into ${linkPath}`,
      });
    } catch (error) {
      results.push({
        repo,
        linkPath,
        status: "error",
        message: `could not link ladder into ${repo}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  return results;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "ENOENT"
  );
}
