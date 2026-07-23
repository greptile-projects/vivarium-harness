import { describe, expect, it } from "bun:test";
import {
  NORTH_STAR_SENTINEL,
  parseRungOutput,
  plannerPrompt,
} from "../src/greg/planner.js";

describe("plannerPrompt", () => {
  it("embeds the North Star, ladder, and output contract", () => {
    const prompt = plannerPrompt("Clone GitHub", "## Rung 1: Bootstrap", 2);
    expect(prompt).toContain("Clone GitHub");
    expect(prompt).toContain("## Rung 1: Bootstrap");
    expect(prompt).toContain("rung 2");
    expect(prompt).toContain("<<<RUNG>>>");
    expect(prompt).toContain(NORTH_STAR_SENTINEL);
  });

  it("marks the first turn when the ladder is empty", () => {
    expect(plannerPrompt("goal", "   ", 1)).toContain("very first");
  });
});

describe("parseRungOutput", () => {
  it("parses a well-formed rung block", () => {
    const output = `Here is my plan.

<<<RUNG>>>
{"title": "Add auth", "ticket": "ENG-7", "summary": "login", "description": "Implement email login with sessions."}
<<<RUNG_END>>>`;

    const outcome = parseRungOutput(output);
    expect(outcome).toEqual({
      kind: "rung",
      rung: {
        title: "Add auth",
        ticket: "ENG-7",
        summary: "login",
        description: "Implement email login with sessions.",
      },
    });
  });

  it("takes the last block when the contract is quoted earlier", () => {
    const output = `The contract says to emit <<<RUNG>>> ... <<<RUNG_END>>>.

<<<RUNG>>>
{"title": "Real rung", "description": "the actual body"}
<<<RUNG_END>>>`;

    const outcome = parseRungOutput(output);
    expect(outcome.kind).toBe("rung");
    if (outcome.kind === "rung") {
      expect(outcome.rung.title).toBe("Real rung");
      expect(outcome.rung.ticket).toBeUndefined();
    }
  });

  it("detects the North Star sentinel", () => {
    expect(parseRungOutput(`done!\n${NORTH_STAR_SENTINEL}`)).toEqual({
      kind: "north-star-reached",
    });
  });

  it("throws when no rung block is present", () => {
    expect(() => parseRungOutput("just some prose")).toThrow(/no rung block/);
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      parseRungOutput("<<<RUNG>>>\nnot json\n<<<RUNG_END>>>"),
    ).toThrow(/not valid JSON/);
  });

  it("throws when title or description is missing", () => {
    expect(() =>
      parseRungOutput('<<<RUNG>>>\n{"title": "only title"}\n<<<RUNG_END>>>'),
    ).toThrow(/missing a title or description/);
  });
});
