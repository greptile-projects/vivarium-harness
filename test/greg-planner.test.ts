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
  land: false,
  reviewTimeoutMs: 1_000,
  reviewPollMs: 10,
  reviewRounds: 2,
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
    // Greg does not file tickets — headless codex blocks destructive MCP tool
    // calls, so the loop files Linear mechanically after planning.
    expect(prompt).toContain("Do NOT file any tickets");
    expect(prompt).not.toContain("File it in Linear");
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

  it("throws when Greg's session errors on every attempt", async () => {
    const ladderPath = await scratchLadder();
    let attempts = 0;
    const runner: AttemptRunner = async () => {
      attempts += 1;
      return { output: "boom", isError: true, timedOut: false };
    };

    await expect(
      planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner),
    ).rejects.toThrow(/Greg failed to plan milestone 1 after 2 attempt\(s\): boom/);
    expect(attempts).toBe(2);
  });

  it("retries once after a transient session failure (e.g. watchdog abort)", async () => {
    const ladderPath = await scratchLadder();
    let attempts = 0;
    const runner: AttemptRunner = async () => {
      attempts += 1;
      if (attempts === 1) {
        // First session wedges and is killed by the activity watchdog.
        throw new Error("watchdog aborted greg: no activity for 600000ms");
      }
      await appendFile(
        ladderPath,
        "\n## Milestone 1: Repo hosting\n\n### [ ] 1.1 Skeleton\n\nbody\n",
        "utf8",
      );
      return { output: "done", isError: false, timedOut: false };
    };

    await planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner);

    expect(attempts).toBe(2);
    expect(await readLadder(ladderPath)).toContain("## Milestone 1: Repo hosting");
  });

  it("throws without retrying when Greg appends no buildable milestone", async () => {
    const ladderPath = await scratchLadder();
    // Greg's session succeeds but leaves the ladder unchanged (no new
    // milestone). Wrong output isn't transient, so no second attempt.
    let attempts = 0;
    const runner: AttemptRunner = async () => {
      attempts += 1;
      return { output: "I thought about it", isError: false, timedOut: false };
    };

    await expect(
      planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner),
    ).rejects.toThrow(/did not append a buildable milestone 1/);
    expect(attempts).toBe(1);
  });

  it("rejects a milestone appended under the wrong number", async () => {
    const ladderPath = await scratchLadder();
    // Asked for milestone 2, Greg appends milestone 99 — accepting it would
    // resume the climb from the wrong rung, so the guard must reject it.
    const runner: AttemptRunner = async () => {
      await appendFile(
        ladderPath,
        "\n## Milestone 99: Way ahead\n\n### [ ] 99.1 Skip ahead\n\nbody\n",
        "utf8",
      );
      return { output: "done", isError: false, timedOut: false };
    };

    await expect(
      planNextMilestone(base, ladderPath, await readLadder(ladderPath), 2, runner),
    ).rejects.toThrow(/did not append a buildable milestone 2/);
  });

  it("accepts a milestone even while an earlier one is still unbuilt (write-ahead)", async () => {
    const ladderPath = await scratchLadder();
    // Milestone 1 was planned but never built — the write-ahead case.
    await appendFile(
      ladderPath,
      "\n## Milestone 1: First\n\n### [ ] 1.1 Skeleton\n\nbody\n",
      "utf8",
    );
    const runner: AttemptRunner = async () => {
      await appendFile(
        ladderPath,
        "\n## Milestone 2: Second\n\n### [ ] 2.1 Next\n\nbody\n",
        "utf8",
      );
      return { output: "done", isError: false, timedOut: false };
    };

    await planNextMilestone(base, ladderPath, await readLadder(ladderPath), 2, runner);

    expect(await readLadder(ladderPath)).toContain("## Milestone 2: Second");
  });
});
