import {
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { HarnessRunResult } from "../harness.js";

// The ladder is a single markdown file that IS the state: the North Star, every
// milestone, and every subticket live here and nowhere else. Greg edits it
// directly (he appends milestones); the loop only flips a subticket's checkbox
// and appends its run outcome once the harness has built it. There is no JSON
// hand-off and no second copy of the state to drift out of sync.
//
// A subticket is one PR-sized step, written as a checkbox heading:
//
//   ### [ ] 1.2 Add git storage — ENG-12
//
//   Full standalone description (any length / markdown) handed verbatim to the
//   builders as the ticket body.
//
// `[ ]` = not yet built, `[x]` = the harness has run on it (the outcome line
// below the description says whether the arms passed). Milestones group them:
//
//   ## Milestone 1: Repo hosting — ENG-10

// One parsed subticket, read back out of the ladder file. `number` is
// "<milestone>.<index>" (e.g. "1.2"); `done` reflects the checkbox.
export interface ParsedSubticket {
  number: string;
  title: string;
  ticket?: string;
  done: boolean;
  description: string;
  milestone: number;
}

const SUBTICKET_HEADING = /^###\s+\[( |x|X)\]\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/;
const MILESTONE_HEADING = /^##\s+Milestone\s+(\d+)\s*:/;
// A trailing " — TICKET-123" on a heading is the Linear id, not part of the
// title. Anything that does not look like a ticket id is left in the title.
const TRAILING_TICKET = /\s+—\s+([A-Za-z][A-Za-z0-9]*-\d+)\s*$/;

// Seed the ladder with its North Star header if it does not exist yet.
// Idempotent: an existing ladder is left untouched so its history survives
// across runs (the header, and thus the North Star, is written once).
export async function initLadder(
  ladderPath: string,
  northStar: string,
): Promise<void> {
  if (await pathExists(ladderPath)) return;

  await mkdir(dirname(resolve(ladderPath)), { recursive: true });
  const header = `# Ladder

The ordered climb toward the North Star, and the single source of truth for it.
Each milestone is one rung; its subtickets (1.1, 1.2, …) are the single PR-sized
steps that build it. Greg plans milestones by editing this file directly; both
arms then build each subticket. This file is mounted into both checkouts so the
builders can see where the work is going.

Each subticket is a checkbox heading — \`### [ ] 1.1 Title — TICKET\` — with its
full ticket body as prose below. \`[ ]\` means not yet built; \`[x]\` means the
harness has run on it (the outcome line records whether the arms passed).

## North Star

${northStar.trim()}

---
`;
  await writeFile(ladderPath, header, "utf8");
}

// The whole ladder as text — the entire context a stateless Greg gets about what
// has been planned so far, and what the loop reads to find the next step.
// Missing file reads as empty.
export async function readLadder(ladderPath: string): Promise<string> {
  try {
    return await readFile(ladderPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return "";
    throw error;
  }
}

// The highest milestone number the ladder already records. The loop numbers the
// next milestone as this + 1, so numbering resumes correctly after a pause even
// if a milestone header was hand-edited.
export function highestMilestone(ladder: string): number {
  let highest = 0;
  for (const line of ladder.split("\n")) {
    const match = line.match(MILESTONE_HEADING);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

// Every subticket in the ladder, in file order, each tagged with the milestone
// it sits under. This is the loop's read of Greg's plan — it replaces the old
// JSON parse: the file itself is the contract now.
export function parseSubtickets(ladder: string): ParsedSubticket[] {
  const lines = ladder.split("\n");
  const subtickets: ParsedSubticket[] = [];
  let milestone = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const milestoneMatch = line.match(MILESTONE_HEADING);
    if (milestoneMatch) {
      milestone = Number(milestoneMatch[1]);
      continue;
    }

    const match = line.match(SUBTICKET_HEADING);
    if (!match) continue;

    const done = match[1].toLowerCase() === "x";
    const number = match[2];
    let title = match[3];
    let ticket: string | undefined;
    const ticketMatch = title.match(TRAILING_TICKET);
    if (ticketMatch) {
      ticket = ticketMatch[1];
      title = title.slice(0, ticketMatch.index).trim();
    }

    // The description is everything from the next line up to the following
    // heading (subticket or milestone) or end of file.
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      if (SUBTICKET_HEADING.test(next) || MILESTONE_HEADING.test(next)) break;
      body.push(next);
    }

    subtickets.push({
      number,
      title,
      ticket,
      done,
      milestone,
      description: body.join("\n").trim(),
    });
  }

  return subtickets;
}

// The next subticket the loop should build: the first one still unchecked.
export function nextPendingSubticket(ladder: string): ParsedSubticket | null {
  return parseSubtickets(ladder).find((subticket) => !subticket.done) ?? null;
}

// Mark a subticket built: flip its checkbox to `[x]` and append the harness run
// outcome below its description. Called by the loop only after a successful
// run, so the ladder doubles as the build history both arms can read. Checking
// the box is also what advances the loop — a subticket is only revisited while
// unchecked, so a failed run must leave it unchecked for a re-run to retry.
export async function completeSubticket(
  ladderPath: string,
  number: string,
  outcome: string,
): Promise<void> {
  const ladder = await readLadder(ladderPath);
  const lines = ladder.split("\n");

  const headingIndex = lines.findIndex((line) => {
    const match = line.match(SUBTICKET_HEADING);
    return match?.[2] === number;
  });
  if (headingIndex === -1) {
    throw new Error(`Cannot complete subticket ${number}: not found in ladder`);
  }

  // Flip the checkbox on the heading line only.
  lines[headingIndex] = lines[headingIndex].replace(/\[( |x|X)\]/, "[x]");

  // Find the end of this subticket's section (next heading or EOF) and insert
  // the outcome line just before it, trimming trailing blanks first.
  let end = headingIndex + 1;
  for (; end < lines.length; end += 1) {
    if (
      SUBTICKET_HEADING.test(lines[end]) ||
      MILESTONE_HEADING.test(lines[end])
    ) {
      break;
    }
  }
  while (end > headingIndex + 1 && lines[end - 1].trim() === "") end -= 1;

  lines.splice(end, 0, "", `> ${outcome}`, "");
  await writeFile(ladderPath, lines.join("\n"), "utf8");
}

// The outcome line for a finished harness run, recording status and any arms
// that exhausted their retries.
export function runOutcome(run: HarnessRunResult): string {
  const failed = run.results
    .filter((result) => result.status === "failed")
    .map((result) => result.arm);
  const detail = failed.length ? ` (failed arms: ${failed.join(", ")})` : "";
  return `Run \`${run.runId}\`: ${run.status}${detail} — \`${run.artifactDir}\``;
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
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
