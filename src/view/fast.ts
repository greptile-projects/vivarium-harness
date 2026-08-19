import type { Popup } from "./quit.js";

// The live fast-tier switch: `f` in the view flips whether Codex sessions are
// started on the fast service tier, without quitting the harness. The switch is
// read where a task's config is assembled (src/climb.ts), so it takes effect at
// the next task boundary — the next subticket, or the next planning turn.
// Sessions already in flight keep the tier their thread was created with, and
// both arms and Greg always flip together, so the A/B inputs stay identical.

// The confirmation box `f` opens. Same machinery and same reason as the quit
// popups: a reattaching terminal can replay stray key bytes, and this switch
// changes what every later session spends — so only a deliberate `y` inside a
// box naming the change may flip it.
export function fastModePopup(next: boolean): Popup {
  return {
    kind: "confirm",
    action: "fast-mode",
    message: next
      ? "switch Codex to the fast tier from the next task?  y / n"
      : "return Codex to the standard tier from the next task?  y / n",
  };
}

// The header badge while the switch is on: a chevron wave with one lit glyph
// walking forward each frame, so the badge reads as motion — speed — rather
// than as one more static word. Pure so the walk is testable; the view owns
// the colors.
export interface FastGlyph {
  glyph: string;
  lit: boolean;
}

export const FAST_LABEL = "fast";

const CHEVRONS = 3;

export function fastChevrons(frame: number): FastGlyph[] {
  const lit = ((frame % CHEVRONS) + CHEVRONS) % CHEVRONS;
  return Array.from({ length: CHEVRONS }, (_, index) => ({
    glyph: "▸",
    lit: index === lit,
  }));
}
