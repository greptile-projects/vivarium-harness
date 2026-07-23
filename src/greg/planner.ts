import { dirname } from "node:path";
import type { AttemptRunner } from "../harness.js";
import { runArmStreaming } from "../live/stream.js";
import type { Rung } from "./ladder.js";
import type { GregConfig } from "./config.js";

// Greg emits this on its own when the North Star is fully reached, letting the
// loop stop early instead of grinding out empty rungs.
export const NORTH_STAR_SENTINEL = "<<<NORTH_STAR_REACHED>>>";

const RUNG_OPEN = "<<<RUNG>>>";
const RUNG_CLOSE = "<<<RUNG_END>>>";

// A rung without its loop-assigned index — the shape Greg actually returns.
export type PlannedRung = Omit<Rung, "index">;

export type RungOutcome =
  | { kind: "rung"; rung: PlannedRung }
  | { kind: "north-star-reached" };

// The full instruction handed to a fresh, stateless Greg. Everything Greg knows
// is in here: the goal, the ladder built so far, and a strict output contract.
export function plannerPrompt(
  northStar: string,
  ladder: string,
  index: number,
): string {
  const priorLadder =
    ladder.trim().length > 0
      ? ladder.trim()
      : "(no rungs yet — this is the very first)";

  return `You are Greg Tile, the planner for a long-running autonomous build. You are stateless: everything you know is written below. Do not assume any memory of earlier turns.

# North Star
${northStar}

# The ladder so far
The ladder is the ordered list of rungs already planned and built toward the North Star. It is written to a markdown file mounted into both build checkouts, so whatever you plan becomes visible to the builders.

${priorLadder}

# Your job for this turn (rung ${index})
Propose EXACTLY ONE next rung: the smallest self-contained, shippable increment that moves the codebase closer to the North Star given what already exists. Not the whole remaining journey — just the next step a single engineer could land as one pull request.

- Read the ladder so you neither repeat nor contradict prior rungs; build on them.
- Write the rung as a Linear-style ticket: a clear title and a concrete, actionable description (what to build, acceptance criteria, and constraints). The description is handed verbatim to a builder agent that has no other context, so it must stand entirely on its own.
- Create a Linear issue for this rung using the Linear tools available to you. Put its identifier in the "ticket" field. If you cannot reach Linear, leave "ticket" empty and continue anyway.

# Output contract
After any thinking or tool use, end your reply with a single block, exactly:

${RUNG_OPEN}
{"title": "...", "ticket": "ENG-123 or empty string", "summary": "one-line summary", "description": "full standalone ticket body"}
${RUNG_CLOSE}

The block must be the last thing in your reply, and the lines between the markers must be valid JSON and nothing else. If — and only if — the North Star is fully achieved and no further rung is needed, reply with just this single line instead:

${NORTH_STAR_SENTINEL}`;
}

// Extract the rung (or the stop signal) from Greg's final message. Tolerant of
// surrounding prose and tool chatter: we take the LAST rung block, since any
// earlier occurrence would be Greg quoting the contract back at itself.
export function parseRungOutput(output: string): RungOutcome {
  if (output.includes(NORTH_STAR_SENTINEL)) {
    return { kind: "north-star-reached" };
  }

  const start = output.lastIndexOf(RUNG_OPEN);
  const end = output.lastIndexOf(RUNG_CLOSE);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Greg produced no rung block. Output was:\n${output.slice(0, 400)}`,
    );
  }

  const body = output.slice(start + RUNG_OPEN.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `Greg's rung block was not valid JSON:\n${body.slice(0, 400)}`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const title = asText(record.title);
  const description = asText(record.description);
  if (!title || !description) {
    throw new Error("Greg's rung is missing a title or description");
  }

  return {
    kind: "rung",
    rung: {
      title,
      description,
      ticket: asText(record.ticket) || undefined,
      summary: asText(record.summary) || undefined,
    },
  };
}

// Run one fresh, stateless Greg session to plan the next rung. Never continues a
// thread — statelessness is the point; the ladder is the only carried state.
export async function proposeRung(
  config: GregConfig,
  ladder: string,
  index: number,
  runner: AttemptRunner = runArmStreaming,
): Promise<RungOutcome> {
  const result = await runner(
    {
      arm: "greg",
      prompt: plannerPrompt(config.northStar, ladder, index),
      cwd: dirname(config.ladderPath),
      sandbox: config.plannerSandbox,
      codexHome: config.base.codexHome,
      idleTimeoutMs: config.base.idleTimeoutMs,
    },
    () => {},
  );

  if (result.isError) {
    throw new Error(
      `Greg failed to plan rung ${index}: ${result.output || "unknown error"}`,
    );
  }

  return parseRungOutput(result.output);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
