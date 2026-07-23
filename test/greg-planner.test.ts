import { describe, expect, it } from "bun:test";
import { parseRung, plannerPrompt } from "../src/greg/planner.js";

describe("plannerPrompt", () => {
  it("embeds the North Star, ladder, and output contract", () => {
    const prompt = plannerPrompt("## Rung 1: Bootstrap", 2);
    expect(prompt).toContain("clone of GitHub");
    expect(prompt).toContain("direction, not a finish line");
    expect(prompt).toContain("## Rung 1: Bootstrap");
    expect(prompt).toContain("rung 2");
    expect(prompt).toContain("<<<RUNG>>>");
  });

  it("marks the first turn when the ladder is empty", () => {
    expect(plannerPrompt("   ", 1)).toContain("very first");
  });
});

describe("parseRung", () => {
  it("parses a well-formed rung block", () => {
    const output = `Here is my plan.

<<<RUNG>>>
{"title": "Add auth", "ticket": "ENG-7", "summary": "login", "description": "Implement email login with sessions."}
<<<RUNG_END>>>`;

    expect(parseRung(output)).toEqual({
      title: "Add auth",
      ticket: "ENG-7",
      summary: "login",
      description: "Implement email login with sessions.",
    });
  });

  it("takes the last block when the contract is quoted earlier", () => {
    const output = `The contract says to emit <<<RUNG>>> ... <<<RUNG_END>>>.

<<<RUNG>>>
{"title": "Real rung", "description": "the actual body"}
<<<RUNG_END>>>`;

    const rung = parseRung(output);
    expect(rung.title).toBe("Real rung");
    expect(rung.ticket).toBeUndefined();
  });

  it("throws when no rung block is present", () => {
    expect(() => parseRung("just some prose")).toThrow(/no rung block/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseRung("<<<RUNG>>>\nnot json\n<<<RUNG_END>>>")).toThrow(
      /not valid JSON/,
    );
  });

  it("throws when title or description is missing", () => {
    expect(() =>
      parseRung('<<<RUNG>>>\n{"title": "only title"}\n<<<RUNG_END>>>'),
    ).toThrow(/missing a title or description/);
  });
});
