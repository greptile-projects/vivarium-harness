import type { ClimbArm, ClimbSubticket } from "./model.js";

// The climb tab's rows, built once from the model and rendered as-is. Pure, so
// the shape of the tree is testable without Ink: what shows, in what order, and
// what each row says.
export type ClimbRowKind = "milestone" | "subticket" | "arm";
export type ClimbTone = "good" | "bad" | "now" | "dim" | "plain";

export interface ClimbRow {
  // What this row *is*, never where it currently sits. The tree is rebuilt from
  // scratch on every change and rows appear above existing ones — a landing
  // adds an arm row to a rung in the middle, a rung that left the ladder is
  // prepended — so a positional id would quietly re-point the scroll anchor at
  // different content and slide the text out from under a reader who had
  // scrolled back. Keyed this way the anchored rung stays the anchored rung.
  id: string;
  kind: ClimbRowKind;
  tone: ClimbTone;
  text: string;
}

// Rungs ahead of the one being built. The whole point of showing any is "what
// is coming next" — the rest of the plan is the ladder file, and printing all
// of it would push the rung in flight off the bottom of a tailing pane.
export const UPCOMING = 3;

// Notes kept below the tree. The climb's own log lines are also in the log tab
// (and in ladder.log) in full; these are the last few, where they can be read
// beside the rung they are about.
export const NOTE_ROWS = 3;

const MARKER: Record<ClimbSubticket["state"], string> = {
  built: "✓",
  building: "▸",
  pending: "○",
};

const TONE: Record<ClimbSubticket["state"], ClimbTone> = {
  built: "good",
  building: "now",
  pending: "dim",
};

// What one arm did with a rung: its pull request whole (these rows exist to be
// opened, so the URL is never the part that gets cut) and then the numbers.
function armText(arm: ClimbArm): string {
  const merged = arm.status === "merged";
  const label = `${arm.arm.padEnd(8)} ${merged ? "✓" : "✗"}`;
  if (!arm.pullRequest) return `${label} ${arm.status}`;

  const detail: string[] = [];
  if (arm.rounds) detail.push(`${arm.answered}/${arm.rounds} answered`);
  if (arm.diffComments !== undefined) {
    detail.push(
      `${arm.diffComments} diff comment${arm.diffComments === 1 ? "" : "s"}`,
    );
  }
  const suffix = detail.length ? `   ${detail.join(" · ")}` : "";
  return `${label} ${arm.pullRequest.url}${suffix}`;
}

// The rungs worth drawing: everything already built, the one in flight, and a
// few of what is queued behind it.
export function visibleSubtickets(
  subtickets: ClimbSubticket[],
  upcoming: number = UPCOMING,
): ClimbSubticket[] {
  let ahead = 0;
  return subtickets.filter((subticket) => {
    if (subticket.state !== "pending") return true;
    ahead += 1;
    return ahead <= upcoming;
  });
}

export function climbRows(
  subtickets: ClimbSubticket[],
  upcoming: number = UPCOMING,
): ClimbRow[] {
  const visible = visibleSubtickets(subtickets, upcoming);
  const rows: ClimbRow[] = [];
  const push = (
    id: string,
    kind: ClimbRowKind,
    tone: ClimbTone,
    text: string,
  ): void => {
    rows.push({ id, kind, tone, text });
  };

  let milestone: number | undefined;
  visible.forEach((subticket, index) => {
    if (subticket.milestone !== milestone) {
      milestone = subticket.milestone;
      push(
        `milestone:${milestone}`,
        "milestone",
        "plain",
        `milestone ${milestone}`,
      );
    }
    // The last rung of a milestone closes its branch; anything under it hangs
    // off no spine.
    const last = visible[index + 1]?.milestone !== subticket.milestone;
    push(
      `rung:${subticket.number}`,
      "subticket",
      TONE[subticket.state],
      `${last ? "└─" : "├─"} ${MARKER[subticket.state]} ${subticket.number}  ${subticket.title}${
        subticket.state === "building" ? "   ← building now" : ""
      }`,
    );
    const spine = last ? "  " : "│ ";
    for (const arm of subticket.arms) {
      push(
        `arm:${subticket.number}:${arm.arm}`,
        "arm",
        arm.status === "merged" ? "good" : "bad",
        `${spine}     ${armText(arm)}`,
      );
    }
  });

  return rows;
}

// One line under the tree: where the climb stands, since the pane is a plan and
// "live · N lines" would say nothing about it.
export function climbFooter(subtickets: ClimbSubticket[]): string {
  const built = subtickets.filter((s) => s.state === "built").length;
  const pending = subtickets.filter((s) => s.state !== "built").length;
  const building = subtickets.find((s) => s.state === "building");
  const where = building ? ` · building ${building.number}` : "";
  return `${built} built · ${pending} to go${where}`;
}

// How the climb pane splits its rows between the tree and the notes tail. The
// tree always gets the bulk of it; on a short pane the notes are dropped
// outright rather than squeezed, because Ink resolves overflow by drawing rows
// on top of each other.
export function climbLayout(
  height: number,
  noteCount: number,
): { treeHeight: number; notes: number } {
  const notes = noteCount === 0 || height < 10 ? 0 : Math.min(NOTE_ROWS, noteCount);
  return { treeHeight: height - (notes ? notes + 1 : 0), notes };
}
