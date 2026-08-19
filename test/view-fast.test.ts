import { describe, expect, it } from "bun:test";
import { fastChevrons, fastModePopup } from "../src/view/fast.js";
import { popupKey } from "../src/view/quit.js";

describe("fastModePopup", () => {
  // Both directions of the switch spend or stop spending credits from the next
  // task on, so both go through a confirm box rather than acting on `f` itself.
  it("is a confirm in both directions", () => {
    for (const next of [true, false]) {
      const popup = fastModePopup(next);
      expect(popup.kind).toBe("confirm");
      if (popup.kind === "confirm") expect(popup.action).toBe("fast-mode");
      expect(popup.message).toContain("y / n");
    }
  });

  // The same stray-keystroke rule as every other confirm: only `y` may be the
  // key that flips what later sessions cost.
  it("accepts only y", () => {
    expect(popupKey(fastModePopup(true), "y")).toBe("accept");
    expect(popupKey(fastModePopup(false), "Y")).toBe("accept");
    for (const key of ["n", "f", "F", "s", "q", " ", "1", ""]) {
      expect(popupKey(fastModePopup(true), key)).toBe("dismiss");
    }
  });
});

describe("fastChevrons", () => {
  // The badge sits in the header row; a width that changed between frames
  // would drag the summary beside it back and forth every tick.
  it("keeps a fixed width across frames", () => {
    const widths = new Set(
      Array.from({ length: 12 }, (_, frame) => fastChevrons(frame).length),
    );
    expect(widths.size).toBe(1);
  });

  it("lights exactly one chevron per frame", () => {
    for (let frame = 0; frame < 12; frame += 1) {
      expect(fastChevrons(frame).filter((c) => c.lit)).toHaveLength(1);
    }
  });

  // The animation: the lit glyph walks forward one place per frame and wraps,
  // which is what makes the badge read as motion rather than flicker.
  it("walks the lit chevron forward and wraps", () => {
    const count = fastChevrons(0).length;
    const positions = Array.from({ length: count * 2 + 1 }, (_, frame) =>
      fastChevrons(frame).findIndex((c) => c.lit),
    );
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBe((positions[index - 1]! + 1) % count);
    }
  });
});
