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

// One planned step on the climb toward the North Star. `index` is assigned by
// the loop, not by Greg — Greg is stateless and only sees the ladder text.
export interface Rung {
  index: number;
  title: string;
  ticket?: string;
  summary?: string;
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

The ordered climb toward the North Star. Each rung is one shippable increment,
planned by Greg Tile and built by both arms. This file is mounted into both
checkouts so the builders can see where the work is going.

## North Star

${northStar.trim()}

---
`;
  await writeFile(ladderPath, header, "utf8");
}

// The whole ladder as text — this is the entire context a stateless Greg gets
// about what has been planned and built so far. Missing file reads as empty.
export async function readLadder(ladderPath: string): Promise<string> {
  try {
    return await readFile(ladderPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return "";
    throw error;
  }
}

// Record a freshly planned rung before the builders touch it, so the ladder
// always reflects intent even if the harness run below crashes.
export async function appendRungPlan(
  ladderPath: string,
  rung: Rung,
): Promise<void> {
  const lines = [
    "",
    `## Rung ${rung.index}: ${rung.title}`,
    "",
    `- **Linear:** ${rung.ticket ?? "—"}`,
    ...(rung.summary ? [`- **Summary:** ${rung.summary}`] : []),
    "",
    rung.description.trim(),
    "",
  ];
  await appendFile(ladderPath, lines.join("\n"), "utf8");
}

// Annotate the rung just planned with what the mechanical harness run did to
// it, so the ladder doubles as the build history both arms can read.
export async function appendRunOutcome(
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
