import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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

// No resultsDir: these cases are about the planning contract, and without one
// the planner records nothing (see the artifacts block at the bottom, which
// supplies one).
const base = {
  codexHome: "/tmp/codex",
  idleTimeoutMs: 600_000,
  land: false,
  reviewTimeoutMs: 1_000,
  reviewPollMs: 10,
  reviewRounds: 2,
} as unknown as HarnessConfig;

// Stubbed for the same reason the runner is: the real one shells out to git.
const provenance = async () => ({ commit: "cafe123", branch: "main", dirty: false });

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

// The planning session's own record. Until this existed Greg was the only agent
// in the experiment whose sessions wrote nothing at all: the ladder text was the
// whole artifact, so the reasoning behind a rung was gone the moment the session
// ended — and the rollout in $CODEX_HOME/sessions was unfindable afterwards
// because nothing recorded the thread id.
describe("planNextMilestone artifacts", () => {
  async function scratchRun(): Promise<{
    ladderPath: string;
    config: HarnessConfig;
    resultsDir: string;
    codexHome: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "greg-plan-artifacts-"));
    temporaryDirectories.push(root);
    const ladderPath = join(root, "LADDER.md");
    await initLadder(ladderPath, "goal");
    const resultsDir = join(root, "results");
    const codexHome = join(root, "codex");
    return {
      ladderPath,
      resultsDir,
      codexHome,
      config: { ...base, resultsDir, codexHome } as HarnessConfig,
    };
  }

  async function planDirectory(resultsDir: string): Promise<string> {
    const entries = await readdir(resultsDir);
    const plans = entries.filter((entry) => entry.startsWith("plan-"));
    expect(plans).toHaveLength(1);
    return join(resultsDir, plans[0]);
  }

  it("records the prompt, the ladder either side, the transcript and the cost", async () => {
    const { ladderPath, config, resultsDir, codexHome } = await scratchRun();
    const sessions = join(codexHome, "sessions", "2026", "07", "26");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-2026-07-26-greg-thread.jsonl"),
      '{"greg":"reasoning"}\n',
    );

    const runner: AttemptRunner = async () => {
      await appendFile(
        ladderPath,
        "\n## Milestone 1: Repo hosting\n\n### [ ] 1.1 Skeleton\n\nScaffold it.\n",
        "utf8",
      );
      return {
        output: "appended",
        isError: false,
        timedOut: false,
        threadId: "greg-thread",
        usage: { totalTokens: 8_400, contextWindow: 400_000 },
        raw: { structuredContent: { threadId: "greg-thread" } },
      };
    };

    await planNextMilestone(
      config,
      ladderPath,
      await readLadder(ladderPath),
      1,
      runner,
      provenance,
    );

    const directory = await planDirectory(resultsDir);
    const attempt = join(directory, "attempt-01");

    // The exact instruction, and the ladder exactly as Greg was shown it.
    expect(await readFile(join(attempt, "prompt.txt"), "utf8")).toContain(
      "You are Greg Tile",
    );
    const before = await readFile(join(attempt, "ladder-before.md"), "utf8");
    expect(before).toContain("## North Star");
    expect(before).not.toContain("Milestone 1");
    // And what he did to it.
    expect(await readFile(join(directory, "ladder-after.md"), "utf8")).toContain(
      "## Milestone 1: Repo hosting",
    );
    // The rollout, recovered by thread id the same way an arm's is.
    expect(await readFile(join(attempt, "transcript.jsonl"), "utf8")).toBe(
      '{"greg":"reasoning"}\n',
    );

    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    expect(manifest.status).toBe("planned");
    expect(manifest.milestone).toBe(1);
    expect(manifest.harness.commit).toBe("cafe123");
    expect(manifest.attempts).toHaveLength(1);
    expect(manifest.attempts[0].threadId).toBe("greg-thread");
    expect(manifest.attempts[0].transcriptStatus).toBe("copied");
    expect(manifest.tokens).toBe(8_400);
  });

  it("records a failed plan too, including what the ladder was left as", async () => {
    const { ladderPath, config, resultsDir } = await scratchRun();
    const runner: AttemptRunner = async () => {
      // A half-append: the session errors after touching the file, which is
      // exactly the state the next attempt has to be read against.
      await appendFile(ladderPath, "\n## Milestone 1: Half\n", "utf8");
      return { output: "boom", isError: true, timedOut: false };
    };

    await expect(
      planNextMilestone(
        config,
        ladderPath,
        await readLadder(ladderPath),
        1,
        runner,
        provenance,
      ),
    ).rejects.toThrow(/after 2 attempt\(s\)/);

    const directory = await planDirectory(resultsDir);
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    expect(manifest.status).toBe("failed");
    expect(manifest.error).toContain("Greg failed to plan milestone 1");
    expect(manifest.attempts).toHaveLength(2);
    expect(manifest.attempts.every((a: { status: string }) => a.status === "failed")).toBe(true);
    expect(manifest.attempts[0].transcriptStatus).toBe(
      "unavailable-no-thread-id",
    );
    expect(await readFile(join(directory, "ladder-after.md"), "utf8")).toContain(
      "## Milestone 1: Half",
    );
    expect(
      await readFile(join(directory, "attempt-02", "error.txt"), "utf8"),
    ).toContain("boom");
    // Attempt 2 was shown what attempt 1 left behind — the difference between
    // the two ladder-before files is the only place that is visible.
    expect(
      await readFile(join(directory, "attempt-02", "ladder-before.md"), "utf8"),
    ).toContain("## Milestone 1: Half");
  });

  it("keeps the session's spend when the session throws", async () => {
    const { ladderPath, config, resultsDir } = await scratchRun();
    const { attachSessionUsage } = await import("../src/live/stream.js");
    const runner: AttemptRunner = async () => {
      throw attachSessionUsage(
        new Error("watchdog aborted greg: no activity for 600000ms"),
        { totalTokens: 33_000 },
      );
    };

    await expect(
      planNextMilestone(
        config,
        ladderPath,
        await readLadder(ladderPath),
        1,
        runner,
        provenance,
      ),
    ).rejects.toThrow(/watchdog aborted greg/);

    const manifest = JSON.parse(
      await readFile(
        join(await planDirectory(resultsDir), "manifest.json"),
        "utf8",
      ),
    );
    // Two fresh sessions, so these add: statelessness means every planning
    // attempt is its own thread.
    expect(manifest.tokens).toBe(66_000);
    expect(manifest.attempts[0].usage.totalTokens).toBe(33_000);
  });

  it("plans without recording when no results dir is configured", async () => {
    const ladderPath = await scratchLadder();
    const runner: AttemptRunner = async () => {
      await appendFile(
        ladderPath,
        "\n## Milestone 1: Repo hosting\n\n### [ ] 1.1 Skeleton\n\nbody\n",
        "utf8",
      );
      return { output: "done", isError: false, timedOut: false };
    };
    await planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner);
    expect(await readLadder(ladderPath)).toContain("## Milestone 1");
  });
});
