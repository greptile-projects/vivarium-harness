import { describe, expect, it } from "bun:test";
import { parseMilestone, plannerPrompt } from "../src/greg/planner.js";

describe("plannerPrompt", () => {
  it("embeds the North Star, ladder, blindness, and output contract", () => {
    const prompt = plannerPrompt("## Milestone 1: Repo hosting", 2);
    expect(prompt).toContain("clone of GitHub");
    expect(prompt).toContain("direction, not a finish line");
    expect(prompt).toContain("blind to the builders");
    expect(prompt).toContain("## Milestone 1: Repo hosting");
    expect(prompt).toContain("milestone 2");
    expect(prompt).toContain("2.1");
    expect(prompt).toContain("<<<MILESTONE>>>");
  });

  it("marks the first turn when the ladder is empty", () => {
    expect(plannerPrompt("   ", 1)).toContain("very first");
  });
});

describe("parseMilestone", () => {
  it("parses a well-formed milestone block", () => {
    const output = `Here is my plan.

<<<MILESTONE>>>
{"title": "Repo hosting", "ticket": "ENG-10", "summary": "host repos", "subtickets": [{"title": "Skeleton", "ticket": "ENG-11", "description": "Scaffold the app."}, {"title": "Storage", "description": "Add git storage."}]}
<<<MILESTONE_END>>>`;

    expect(parseMilestone(output)).toEqual({
      title: "Repo hosting",
      ticket: "ENG-10",
      summary: "host repos",
      subtickets: [
        { title: "Skeleton", ticket: "ENG-11", description: "Scaffold the app." },
        { title: "Storage", ticket: undefined, description: "Add git storage." },
      ],
    });
  });

  it("takes the last block when the contract is quoted earlier", () => {
    const output = `The contract says to emit <<<MILESTONE>>> ... <<<MILESTONE_END>>>.

<<<MILESTONE>>>
{"title": "Real milestone", "subtickets": [{"title": "S1", "description": "do 1"}, {"title": "S2", "description": "do 2"}]}
<<<MILESTONE_END>>>`;

    const milestone = parseMilestone(output);
    expect(milestone.title).toBe("Real milestone");
    expect(milestone.ticket).toBeUndefined();
    expect(milestone.subtickets).toHaveLength(2);
  });

  it("throws when no milestone block is present", () => {
    expect(() => parseMilestone("just some prose")).toThrow(/no milestone block/);
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      parseMilestone("<<<MILESTONE>>>\nnot json\n<<<MILESTONE_END>>>"),
    ).toThrow(/not valid JSON/);
  });

  it("enforces the 2–5 subticket bounds so the runaway cap holds", () => {
    const block = (count: number): string => {
      const subs = Array.from({ length: count }, (_, index) => ({
        title: `S${index}`,
        description: `do ${index}`,
      }));
      return `<<<MILESTONE>>>\n${JSON.stringify({ title: "M", subtickets: subs })}\n<<<MILESTONE_END>>>`;
    };

    // Below the floor (0 or 1) and above the ceiling (6+) are rejected.
    expect(() => parseMilestone(block(0))).toThrow(/2–5 subtickets, got 0/);
    expect(() => parseMilestone(block(1))).toThrow(/2–5 subtickets, got 1/);
    expect(() => parseMilestone(block(6))).toThrow(/2–5 subtickets, got 6/);

    // The full valid range parses.
    expect(parseMilestone(block(2)).subtickets).toHaveLength(2);
    expect(parseMilestone(block(5)).subtickets).toHaveLength(5);
  });

  it("throws when a subticket is missing its description", () => {
    expect(() =>
      parseMilestone(
        '<<<MILESTONE>>>\n{"title": "M", "subtickets": [{"title": "S"}]}\n<<<MILESTONE_END>>>',
      ),
    ).toThrow(/missing a title or description/);
  });
});
