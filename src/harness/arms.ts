// What an arm is doing right now, when "a Codex session is producing events"
// is not the whole truth. A run spends long stretches with the session idle —
// sitting on a review that has not arrived yet, merging — and a status column
// that said "working" for forty minutes told nobody which of those it was.
//
// A closed set, not free text: this is a status word, it is coloured and
// budgeted as one, and the transitions are few enough to name. Each is set by
// the code that enters that phase (`runHarness`, `reviewArm`, `mergeArm`) —
// nothing infers a phase by reading the prose of a progress note.
export type ArmPhase =
  | "preparing"
  | "building"
  | "landing"
  | "waiting for review"
  | "answering review"
  // Done with its own work, idle at the merge barrier until the other arm is
  // ready too. The unreviewed arm spends most of a subticket here.
  | "waiting on peer"
  | "merging"
  | "held back"
  | "planning";

const DISPLAY_ORDER: Record<string, number> = {
  tuatara: 0,
  komodo: 1,
};

// Tuatara is the first experiment arm everywhere the two are presented
// together. Unknown sessions (for example Greg while planning) retain their
// registration order after the named arms.
export function armsForDisplay<T extends { arm: string }>(arms: T[]): T[] {
  return arms
    .map((arm, index) => ({ arm, index }))
    .sort(
      (left, right) =>
        (DISPLAY_ORDER[left.arm.arm] ?? 2) -
          (DISPLAY_ORDER[right.arm.arm] ?? 2) ||
        left.index - right.index,
    )
    .map(({ arm }) => arm);
}
