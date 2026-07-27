import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  parseMilestone,
  parseSubtickets,
  readLadder,
  recordTicketId,
} from "./ladder.js";

// Ticket filing is mechanical bookkeeping, so it lives in the loop, not in
// Greg. Greg's headless Codex session cannot file tickets itself: codex gates
// destructive-annotated MCP tools (like Linear's `save_issue`) behind an
// interactive approval that a headless session can never answer, so the call
// blocks forever client-side — the request never even reaches Linear. A plain
// MCP client has no such gate and gets an answer in milliseconds, so the loop
// files each planned milestone directly and stamps the ids back onto the
// ladder headings.
export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

// A hung or slow Linear call must never stall the climb the way it stalled
// Greg — every call is time-boxed and every failure is non-fatal (ids are
// bookkeeping, not build state).
const CALL_TIMEOUT_MS = 30_000;

export type MilestoneFiler = (
  ladderPath: string,
  milestoneNumber: number,
  log: (message: string) => void,
) => Promise<void>;

// Pull the created issue's identifier (e.g. "GRE-41") out of a save_issue
// response. The response is JSON text in the happy case; fall back to the
// first thing shaped like an issue id so a format drift degrades gracefully.
export function extractIssueId(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { identifier?: unknown; id?: unknown };
    for (const candidate of [parsed.identifier, parsed.id]) {
      if (typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(candidate)) {
        return candidate;
      }
    }
  } catch {
    // not JSON — fall through to the regex
  }
  return text.match(/\b[A-Z][A-Z0-9]*-\d+\b/)?.[0];
}

function contentText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type?: string; text?: unknown }>;
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

// The rung's Linear project-milestone name, matching the convention already on
// the board: "Rung 1 — Git storage".
export function rungMilestoneName(milestoneNumber: number, title: string): string {
  return `Rung ${milestoneNumber} — ${title}`;
}

// Find rung N in a list_milestones response (parsed leniently: the payload may
// be a bare array or wrapped in {milestones: [...]}). Matches on the "Rung N"
// prefix so a renamed suffix still resolves — this is what makes re-filing
// idempotent without stamping anything on the ladder's milestone heading.
export function pickRungMilestone(
  payload: string,
  milestoneNumber: number,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : ((parsed as { milestones?: unknown }).milestones ?? []);
  if (!Array.isArray(items)) return undefined;

  const prefix = new RegExp(`^Rung ${milestoneNumber}\\b`);
  for (const item of items as Array<{ id?: unknown; name?: unknown }>) {
    if (typeof item?.name === "string" && prefix.test(item.name)) {
      return typeof item.id === "string" ? item.id : item.name;
    }
  }
  return undefined;
}

