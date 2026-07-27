import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initLadder,
  parseMilestone,
  readLadder,
  recordTicketId,
} from "../src/greg-tile/ladder.js";
import {
  closeSubticketInLinear,
  extractIssueId,
  fileMilestoneInLinear,
  pickRungMilestone,
  rungMilestoneName,
} from "../src/greg-tile/linear.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function scratchLadder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "greg-linear-"));
  temporaryDirectories.push(root);
  const ladderPath = join(root, "LADDER.md");
  await initLadder(ladderPath, "goal");
  await appendFile(
    ladderPath,
    "\n## Milestone 3: Quality gates\n\nMake branches trustworthy.\n\n### [ ] 3.1 Commit checks\n\nReport statuses.\n\n### [ ] 3.2 Branch rules — GRE-77\n\nEnforce them.\n",
    "utf8",
  );
  return ladderPath;
}

describe("parseMilestone", () => {
  it("reads the heading title, existing id, and summary", async () => {
    const ladderPath = await scratchLadder();
    const ladder = await readLadder(ladderPath);

    const milestone = parseMilestone(ladder, 3);
    expect(milestone?.title).toBe("Quality gates");
    expect(milestone?.ticket).toBeUndefined();
    expect(milestone?.summary).toBe("Make branches trustworthy.");
    expect(parseMilestone(ladder, 9)).toBeNull();
  });
});

describe("recordTicketId", () => {
  it("stamps ids onto milestone and subticket headings, never twice", async () => {
    const ladderPath = await scratchLadder();

    await recordTicketId(ladderPath, { milestone: 3 }, "GRE-90");
    await recordTicketId(ladderPath, { subticket: "3.1" }, "GRE-91");
    // Already has an id — must be left untouched.
    await recordTicketId(ladderPath, { subticket: "3.2" }, "GRE-99");
    // Second stamp on the same heading is a no-op.
    await recordTicketId(ladderPath, { milestone: 3 }, "GRE-100");

    const ladder = await readLadder(ladderPath);
    expect(ladder).toContain("## Milestone 3: Quality gates — GRE-90");
    expect(ladder).toContain("### [ ] 3.1 Commit checks — GRE-91");
    expect(ladder).toContain("### [ ] 3.2 Branch rules — GRE-77");
    expect(ladder).not.toContain("GRE-99");
    expect(ladder).not.toContain("GRE-100");
  });
});

describe("extractIssueId", () => {
  it("pulls the identifier out of JSON responses and free text", () => {
    expect(extractIssueId('{"identifier":"GRE-41","title":"x"}')).toBe("GRE-41");
    expect(extractIssueId('{"id":"GRE-42"}')).toBe("GRE-42");
    // A non-identifier id falls back to scanning the text.
    expect(extractIssueId('{"id":"3f9c","identifier":"GRE-43"}')).toBe("GRE-43");
    expect(extractIssueId("Created issue GRE-44 (Quality gates)")).toBe("GRE-44");
    expect(extractIssueId("no id here")).toBeUndefined();
  });
});

describe("rung milestones", () => {
  it("names rungs to match the board convention", () => {
    expect(rungMilestoneName(3, "Quality gates")).toBe("Rung 3 — Quality gates");
  });

  it("finds an existing rung by prefix in a list_milestones payload", () => {
    const payload = JSON.stringify({
      milestones: [
        { id: "uuid-1", name: "Rung 1 — Git storage" },
        { id: "uuid-3", name: "Rung 3 — Quality gates (renamed)" },
      ],
    });
    expect(pickRungMilestone(payload, 3)).toBe("uuid-3");
    // "Rung 1" must not match a lookup for rung 10 and vice versa.
    expect(pickRungMilestone(payload, 10)).toBeUndefined();
    expect(pickRungMilestone(payload, 2)).toBeUndefined();
    // Bare-array payloads and items without ids degrade gracefully.
    expect(
      pickRungMilestone(JSON.stringify([{ name: "Rung 2 — Remotes" }]), 2),
    ).toBe("Rung 2 — Remotes");
    expect(pickRungMilestone("not json", 1)).toBeUndefined();
  });
});

describe("fileMilestoneInLinear", () => {
  it("skips without touching the network when Linear env is unset", async () => {
    const ladderPath = await scratchLadder();
    const logs: string[] = [];

    await fileMilestoneInLinear(ladderPath, 3, (m) => logs.push(m), {});

    expect(logs.join("\n")).toContain("LINEAR_API_KEY is unset");
    // Ladder untouched — no ids appeared.
    expect(await readLadder(ladderPath)).toContain("## Milestone 3: Quality gates\n");
  });

  it("skips when the milestone is not on the ladder", async () => {
    const ladderPath = await scratchLadder();
    const logs: string[] = [];

    await fileMilestoneInLinear(ladderPath, 8, (m) => logs.push(m), {
      LINEAR_API_KEY: "key",
      LINEAR_TEAM: "team",
    });

    expect(logs.join("\n")).toContain("milestone 8 not found");
  });
});

describe("closeSubticketInLinear", () => {
  it("logs a skip when the heading never got a Linear id", async () => {
    const logs: string[] = [];
    await closeSubticketInLinear(undefined, "3.1", (m) => logs.push(m), {});
    expect(logs.join("\n")).toContain("no Linear id");
  });

  it("fails closed when an issue exists but the key is missing", async () => {
    await expect(
      closeSubticketInLinear("GRE-90", "3.1", () => {}, {}),
    ).rejects.toThrow(/cannot close GRE-90 in Linear: LINEAR_API_KEY is unset/);
  });

});
