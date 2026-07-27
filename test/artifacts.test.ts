import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunArtifacts,
  redactArmConfig,
  totalTokens,
} from "../src/harness/artifacts.js";
import type { HarnessConfig } from "../src/harness/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("run artifacts", () => {
  it("persists run data and separates each arm's transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, "codex");
    const sessions = join(codexHome, "sessions", "2026", "07", "21");
    await mkdir(sessions, { recursive: true });

    const config: HarnessConfig = {
      ticket: "ENG-123",
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome,
      containerImage: "vivarium-arm",
      maxAttempts: 3,
      idleTimeoutMs: 600_000,
      land: false,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    const artifacts = await RunArtifacts.create(config, "exact prompt");
    const results = [];

    for (const arm of config.arms) {
      const threadId = `${arm.name}-thread`;
      const transcript = `{"arm":"${arm.name}"}\n`;
      await writeFile(
        join(sessions, `rollout-2026-07-21-${threadId}.jsonl`),
        transcript,
      );
      const artifactDir = await artifacts.startAttempt(
        arm,
        { prompt: "exact prompt", cwd: arm.repo },
        "2026-07-21T00:00:00.000Z",
        1,
      );
      results.push(await artifacts.finishArm({
        arm: arm.name,
        repo: arm.repo,
        attempt: 1,
        maxAttempts: 3,
        status: arm.name === "komodo" ? "succeeded" : "failed",
        startedAt: "2026-07-21T00:00:00.000Z",
        completedAt: "2026-07-21T00:01:00.000Z",
        durationMs: 60_000,
        threadId,
        ...(arm.name === "komodo"
          ? { output: `${arm.name} output` }
          : { error: `${arm.name} failed` }),
        artifactDir,
      }, { structuredContent: { threadId, content: `${arm.name} output` } }));
    }
    await artifacts.complete(results);

    expect(
      await readFile(join(artifacts.directory, "prompt.txt"), "utf8"),
    ).toBe("exact prompt\n");
    expect(
      await readFile(
        join(
          artifacts.directory,
          "komodo",
          "attempt-01",
          "transcript.jsonl",
        ),
        "utf8",
      ),
    ).toBe('{"arm":"komodo"}\n');
    expect(
      await readFile(
        join(
          artifacts.directory,
          "tuatara",
          "attempt-01",
          "transcript.jsonl",
        ),
        "utf8",
      ),
    ).toBe('{"arm":"tuatara"}\n');

    const manifest = JSON.parse(
      await readFile(join(artifacts.directory, "manifest.json"), "utf8"),
    );
    expect(manifest.status).toBe("completed_with_failures");
    expect(manifest.arms.komodo.final.transcriptStatus).toBe("copied");
    expect(manifest.arms.tuatara.final.transcriptStatus).toBe("copied");
  });

  it("finds a container arm's transcript under its own codex home", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);

    // Run-wide CODEX_HOME (the host home) is empty — a containerized arm never
    // writes here. Its transcript only exists under the per-arm home that
    // arm-run.sh mounts into the container.
    const hostHome = join(root, "host-codex");
    await mkdir(join(hostHome, "sessions"), { recursive: true });
    const armHome = join(root, "arm-codex");
    const armSessions = join(armHome, "sessions", "2026", "07", "23");
    await mkdir(armSessions, { recursive: true });

    const config: HarnessConfig = {
      ticket: "ENG-9",
      arms: [
        {
          name: "komodo",
          repo: "/tmp/komodo",
          container: "vivarium-komodo",
          codexHome: armHome,
        },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: hostHome,
      containerImage: "vivarium-arm",
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      land: false,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    const artifacts = await RunArtifacts.create(config, "exact prompt");
    const threadId = "komodo-thread";
    await writeFile(
      join(armSessions, `rollout-2026-07-23-${threadId}.jsonl`),
      '{"arm":"komodo"}\n',
    );
    const artifactDir = await artifacts.startAttempt(
      config.arms[0],
      { prompt: "exact prompt", cwd: "/workspace" },
      "2026-07-23T00:00:00.000Z",
      1,
    );
    const persisted = await artifacts.finishArm(
      {
        arm: "komodo",
        repo: "/tmp/komodo",
        attempt: 1,
        maxAttempts: 1,
        status: "succeeded",
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:01:00.000Z",
        durationMs: 60_000,
        threadId,
        output: "komodo output",
        artifactDir,
      },
      { structuredContent: { threadId, content: "komodo output" } },
    );

    expect(persisted.transcriptStatus).toBe("copied");
    expect(await readFile(join(artifactDir, "transcript.jsonl"), "utf8")).toBe(
      '{"arm":"komodo"}\n',
    );
  });

  it("writes the run's own configuration without either arm's token", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);

    const config: HarnessConfig = {
      ticket: "1.2 Storage",
      arms: [
        {
          name: "komodo",
          repo: "/tmp/komodo",
          ghToken: "ghp_komodo_live_token",
        },
        {
          name: "tuatara",
          repo: "/tmp/tuatara",
          reviewer: "greptile-apps[bot]",
          ghToken: "ghp_tuatara_live_token",
        },
      ],
      sandbox: "danger-full-access",
      resultsDir: join(root, "results"),
      codexHome: join(root, "codex"),
      containerImage: "vivarium-arm",
      maxAttempts: 3,
      idleTimeoutMs: 600_000,
      land: true,
      reviewTimeoutMs: 900_000,
      reviewPollMs: 30_000,
      reviewDebounceMs: 0,
      reviewRounds: 2,
      subticket: { number: "1.2", milestone: 1, title: "Storage" },
      logDir: join(root, "results", "live-x"),
    };
    const artifacts = await RunArtifacts.create(config, "prompt", {
      commit: "deadbee",
      dirty: true,
    });

    const written = await readFile(
      join(artifacts.directory, "config.json"),
      "utf8",
    );
    // The whole point: this file is written into the directory the experiment
    // intends to publish.
    expect(written).not.toContain("ghp_komodo_live_token");
    expect(written).not.toContain("ghp_tuatara_live_token");

    const record = JSON.parse(written);
    expect(record.arms.map((arm: { ghTokenPresent: boolean }) => arm.ghTokenPresent)).toEqual([
      true,
      true,
    ]);
    expect(record.arms[1].reviewer).toBe("greptile-apps[bot]");
    // The landing knobs a `timedOut: true` round has to be read against.
    expect(record.reviewRounds).toBe(2);
    expect(record.reviewTimeoutMs).toBe(900_000);
    expect(record.reviewPollMs).toBe(30_000);
    expect(record.land).toBe(true);
    // Which rung, which harness, which logs.
    expect(record.subticket.number).toBe("1.2");
    expect(record.harness).toEqual({ commit: "deadbee", dirty: true });
    expect(record.logDir).toContain("live-x");

    const manifest = JSON.parse(
      await readFile(join(artifacts.directory, "manifest.json"), "utf8"),
    );
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.config.harness.commit).toBe("deadbee");
    expect(JSON.stringify(manifest)).not.toContain("ghp_");
  });

  it("snapshots the ladder, and survives one it cannot read", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const ladderPath = join(root, "LADDER.md");
    await writeFile(ladderPath, "# Ladder\n\n## Milestone 3: Issues\n", "utf8");
    const base: HarnessConfig = {
      ticket: "3.1",
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: join(root, "codex"),
      containerImage: "vivarium-arm",
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      land: false,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };

    const withLadder = await RunArtifacts.create(
      { ...base, ladderPath },
      "prompt",
    );
    expect(
      await readFile(join(withLadder.directory, "ladder.md"), "utf8"),
    ).toContain("## Milestone 3: Issues");

    // An unreadable ladder is a missing snapshot, never a failed run — but
    // config.json still names the path it tried, so the gap is legible rather
    // than looking like an ad-hoc ticket run.
    const missing = await RunArtifacts.create(
      { ...base, ladderPath: join(root, "gone", "LADDER.md") },
      "prompt",
    );
    const record = JSON.parse(
      await readFile(join(missing.directory, "config.json"), "utf8"),
    );
    expect(record.ladderPath).toContain("LADDER.md");
    await expect(
      readFile(join(missing.directory, "ladder.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("records what an attempt spent, including one that failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const config: HarnessConfig = {
      ticket: "ENG-1",
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: join(root, "codex"),
      containerImage: "vivarium-arm",
      maxAttempts: 2,
      idleTimeoutMs: 600_000,
      land: false,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    const artifacts = await RunArtifacts.create(config, "prompt");

    // Attempt 1 is killed by the watchdog on its own thread; attempt 2 restarts
    // fresh and succeeds. Two threads, so the two totals really do add.
    const attempts = [
      { threadId: "thread-a", usage: { totalTokens: 12_000 }, status: "failed" as const },
      { threadId: "thread-b", usage: { totalTokens: 30_000 }, status: "succeeded" as const },
    ];
    for (const [index, attempt] of attempts.entries()) {
      const artifactDir = await artifacts.startAttempt(
        config.arms[0],
        { prompt: "p" },
        "2026-07-21T00:00:00.000Z",
        index + 1,
      );
      await artifacts.finishArm({
        arm: "komodo",
        repo: "/tmp/komodo",
        attempt: index + 1,
        maxAttempts: 2,
        status: attempt.status,
        startedAt: "2026-07-21T00:00:00.000Z",
        completedAt: "2026-07-21T00:01:00.000Z",
        durationMs: 60_000,
        threadId: attempt.threadId,
        usage: attempt.usage,
        artifactDir,
      });
    }

    const status = JSON.parse(
      await readFile(
        join(artifacts.directory, "komodo", "attempt-01", "status.json"),
        "utf8",
      ),
    );
    expect(status.usage.totalTokens).toBe(12_000);

    const manifest = JSON.parse(
      await readFile(join(artifacts.directory, "manifest.json"), "utf8"),
    );
    expect(manifest.arms.komodo.tokens).toBe(42_000);
  });
});

describe("redactArmConfig", () => {
  it("drops the token but keeps whether there was one", () => {
    expect(
      redactArmConfig({ name: "komodo", repo: "/r", ghToken: "ghp_x" }),
    ).toEqual({ name: "komodo", repo: "/r", ghTokenPresent: true });
    expect(redactArmConfig({ name: "komodo", repo: "/r" })).toEqual({
      name: "komodo",
      repo: "/r",
      ghTokenPresent: false,
    });
  });
});

describe("totalTokens", () => {
  it("takes the last snapshot per thread, never the sum within one", () => {
    // Codex reports the running total for the thread, so three turns on one
    // thread are one number — summing them would roughly double the answer.
    expect(
      totalTokens([
        { threadId: "t1", usage: { totalTokens: 1_000 } },
        { threadId: "t1", usage: { totalTokens: 4_000 } },
        { threadId: "t1", usage: { totalTokens: 9_000 } },
      ]),
    ).toBe(9_000);
  });

  it("adds threads together — a fresh-thread retry really did spend twice", () => {
    expect(
      totalTokens([
        { threadId: "t1", usage: { totalTokens: 5_000 } },
        { threadId: "t2", usage: { totalTokens: 7_000 } },
      ]),
    ).toBe(12_000);
  });

  it("counts a session with no thread id on its own", () => {
    // It never got far enough to report one, so it cannot be shown to share a
    // thread with anything.
    expect(
      totalTokens([
        { usage: { totalTokens: 100 } },
        { usage: { totalTokens: 200 } },
      ]),
    ).toBe(300);
  });

  it("is undefined when nothing reported usage, rather than zero", () => {
    // Zero would read as "this arm spent nothing", which is a claim; undefined
    // is the truth.
    expect(totalTokens([{ threadId: "t1" }])).toBeUndefined();
    expect(totalTokens([])).toBeUndefined();
  });
});
