// Experiment-facing arm names. The lowercase identifiers remain stable in
// config, artifacts, and APIs so existing runs and deployment env vars keep
// working; only human-facing surfaces use Tuatara and Komodo.
export function armDisplayName(arm: string): string {
  if (arm === "greptile") return "tuatara";
  if (arm === "control") return "komodo";
  return arm;
}

const DISPLAY_ORDER: Record<string, number> = {
  greptile: 0,
  control: 1,
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
