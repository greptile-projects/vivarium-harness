import {
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { HarnessRunResult } from "../harness/harness.js";

// The ladder is a single markdown file that holds the plan: the North Star,
// every milestone, and every subticket live here and nowhere else. Greg edits it
// directly (he appends milestones); the loop only flips a subticket's checkbox
// once the harness has built it, and writes nothing else — this file is
// mounted read-only into both arm microVMs and is Greg's whole prompt, so what a run
// actually landed goes to `results/rung-NN/` instead. See `completeSubticket`.
//
// A subticket is one PR-sized step, written as a checkbox heading:
//
//   ### [ ] 1.2 Add git storage — ENG-12
//
//   Full standalone description (any length / markdown) handed verbatim to the
//   builders as the ticket body.
//
// `[ ]` = not yet built, `[x]` = built and merged. Milestones group them:
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
const SUBTICKET_HEADING_START = /^###(?!#)/;
const MILESTONE_HEADING = /^##\s+Milestone\s+(\d+)\s*:/;
// A trailing " — TICKET-123" on a heading is a ticket id, not part of the
// title (older ladders carry ids from the retired Linear pipeline). Anything
// that does not look like a ticket id is left in the title.
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
full ticket body as prose below. \`[ ]\` means not yet built; \`[x]\` means it has
been built and merged.

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

// The prose under a heading: everything from the next line up to the following
// heading (subticket or milestone) or end of file, trimmed.
function bodyAfter(lines: string[], index: number): string {
  const body: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const next = lines[cursor];
    if (SUBTICKET_HEADING.test(next) || MILESTONE_HEADING.test(next)) break;
    body.push(next);
  }
  return body.join("\n").trim();
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

    subtickets.push({
      number,
      title,
      ticket,
      done,
      milestone,
      description: bodyAfter(lines, index),
    });
  }

  return subtickets;
}

// The next subticket the loop should build: the first one still unchecked.
export function nextPendingSubticket(ladder: string): ParsedSubticket | null {
  return parseSubtickets(ladder).find((subticket) => !subticket.done) ?? null;
}

// ###-level lines that were meant to be subticket headings but do not parse.
// The parser silently skips what it cannot read, so a heading Greg got almost
// right — a missing checkbox, a stray character — would persist as ladder text
// the loop never sees and never builds. The planner uses this to reject such a
// turn outright instead. The ladder format reserves ### for subtickets, which
// is what makes "### that does not parse" a defect rather than prose.
export function malformedSubticketHeadings(text: string): string[] {
  return text
    .split("\n")
    .filter(
      (line) =>
        SUBTICKET_HEADING_START.test(line) && !SUBTICKET_HEADING.test(line),
    );
}

// Mark a subticket built: flip its checkbox to `[x]` and append the harness run
// outcome below its description. Called by the loop only after a successful
// run, so the ladder doubles as the build history both arms can read. Checking
// the box is also what advances the loop — a subticket is only revisited while
// unchecked, so a failed run must leave it unchecked for a re-run to retry.
// Flip a built subticket's box, and write *nothing else*.
//
// The ladder is mounted read-only into both arms' microVMs and is also
// Greg's entire prompt, so it is the one file that crosses every isolation
// boundary in the experiment. It used to also record the run: its id, its
// artifact directory, and both merged pull request URLs. Those URLs name both
// repositories, and a failure line named the arms — so any arm that read the
// ladder (and the worker prompt tells it to read "predecessor logs") learned it
// was one of two being compared, and Greg saw the pull requests he is
// documented as blind to. The box alone is what the loop needs to resume and
// what Greg needs to plan forward; everything else now lives in the rung
// directories under `results/`, which are never mounted and never prompted.
export async function completeSubticket(
  ladderPath: string,
  number: string,
): Promise<void> {
  const ladder = await readLadder(ladderPath);
  const lines = ladder.split("\n");

  // Prefer the first *unchecked* heading with this number. Numbers should be
  // unique (the planner rejects duplicates), but if one ever slips in by
  // hand-edit, flipping the first match could hit an already-checked twin and
  // leave the built rung looking pending forever — the loop would rebuild it
  // indefinitely. Falling back to any match keeps a re-complete of an
  // already-checked box idempotent.
  const matches = lines
    .map((line, index) => ({ index, match: line.match(SUBTICKET_HEADING) }))
    .filter(({ match }) => match?.[2] === number);
  if (matches.length === 0) {
    throw new Error(`Cannot complete subticket ${number}: not found in ladder`);
  }
  const target = matches.find(({ match }) => match?.[1] === " ") ?? matches[0]!;

  // Flip the checkbox on the heading line only.
  lines[target.index] = lines[target.index]!.replace(/\[( |x|X)\]/, "[x]");

  await writeFile(ladderPath, lines.join("\n"), "utf8");
}

// The outcome line for a finished harness run, recording status and any arms
// that exhausted their retries.
// A one-line summary of what a run did, for the operator's log and the halt
// message. This names arms and pull requests, so it is safe *only* on the
// operator-facing side — the progress logs and stderr. It must never be written
// into the ladder; see `completeSubticket`.
export function runOutcome(run: HarnessRunResult): string {
  const failed = run.results
    .filter((result) => result.status === "failed")
    .map((result) => result.arm);
  const detail = failed.length ? ` (failed arms: ${failed.join(", ")})` : "";
  const merged = run.landings
    .filter((landing) => landing.status === "merged" && landing.pullRequest)
    .map((landing) => ` ${landing.pullRequest?.url ?? ""}`);
  const prs = merged.length ? ` — merged: ${merged.join(", ")}` : "";
  return `Run \`${run.runId}\`: ${run.status}${detail} — \`${run.artifactDir}\`${prs}`;
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
