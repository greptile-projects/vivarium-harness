import { describe, expect, it } from "bun:test";
import {
  REVIEW_CLOSED_MARKER,
  TOOLCHAIN,
  plannerPrompt,
  retryPrompt,
  reviewPrompt,
  workerPrompt,
} from "../src/harness/prompts.js";

const PR_URL = "https://github.com/greptile-projects/vivarium-tuatara/pull/7";

describe("reviewPrompt", () => {
  it("makes round one answer every comment, and tells it where to look", () => {
    const prompt = reviewPrompt(PR_URL, 1, 5);
    expect(prompt).toContain(PR_URL);
    expect(prompt).toContain("round 1 of at most 5");
    expect(prompt).toContain("Address each comment");
    // The comments themselves are never pasted in — what the arm chooses to
    // read is part of what is being observed.
    expect(prompt).toContain("fetch it yourself");
    // `gh pr view --comments` does not print inline comments, and inline
    // comments are where a Greptile review actually is.
    expect(prompt).toContain("pulls/{number}/comments");
    // The arm cannot end the exchange before the reviewer has seen its first
    // answers, so round one is never told how to.
    expect(prompt).not.toContain(REVIEW_CLOSED_MARKER);
  });

  it("lets a follow-up round decide whether to reply at all", () => {
    const prompt = reviewPrompt(PR_URL, 2, 5);
    expect(prompt).toContain("round 2 of at most 5");
    expect(prompt).toContain("Replying is optional");
    // Held position, concession and question are all named as legitimate, so
    // the arm is not being steered toward agreeing.
    expect(prompt).toContain("You still disagree");
    expect(prompt).toContain("ask your own question back");
    // Thread replies carry in_reply_to_id — the arm needs that to find what
    // Greptile said back inside a thread it already answered.
    expect(prompt).toContain("in_reply_to_id");
    // And the way to say it is finished.
    expect(prompt).toContain(REVIEW_CLOSED_MARKER);
    // It is not the round-one instruction again: repeating "address every
    // comment" would order the arm to re-answer what it already answered.
    expect(prompt).not.toContain("Address each comment");
  });
});

describe("TOOLCHAIN", () => {
  it("names the runtime, the authenticated CLI, and what is absent", () => {
    // The three an arm otherwise learns by failing: the package manager it
    // should reach for, that `gh` needs no setup, and that a browser or a
    // nested container is not there to verify with.
    expect(TOOLCHAIN).toContain("Bun");
    expect(TOOLCHAIN).toContain("bunx");
    expect(TOOLCHAIN).toContain("gh");
    expect(TOOLCHAIN).toContain("authenticated");
    expect(TOOLCHAIN).toContain("no browser and no Docker");
    // A missing tool is checkable and installable, not a dead end — the image
    // does not carry every toolchain the target repository uses.
    expect(TOOLCHAIN).toContain("command -v");
    // Says nothing about which arm is reading it.
    expect(TOOLCHAIN).not.toMatch(/komodo|tuatara|greptile/i);
  });

  it("reaches every instruction that can be an arm's first message", () => {
    // The task, and a review round — which runs on a fresh thread whenever the
    // build session left no thread id behind, and is then the only thing the
    // arm has been told.
    expect(workerPrompt("ENG-123")).toContain(TOOLCHAIN);
    expect(reviewPrompt(PR_URL, 1, 5)).toContain(TOOLCHAIN);
    expect(reviewPrompt(PR_URL, 2, 5)).toContain(TOOLCHAIN);
  });

  it("is pointed to, not repeated, on a retry", () => {
    const prompt = retryPrompt("boom", 1, 2);
    // A retry always follows either the same thread or the worker prompt it is
    // prepended to, so the full list would be a second copy — but the reading
    // it exists to head off is "the tool is missing".
    expect(prompt).not.toContain(TOOLCHAIN);
    expect(prompt).toContain("command -v");
    expect(prompt).toContain("bun");
  });
});

describe("plannerPrompt", () => {
  it("embeds the North Star, ladder, blindness, and direct-edit contract", () => {
    const prompt = plannerPrompt("## Milestone 1: Repo hosting", 2, "LADDER.md");
    expect(prompt).toContain("clone of GitHub");
    expect(prompt).toContain("direction, not a finish line");
    expect(prompt).toContain("blind to the builders");
    expect(prompt).toContain("## Milestone 1: Repo hosting");
    expect(prompt).toContain("milestone 2");
    // The contract is now: edit the ladder file directly with checkbox headings.
    expect(prompt).toContain("editing the file directly");
    // Greg does not file tickets — headless codex blocks destructive MCP tool
    // calls, so the loop files Linear mechanically after planning.
    expect(prompt).toContain("Do NOT file any tickets");
    expect(prompt).not.toContain("File it in Linear");
    expect(prompt).toContain("### [ ] 2.1");
    expect(prompt).toContain("LADDER.md");
    expect(prompt).toContain("## Objective");
    expect(prompt).toContain("## Deliverable");
    expect(prompt).toContain("## Framing question");
    expect(prompt).toContain("Do not add separate Acceptance criteria or Constraints");
    // No more JSON hand-off.
    expect(prompt).not.toContain("<<<MILESTONE>>>");
  });

  it("marks the first turn when the ladder is empty", () => {
    expect(plannerPrompt("   ", 1, "LADDER.md")).toContain("very first");
  });
});
