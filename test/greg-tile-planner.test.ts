import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { findTranscript } from "../src/harness/artifacts.js";
import type { HarnessConfig } from "../src/harness/config.js";
import type { AttemptRunner } from "../src/harness/harness.js";
import { initLadder, readLadder } from "../src/greg-tile/ladder.js";
import { planNextMilestone } from "../src/greg-tile/planner.js";
import { attachSessionUsage } from "../src/harness/session.js";

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
  containerImage: "vivarium-arm",
  idleTimeoutMs: 600_000,
  land: false,
  reviewTimeoutMs: 1_000,
  reviewPollMs: 10,
  reviewDebounceMs: 0,
  reviewRounds: 2,
} as unknown as HarnessConfig;

describe("planNextMilestone", () => {
  it("runs Greg with write access and accepts the milestone he appends", async () => {
    const ladderPath = await scratchLadder();
    const specs: Array<{ sandbox: string; cwd: string; saw: string[] }> = [];

    const runner: AttemptRunner = async (spec) => {
      // Read the workspace while the session is live — it is removed after.
      specs.push({
        sandbox: spec.sandbox,
        cwd: spec.cwd,
        saw: await readdir(spec.cwd),
      });
      // Greg edits the file directly instead of returning structured data.
      await appendFile(
        ladderPath,
        "\n## Milestone 1: Repo hosting\n\n### [ ] 1.1 Skeleton — ENG-11\n\nScaffold it.\n",
        "utf8",
      );
      return { output: "done", isError: false, timedOut: false };
    };

    await planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner);

    // Greg gets write access so he can edit the ladder.
    expect(specs[0].sandbox).toBe("workspace-write");
    expect(await readLadder(ladderPath)).toContain("## Milestone 1: Repo hosting");
  });

  // The confound this isolation exists to kill. Greg used to run with cwd = the
  // harness repo root, which is where LADDER.md lives — and Codex loads
  // AGENTS.md from its working directory as instructions, so the document
  // naming both arms and the reviewer asymmetry was in his context on every
  // planning turn, automatically. That same directory holds results/ (both
  // arms' pull requests), .env (both tokens), and both checkouts as siblings.
  it("plans in a scratch directory holding only the ladder", async () => {
    const ladderPath = await scratchLadder();
    let cwd = "";
    let saw: string[] = [];

    const runner: AttemptRunner = async (spec) => {
      cwd = spec.cwd;
      saw = await readdir(spec.cwd);
      await appendFile(
        spec.cwd + "/" + basename(ladderPath),
        "\n## Milestone 1: M1\n\n### [ ] 1.1 A\n\ndo A\n",
        "utf8",
      );
      return { output: "done", isError: false, timedOut: false };
    };

    await planNextMilestone(base, ladderPath, await readLadder(ladderPath), 1, runner);

    // Nothing but the ladder is reachable without leaving the workspace.
    expect(saw).toEqual([basename(ladderPath)]);
    // And it is not the directory the real ladder lives in.
    expect(cwd).not.toBe(dirname(ladderPath));
    // What Greg wrote in the scratch copy reaches the real ladder.
    expect(await readLadder(ladderPath)).toContain("## Milestone 1: M1");
    // The scratch directory does not outlive the session.
    expect(await readdir(cwd).then(() => true).catch(() => false)).toBe(false);
  });

  it("uses an ephemeral container when both arms are containerized", async () => {
    const ladderPath = await scratchLadder();
    const codexHome = join(dirname(ladderPath), "codex");
    const isolated = {
      ...base,
      arms: [
        {
          name: "komodo",
          repo: "/tmp/komodo",
          container: "vivarium-komodo",
        },
        {
          name: "tuatara",
          repo: "/tmp/tuatara",
          container: "vivarium-tuatara",
        },
      ],
      codexHome,
      containerImage: "vivarium-arm:test",
    } as HarnessConfig;
    let launch: string[] = [];

    const runner: AttemptRunner = async (spec) => {
      expect(spec.cwd).toBe("/workspace");
      expect(spec.sandbox).toBe("danger-full-access");
      launch = spec.exec ?? [];

      const workspaceMount = launch.find(
        (argument) =>
          argument.startsWith("type=bind,source=") &&
          argument.endsWith(",target=/workspace"),
      );
      expect(workspaceMount).toBeDefined();
      const workspace = workspaceMount
        ?.slice("type=bind,source=".length)
        .replace(/,target=\/workspace$/, "");
      expect(workspace).toBeDefined();
      expect(await readdir(workspace as string)).toEqual(["LADDER.md"]);
      const sessionMount = launch.find(
        (argument) =>
          argument.startsWith("type=bind,source=") &&
          argument.endsWith(",target=/codex/sessions"),
      );
      expect(sessionMount).toBeDefined();
      const sessionDirectory = sessionMount
        ?.slice("type=bind,source=".length)
        .replace(/,target=\/codex\/sessions$/, "");
      expect(await readdir(sessionDirectory as string)).toEqual([]);
      await appendFile(
        join(sessionDirectory as string, "rollout-isolated-thread.jsonl"),
        '{"thread":"isolated-thread"}\n',
        "utf8",
      );
      await appendFile(
        join(workspace as string, "LADDER.md"),
        "\n## Milestone 1: Isolated\n\n### [ ] 1.1 A\n\ndo A\n",
        "utf8",
      );
      return {
        output: "done",
        isError: false,
        timedOut: false,
        threadId: "isolated-thread",
      };
    };

    await planNextMilestone(
      isolated,
      ladderPath,
      await readLadder(ladderPath),
      1,
      runner,
    );

    expect(launch.slice(0, 5)).toEqual(["docker", "run", "--rm", "-i", "--env"]);
    expect(launch).toContain("VIVARIUM_DOCKER=0");
    expect(launch).toContain("VIVARIUM_GUI=0");
    expect(launch).toContain(
      `type=bind,source=${join(codexHome, "auth.json")},target=/codex/auth.json,readonly`,
    );
    expect(launch).not.toContain(
      `type=bind,source=${join(codexHome, "sessions")},target=/codex/sessions`,
    );
    expect(launch.at(-1)).toBe("vivarium-arm:test");
    expect(launch.join(" ")).not.toContain(ladderPath);
    expect(
      await findTranscript(join(codexHome, "sessions"), "isolated-thread"),
    ).toBeDefined();
    expect(await readLadder(ladderPath)).toContain("## Milestone 1: Isolated");
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

describe("planner session preservation", () => {
  // Greg's planning turn runs outside runHarness, so nothing copies its
  // transcript automatically. Codex files sessions under CODEX_HOME by thread
  // id alone, so returning the id is the only thing that keeps his raw
  // reasoning findable among hundreds of siblings — and this experiment's whole
  // premise is preserving everything to read later.
  it("hands back the planning session's thread id", async () => {
    const ladderPath = await scratchLadder();
    const runner: AttemptRunner = async (_params, _onEvent) => {
      await appendFile(
        ladderPath,
        "\n## Milestone 1: M1\n\n### [ ] 1.1 A\n\ndo A\n",
        "utf8",
      );
      return {
        output: "done",
        isError: false,
        timedOut: false,
        threadId: "thread-xyz",
      };
    };

    const threadId = await planNextMilestone(
      base,
      ladderPath,
      "",
      1,
      runner,
    );
    expect(threadId).toBe("thread-xyz");
  });

  // A session that never reported one still planned a real milestone; the
  // climb must continue, with the gap recorded rather than the rung lost.
  it("returns undefined when the session reported no thread id", async () => {
    const ladderPath = await scratchLadder();
    const runner: AttemptRunner = async () => {
      await appendFile(
        ladderPath,
        "\n## Milestone 1: M1\n\n### [ ] 1.1 A\n\ndo A\n",
        "utf8",
      );
      return { output: "done", isError: false, timedOut: false };
    };

    expect(
      await planNextMilestone(base, ladderPath, "", 1, runner),
    ).toBeUndefined();
  });

  // The thread id finds the transcript, but not what Greg was *given*: the prompt
  // as sent and the ladder he was actually shown. Those go beside the transcript,
  // per attempt — including attempts that failed, whose thread ids never make it
  // back here at all.
  it("writes each attempt's prompt, ladder and outcome beside the transcript", async () => {
    const ladderPath = await scratchLadder();
    const resultsDir = join(dirname(ladderPath), "results");
    const runner: AttemptRunner = async () => {
      await appendFile(
        ladderPath,
        "\n## Milestone 1: M1\n\n### [ ] 1.1 A\n\ndo A\n",
        "utf8",
      );
      return {
        output: "appended",
        isError: false,
        timedOut: false,
        threadId: "greg-thread",
        usage: { totalTokens: 8_400 },
      };
    };

    await planNextMilestone(
      { ...base, resultsDir } as HarnessConfig,
      ladderPath,
      await readLadder(ladderPath),
      1,
      runner,
    );

    const planner = join(resultsDir, "planner");
    expect(
      await readFile(join(planner, "milestone-1-attempt-01-prompt.txt"), "utf8"),
    ).toContain("Greg Tile");
    const before = await readFile(
      join(planner, "milestone-1-attempt-01-ladder-before.md"),
      "utf8",
    );
    expect(before).toContain("North Star");
    expect(before).not.toContain("Milestone 1: M1");

    const outcome = JSON.parse(
      await readFile(join(planner, "milestone-1-attempt-01-outcome.json"), "utf8"),
    );
    expect(outcome.status).toBe("succeeded");
    expect(outcome.threadId).toBe("greg-thread");
    expect(outcome.usage.totalTokens).toBe(8_400);
  });

  it("records a failed attempt, and what it spent before dying", async () => {
    const ladderPath = await scratchLadder();
    const resultsDir = join(dirname(ladderPath), "results");
    const runner: AttemptRunner = async () => {
      throw attachSessionUsage(
        new Error("watchdog aborted greg: no activity for 600000ms"),
        { totalTokens: 33_000 },
      );
    };

    await expect(
      planNextMilestone(
        { ...base, resultsDir } as HarnessConfig,
        ladderPath,
        await readLadder(ladderPath),
        1,
        runner,
      ),
    ).rejects.toThrow(/watchdog aborted greg/);

    const planner = join(resultsDir, "planner");
    // Both attempts, not just the last: each is a fresh session, so their costs
    // genuinely add.
    for (const attempt of ["01", "02"]) {
      const outcome = JSON.parse(
        await readFile(
          join(planner, `milestone-1-attempt-${attempt}-outcome.json`),
          "utf8",
        ),
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.error).toContain("watchdog aborted greg");
      expect(outcome.usage.totalTokens).toBe(33_000);
    }
  });
});