// File one planned rung in Linear, following the board's conventions:
//
//   - the rung itself is a **project milestone** named "Rung N — Title"
//     (description = the ladder's one-line summary) under the north-star
//     project — reused by name if it already exists;
//   - each subticket is an issue "[RUNG N.x] Title" in the team + project,
//     attached to that milestone;
//   - ordered subtickets are chained with blocking relations: N.2 is blocked
//     by N.1, and the rung's first issue is blocked by the previous rung's
//     last filed issue (each step builds on the one before).
//
// Issue ids are stamped back onto the ladder's subticket headings; anything
// already carrying an id is skipped, so a partially-filed rung finishes on the
// next run. Requires LINEAR_API_KEY and LINEAR_TEAM; LINEAR_PROJECT is what
// milestones hang off (without it, issues are still filed, just unattached).
// Missing config or any Linear error just logs and returns — the climb never
// blocks on ids.
export async function fileMilestoneInLinear(
  ladderPath: string,
  milestoneNumber: number,
  log: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const apiKey = env.LINEAR_API_KEY;
  const team = env.LINEAR_TEAM;
  if (!apiKey || !team) {
    log(
      `  Linear filing skipped: ${apiKey ? "LINEAR_TEAM" : "LINEAR_API_KEY"} is unset`,
    );
    return;
  }

  const ladder = await readLadder(ladderPath);
  const milestone = parseMilestone(ladder, milestoneNumber);
  if (!milestone) {
    log(`  Linear filing skipped: milestone ${milestoneNumber} not found in ladder`);
    return;
  }
  const allSubtickets = parseSubtickets(ladder);
  const subtickets = allSubtickets.filter(
    (subticket) => subticket.milestone === milestoneNumber,
  );

  const { call, close } = linearSession(apiKey);

  try {
    const project = env.LINEAR_PROJECT;

    // The rung as a project milestone, reused by "Rung N" prefix when a
    // previous run (or a hand-filed board) already has it.
    let milestoneRef: string | undefined;
    if (project) {
      milestoneRef = pickRungMilestone(
        await call("list_milestones", { project }),
        milestoneNumber,
      );
      if (!milestoneRef) {
        const name = rungMilestoneName(milestoneNumber, milestone.title);
        const created = await call("save_milestone", {
          project,
          name,
          description: milestone.summary || milestone.title,
        });
        try {
          const id = (JSON.parse(created) as { id?: unknown }).id;
          milestoneRef = typeof id === "string" ? id : name;
        } catch {
          milestoneRef = name;
        }
        log(`  filed milestone "${name}"`);
      }
    } else {
      log("  Linear rung milestone skipped: LINEAR_PROJECT is unset");
    }

    // Each step builds on the one before: seed the blocking chain with the
    // previous rung's last filed issue, then chain within the rung.
    let previousId = allSubtickets
      .filter((s) => s.milestone < milestoneNumber && s.ticket)
      .map((s) => s.ticket)
      .pop();

    for (const subticket of subtickets) {
      if (subticket.ticket) {
        previousId = subticket.ticket;
        continue;
      }
      const text = await call("save_issue", {
        team,
        ...(project ? { project } : {}),
        ...(milestoneRef ? { milestone: milestoneRef } : {}),
        ...(previousId ? { blockedBy: [previousId] } : {}),
        title: `[RUNG ${subticket.number}] ${subticket.title}`,
        description: subticket.description || subticket.title,
      });
      const id = extractIssueId(text);
      if (id) {
        await recordTicketId(ladderPath, { subticket: subticket.number }, id);
        log(
          `  filed ${id} — ${subticket.number} ${subticket.title}${
            previousId ? ` (blocked by ${previousId})` : ""
          }`,
        );
        previousId = id;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`  Linear filing failed (continuing without ids): ${message}`);
  } finally {
    await close();
  }
}

// One lazily-connected session against Linear's hosted MCP. `call` throws on
// tool errors; `close` never does.
function linearSession(apiKey: string): {
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
} {
  const transport = new StreamableHTTPClientTransport(new URL(LINEAR_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "vivarium-greg-filer", version: "0.1.0" });
  let connected = false;

  return {
    call: async (name, args) => {
      if (!connected) {
        await client.connect(transport);
        connected = true;
      }
      const result = (await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as { content?: unknown; isError?: boolean };
      const text = contentText(result);
      if (result.isError) throw new Error(text || `${name} failed`);
      return text;
    },
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore
      }
    },
  };
}

export type SubticketCloser = (
  ticket: string | undefined,
  number: string,
  log: (message: string) => void,
) => Promise<void>;

// Move a built subticket's Linear issue to the team's completed state ("Done")
// right after its ladder box is checked. Unlike filing, this FAILS CLOSED: a
// heading with no id is a logged skip (Linear was never configured for it),
// but once an issue exists, a close that cannot be performed — missing key,
// Linear error, timeout — throws, which halts the climb rather than letting
// the board silently drift from the ladder.
export async function closeSubticketInLinear(
  ticket: string | undefined,
  number: string,
  log: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!ticket) {
    log(`  ${number}: no Linear id on its heading — nothing to close`);
    return;
  }
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      `cannot close ${ticket} in Linear: LINEAR_API_KEY is unset (unset it only if no issues are filed)`,
    );
  }

  const { call, close } = linearSession(apiKey);
  try {
    // "completed" is the state *type*, which Linear resolves to the team's
    // Done-equivalent state regardless of what it is named.
    await call("save_issue", { id: ticket, state: "completed" });
    log(`  ${number}: closed ${ticket} in Linear`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to close ${ticket} in Linear: ${message}`);
  } finally {
    await close();
  }
}
