import { dirname } from "node:path";
import type { HarnessConfig } from "../config.js";
import type { AttemptRunner } from "../harness.js";
import { runArmStreaming } from "../live/stream.js";

// The one fixed goal of the experiment. Greg plans every milestone toward this.
// It is a direction, not a milestone that gets reached — the climb never ends.
export const NORTH_STAR =
  "Build a working clone of GitHub: a web application where users can host git repositories, browse code, open and review pull requests, and manage issues.";

const MILESTONE_OPEN = "<<<MILESTONE>>>";
const MILESTONE_CLOSE = "<<<MILESTONE_END>>>";

// A milestone must decompose into this many subtickets. The upper bound is what
// keeps runGreg's runaway cap meaningful: since the cap is only checked at
// milestone boundaries, a milestone that overran this bound would run its whole
// oversized array before pausing. Enforced in parseMilestone.
export const MIN_SUBTICKETS_PER_MILESTONE = 2;
export const MAX_SUBTICKETS_PER_MILESTONE = 5;

export interface PlannedSubticket {
  title: string;
  ticket?: string;
  description: string;
}

// What Greg returns for one planning turn: a milestone and its ordered
// subtickets. Numbers are assigned by the loop, not by Greg.
export interface PlannedMilestone {
  title: string;
  ticket?: string;
  summary?: string;
  subtickets: PlannedSubticket[];
}

// The full instruction handed to a fresh, stateless Greg. Everything Greg knows
// is in here: the goal and the ladder of milestones planned so far. Greg cannot
// see the builders' code or output — only the plan.
export function plannerPrompt(ladder: string, milestoneNumber: number): string {
  const priorLadder =
    ladder.trim().length > 0
      ? ladder.trim()
      : "(no milestones yet — this is the very first)";

  return `You are Greg Tile, the planner for a long-running autonomous build. You are stateless: everything you know is written below. Do not assume any memory of earlier turns.

# North Star
${NORTH_STAR}

The North Star is a direction, not a finish line. You will not complete it, and the climb continues indefinitely — always plan the next milestone.

# The ladder so far
The ladder is the ordered list of milestones already planned toward the North Star, each broken into subtickets. It is written to a markdown file mounted into both build checkouts.

You are blind to the builders: you CANNOT see the code they wrote, their pull requests, or whether their work truly succeeded. The ladder below — the plan itself — is your only input. Plan forward from it.

${priorLadder}

# Your job for this turn (milestone ${milestoneNumber})
Plan milestone ${milestoneNumber}: the next coherent chunk of progress toward the North Star, building on the milestones above without repeating them.

- Break it into ${MIN_SUBTICKETS_PER_MILESTONE}–${MAX_SUBTICKETS_PER_MILESTONE} ordered subtickets, numbered ${milestoneNumber}.1, ${milestoneNumber}.2, … Each subticket is one PR-sized ticket a single engineer could land, with a concrete, standalone description (what to build, acceptance criteria, constraints). Each description is handed verbatim to a builder agent with no other context, so it must stand entirely on its own, and each should build on the previous subticket in this milestone.
- File this in Linear using the tools available to you: a parent issue for the milestone and a sub-issue per subticket. Put the milestone's identifier in the top-level "ticket" field and each subticket's identifier in its own "ticket" field. If you cannot reach Linear, leave those empty and continue anyway.

# Output contract
After any thinking or tool use, end your reply with a single block, exactly:

${MILESTONE_OPEN}
{"title": "...", "ticket": "ENG-10 or empty string", "summary": "one-line summary", "subtickets": [{"title": "...", "ticket": "ENG-11 or empty string", "description": "full standalone ticket body"}]}
${MILESTONE_CLOSE}

The block must be the last thing in your reply, and the lines between the markers must be valid JSON and nothing else.`;
}

// Extract the milestone from Greg's final message. Tolerant of surrounding prose
// and tool chatter: we take the LAST block, since any earlier occurrence would
// be Greg quoting the contract back at itself.
export function parseMilestone(output: string): PlannedMilestone {
  const start = output.lastIndexOf(MILESTONE_OPEN);
  const end = output.lastIndexOf(MILESTONE_CLOSE);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Greg produced no milestone block. Output was:\n${output.slice(0, 400)}`,
    );
  }

  const body = output.slice(start + MILESTONE_OPEN.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `Greg's milestone block was not valid JSON:\n${body.slice(0, 400)}`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const title = asText(record.title);
  if (!title) {
    throw new Error("Greg's milestone is missing a title");
  }

  const rawSubtickets = Array.isArray(record.subtickets)
    ? record.subtickets
    : [];
  const subtickets: PlannedSubticket[] = rawSubtickets.map((entry, index) => {
    const sub = entry as Record<string, unknown>;
    const subTitle = asText(sub.title);
    const description = asText(sub.description);
    if (!subTitle || !description) {
      throw new Error(
        `Greg's subticket ${index + 1} is missing a title or description`,
      );
    }
    return {
      title: subTitle,
      description,
      ticket: asText(sub.ticket) || undefined,
    };
  });

  if (
    subtickets.length < MIN_SUBTICKETS_PER_MILESTONE ||
    subtickets.length > MAX_SUBTICKETS_PER_MILESTONE
  ) {
    throw new Error(
      `Greg's milestone must have ${MIN_SUBTICKETS_PER_MILESTONE}–${MAX_SUBTICKETS_PER_MILESTONE} subtickets, got ${subtickets.length}`,
    );
  }

  return {
    title,
    subtickets,
    ticket: asText(record.ticket) || undefined,
    summary: asText(record.summary) || undefined,
  };
}

// Run one fresh, stateless Greg session to plan the next milestone. Never
// continues a thread — statelessness is the point; the ladder is the only
// carried state. Greg only reads the ladder and files Linear tickets, so it
// runs read-only and is blind to the builders' work.
export async function proposeMilestone(
  base: HarnessConfig,
  ladderPath: string,
  ladder: string,
  milestoneNumber: number,
  runner: AttemptRunner = runArmStreaming,
): Promise<PlannedMilestone> {
  const result = await runner(
    {
      arm: "greg",
      prompt: plannerPrompt(ladder, milestoneNumber),
      cwd: dirname(ladderPath),
      sandbox: "read-only",
      codexHome: base.codexHome,
      idleTimeoutMs: base.idleTimeoutMs,
    },
    () => {},
  );

  if (result.isError) {
    throw new Error(
      `Greg failed to plan milestone ${milestoneNumber}: ${
        result.output || "unknown error"
      }`,
    );
  }

  return parseMilestone(result.output);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
