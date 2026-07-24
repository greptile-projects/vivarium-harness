import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../src/config.js";
import type { AttemptRunner } from "../src/harness.js";
import { initLadder, readLadder } from "../src/greg/ladder.js";
import { planNextMilestone, plannerPrompt } from "../src/greg/planner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function scratchLadder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "greg-planner-"));
  temporaryDirectories.push(root);
  const ladderPath = join(root, "LADDER.md");
  await initLadder(ladderPath, "goal");
  return ladderPath;
}

const base = {
  codexHome: "/tmp/codex",
  idleTimeoutMs: 600_000,
} as unknown as HarnessConfig;

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
    expect(prompt).toContain("### [ ] 2.1");
    expect(prompt).toContain("LADDER.md");
    // No more JSON hand-off.
    expect(prompt).not.toContain("<<<MILESTONE>>>");
  });

  it("marks the first turn when the ladder is empty", () => {
    expect(plannerPrompt("   ", 1, "LADDER.md")).toContain("very first");
  });
});

describe("planNextMilestone", () => {
  it("runs Greg with write access and accepts the milestone he appends", async () => {
    const ladderPath = await scratchLadder();
    const specs: Array<{ sandbox: string; cwd: string }> = [];

    const runner: AttemptRunner = async (spec) => {
      specs.push({ sandbox: spec.sandbox, cwd: spec.cwd });
      // Greg edits the file directly instead of returning structured data.
      await appendFile(
        ladderPath,
        "\n## Milestone 1: Repo hosting\n\n### [ ] 1.1 Skeleton — ENG-11\n\nScaffold it.\n",
        "utf8",
      );
      return { output: "done", isError: false, timedOut: false };
    };

    await planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner);

    // Greg gets write access (so he can edit the ladder) in the ladder's dir.
    expect(specs[0].sandbox).toBe("workspace-write");
    expect(specs[0].cwd).toBe(join(ladderPath, ".."));
    expect(await readLadder(ladderPath)).toContain("## Milestone 1: Repo hosting");
  });

  it("throws when Greg's session errors", async () => {
    const ladderPath = await scratchLadder();
    const runner: AttemptRunner = async () => ({
      output: "boom",
      isError: true,
      timedOut: false,
    });

    await expect(
      planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner),
    ).rejects.toThrow(/Greg failed to plan milestone 1/);
  });

  it("throws when Greg appends no buildable milestone", async () => {
    const ladderPath = await scratchLadder();
    // Greg's session succeeds but leaves the ladder unchanged (no new milestone).
    const runner: AttemptRunner = async () => ({
      output: "I thought about it",
      isError: false,
      timedOut: false,
    });

    await expect(
      planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner),
    ).rejects.toThrow(/did not append a buildable milestone 1/);
  });
});
