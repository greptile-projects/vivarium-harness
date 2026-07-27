import { describe, expect, it } from "bun:test";
import {
  TOOLCHAIN,
  plannerPrompt,
  retryPrompt,
  reviewPrompt,
  workerPrompt,
} from "../src/harness/prompts.js";

const PR_URL = "https://github.com/greptile-projects/vivarium-tuatara/pull/7";

describe("reviewPrompt", () => {
  it("makes every new root comment mandatory, and tells it where to look", () => {
    const prompt = reviewPrompt(PR_URL, 1, 5);
    expect(prompt).toContain(PR_URL);
    expect(prompt).toContain("round 1 of at most 5");
    expect(prompt).toContain("without an `in_reply_to_id` is a new root comment");
    expect(prompt).toContain("must address every substantive new root comment");
    expect(prompt).toContain("regardless of which review round");
    expect(prompt).toContain("gh api user --jq .login");
    expect(prompt).toContain("thread contains no reply authored by that login");
    expect(prompt).toContain("scan the complete conversation");
    expect(prompt).toContain("Reactions are acknowledgements and need no reply");
    // The comments themselves are never pasted in — what the arm chooses to
    // read is part of what is being observed.
    expect(prompt).toContain("gh pr view");
    // `gh pr view --comments` does not print inline comments, and inline
    // comments are where a Greptile review actually is.
    expect(prompt).toContain("pulls/{number}/comments");
    expect(prompt).not.toContain("REVIEW: done");
  });

  it("keeps new roots mandatory while making thread follow-ups optional", () => {
    const prompt = reviewPrompt(PR_URL, 2, 5);
    expect(prompt).toContain("round 2 of at most 5");
    expect(prompt).toContain("must address every substantive new root comment");
    expect(prompt).toContain("Replying to that follow-up is your choice");
    // Held position, concession and question are all named as legitimate, so
    // the arm is not being steered toward agreeing.
    expect(prompt).toContain("You still disagree");
    expect(prompt).toContain("treat that thread as settled");
    expect(prompt).toContain("does not close review of the whole PR");
    expect(prompt).toContain("new root comments elsewhere");
    expect(prompt).toContain("ask a question back");
    // Thread replies carry in_reply_to_id — the arm needs that to find what
    // Greptile said back inside a thread it already answered.
    expect(prompt).toContain("in_reply_to_id");
    // The harness, not a magic line in the arm's answer, controls termination.
    expect(prompt).not.toContain("REVIEW: done");
    expect(prompt).not.toContain("no further review is required");
  });
});

describe("TOOLCHAIN", () => {
  it("names the runtime, the authenticated CLI, and what is there to verify with", () => {
    // What an arm otherwise learns by failing: the package manager it should
    // reach for, and that `gh` needs no setup.
    expect(TOOLCHAIN).toContain("bun");
    expect(TOOLCHAIN).toContain("bunx");
    // Both halves of the arms' repo: a Bun/Next front end and a Go API, whose
    // checks the arm can only run before pushing if it knows `go` is here.
    expect(TOOLCHAIN).toContain("go");
    expect(TOOLCHAIN).toContain("gh");
    expect(TOOLCHAIN).toContain("authenticated");
    // A missing tool is checkable and installable, not a dead end — the image
    // does not carry every toolchain the target repository uses.
    expect(TOOLCHAIN).toContain("command -v");
    // Says nothing about which arm is reading it.
    expect(TOOLCHAIN).not.toMatch(/komodo|tuatara|greptile/i);
  });

  it("names the two things the arm cannot find by looking around", () => {
    // Docker and a browser are both in the image now, and neither announces
    // itself: `docker` on PATH says nothing about *whose* daemon it is, and an
    // arm that assumes the host's would reason about isolation it does not
    // have. The screen is worse — an X server the arm is never told about is
    // one it never draws on, so the browser might as well not be installed.
    expect(TOOLCHAIN).toContain("docker");
    expect(TOOLCHAIN).toContain("daemon of your own");
    expect(TOOLCHAIN).toContain("rather than the host's");
    expect(TOOLCHAIN).toContain("chromium");
    expect(TOOLCHAIN).toContain("$DISPLAY");
    // The way in for a script rather than a human: `browser` starts it,
    // 9222 is where the DevTools protocol answers. Both are contracts with
    // scripts/arm-browser.sh, which is what the image installs as `browser`.
    expect(TOOLCHAIN).toContain("browser <url>");
    expect(TOOLCHAIN).toContain("9222");
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
    // The retry follows a thread or worker prompt that already supplied the
    // toolchain, so it points back to that context without repeating it.
    expect(prompt).not.toContain(TOOLCHAIN);
    expect(prompt).toContain("environment is unchanged");
    expect(prompt).toContain("available tools");
  });
});

describe("plannerPrompt", () => {
  it("embeds the North Star, ladder, blindness, and direct-edit contract", () => {
    const prompt = plannerPrompt("## Milestone 1: Repo hosting", 2, "LADDER.md");
    expect(prompt).toContain("## Role");
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("## Assigned Task");
    expect(prompt).toContain("## Work Instructions");
    expect(prompt).toContain("## Ladder Format");
    expect(prompt).toContain("## Agent Format and Expectations");
    expect(prompt).toContain("collaborative coding");
    expect(prompt).toContain("can *never* be completed");
    expect(prompt).toContain("blind to the workers");
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
