import { describe, expect, it } from "bun:test";
import { highestMilestone, parseSubtickets } from "../src/greg-tile/ladder.js";
import { plannerPrompt, reviewPrompt } from "../src/harness/prompts.js";

// The prompts are hand-authored and are the experiment's independent variable:
// they get rewritten whenever the experiment wants different behaviour, so
// nothing here asserts what they *say*. What is tested is mechanical — the
// runtime values a prompt must carry, and the one cross-module contract: the
// subticket heading `plannerPrompt` dictates has to be the heading
// `greg-tile/ladder.ts` parses back out of the ladder.

const PR_URL = "https://github.com/greptile-projects/vivarium-tuatara/pull/7";

describe("plannerPrompt", () => {
  it("carries the ladder it was handed and the file it may edit", () => {
    const prompt = plannerPrompt("## Milestone 1: Repo hosting", 2, "LADDER.md");

    expect(prompt).toContain("## Milestone 1: Repo hosting");
    expect(prompt).toContain("LADDER.md");
  });

  it("dictates a milestone heading that ladder.ts numbers correctly", () => {
    // The prompt asks for milestone 2 and shows the heading to write; the
    // loop's own numbering reads that heading back.
    expect(
      highestMilestone(plannerPrompt("## Milestone 1: Repo hosting", 2, "LADDER.md")),
    ).toBe(2);
  });

  it("dictates a subticket heading that ladder.ts can parse", () => {
    // The contract: the format example in the planner prompt is exactly what
    // `parseSubtickets` reads. If either side changes shape, this fails.
    const parsed = parseSubtickets(plannerPrompt("", 2, "LADDER.md"));
    const first = parsed.find((subticket) => subticket.number === "2.1");

    expect(first).toBeDefined();
    expect(first?.milestone).toBe(2);
    // The dictated box is unchecked — the loop builds only unchecked rungs.
    expect(first?.done).toBe(false);
    expect(first?.title.length).toBeGreaterThan(0);
    expect(first?.description.length).toBeGreaterThan(0);
  });
});

describe("reviewPrompt", () => {
  it("names the pull request the round is about", () => {
    expect(reviewPrompt(PR_URL, 1, 5)).toContain(PR_URL);
  });
});
