import { afterEach, describe, expect, it } from "bun:test";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifacts } from "../src/harness/artifacts.js";
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
      destination: { directory: join(root, "results", "rung-01", "run", "1.1") },
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      fastMode: true,
      resultsDir: join(root, "results"),
      codexHome,
      maxAttempts: 3,
      idleTimeoutMs: 600_000,
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
      await readFile(join(artifacts.directory, "prompt.md"), "utf8"),
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

    const record = JSON.parse(
      await readFile(join(artifacts.directory, "run.json"), "utf8"),
    );
    expect(record.schemaVersion).toBe(4);
    expect(record.status).toBe("completed_with_failures");
    expect(record.arms.komodo.final.transcriptStatus).toBe("copied");
    expect(record.arms.tuatara.final.transcriptStatus).toBe("copied");
    // The redacted config travels inside the one record — no config.json.
    expect(record.config.arms[0].name).toBe("komodo");
    expect(record.config.fastMode).toBe(true);
    // Filed exactly where the destination says, nowhere else.
    expect(artifacts.directory).toBe(
      join(root, "results", "rung-01", "run", "1.1"),
    );
    await artifacts.release();
  });

  it("refuses a run with no destination — a record nothing can find again", async () => {
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
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    await expect(RunArtifacts.create(config, "prompt")).rejects.toThrow(
      /no destination/,
    );
  });

  it("builds into its destination and archives what a re-run replaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const config: HarnessConfig = {
      ticket: "do 1.2",
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: join(root, "codex"),
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
      destination: {
        directory: join(root, "results", "rung-01", "run", "1.2"),
        subticket: { number: "1.2", milestone: 1, title: "Storage" },
      },
    };

    const first = await RunArtifacts.create(config, "first prompt");
    expect(first.directory).toBe(join(root, "results", "rung-01", "run", "1.2"));
    await first.fail(new Error("arm exhausted its retries"));
    await first.release();

    // The re-run of the same box builds into the same directory; the failed
    // run's record moves under superseded/ instead of being overwritten.
    const second = await RunArtifacts.create(config, "second prompt");
    expect(second.directory).toBe(first.directory);

    const record = JSON.parse(
      await readFile(join(second.directory, "run.json"), "utf8"),
    );
    expect(record.runId).toBe(second.runId);
    expect(record.subticket).toEqual({
      number: "1.2",
      milestone: 1,
      title: "Storage",
    });

    const [archive] = await readdir(join(second.directory, "superseded"));
    const archived = JSON.parse(
      await readFile(
        join(second.directory, "superseded", archive, "run.json"),
        "utf8",
      ),
    );
    expect(archived.runId).toBe(first.runId);
    expect(archived.status).toBe("failed");
    expect(
      await readFile(
        join(second.directory, "superseded", archive, "prompt.md"),
        "utf8",
      ),
    ).toBe("first prompt\n");
    await second.release();
  });

  it("refuses a second writer while a destination is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const config: HarnessConfig = {
      ticket: "do 1.2",
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: join(root, "codex"),
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
      destination: {
        directory: join(root, "results", "rung-01", "run", "1.2"),
        subticket: { number: "1.2", milestone: 1, title: "Storage" },
      },
    };

    const active = await RunArtifacts.create(config, "first prompt");
    await expect(RunArtifacts.create(config, "second prompt")).rejects.toThrow(
      /already active/,
    );
    expect(await readFile(join(active.directory, "prompt.md"), "utf8")).toBe(
      "first prompt\n",
    );
    await active.release();
  });

  it("accepts a transcript copied out of an ephemeral microVM", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);

    const hostHome = join(root, "host-codex");
    await mkdir(join(hostHome, "sessions"), { recursive: true });
    const containerTranscript = join(root, "container-transcript.jsonl");
    await writeFile(containerTranscript, '{"arm":"komodo"}\n');

    const config: HarnessConfig = {
      ticket: "ENG-9",
      destination: { directory: join(root, "results", "rung-01", "run", "1.1") },
      arms: [
        {
          name: "komodo",
          repo: "https://github.com/org/komodo.git",
          sandboxName: "vivarium-komodo",
        },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: hostHome,
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    const artifacts = await RunArtifacts.create(config, "exact prompt");
    const threadId = "komodo-thread";
    const artifactDir = await artifacts.startAttempt(
      config.arms[0],
      { prompt: "exact prompt", cwd: "/workspace" },
      "2026-07-23T00:00:00.000Z",
      1,
    );
    const persisted = await artifacts.finishArm(
      {
        arm: "komodo",
        repo: "https://github.com/org/komodo.git",
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
      async (_arm, capturedThreadId, destination) => {
        expect(capturedThreadId).toBe(threadId);
        await copyFile(containerTranscript, destination);
        return `vivarium-komodo:/codex/sessions/${threadId}.jsonl`;
      },
    );

    expect(persisted.transcriptStatus).toBe("copied");
    expect(await readFile(join(artifactDir, "transcript.jsonl"), "utf8")).toBe(
      '{"arm":"komodo"}\n',
    );
  });

  it("records transcript export failure without failing successful work", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const config: HarnessConfig = {
      ticket: "ENG-10",
      destination: { directory: join(root, "results", "rung-01", "run", "1.1") },
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: join(root, "codex"),
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    const artifacts = await RunArtifacts.create(config, "exact prompt");
    const artifactDir = await artifacts.startAttempt(
      config.arms[0],
      { prompt: "exact prompt", cwd: "/workspace" },
      "2026-07-27T00:00:00.000Z",
      1,
    );

    const persisted = await artifacts.finishArm(
      {
        arm: "komodo",
        repo: "/tmp/komodo",
        attempt: 1,
        maxAttempts: 1,
        status: "succeeded",
        startedAt: "2026-07-27T00:00:00.000Z",
        completedAt: "2026-07-27T00:01:00.000Z",
        durationMs: 60_000,
        threadId: "thread",
        output: "done",
        artifactDir,
      },
      undefined,
      async () => {
        throw new Error("docker cp lost the container");
      },
    );

    expect(persisted.status).toBe("succeeded");
    expect(persisted.transcriptStatus).toBe("copy-failed");
    expect(persisted.transcriptError).toBe("docker cp lost the container");
    const status = JSON.parse(
      await readFile(join(artifactDir, "status.json"), "utf8"),
    );
    expect(status.status).toBe("succeeded");
    expect(status.transcriptStatus).toBe("copy-failed");
  });

  it("marks a failed landing-time refresh as a partial transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const config: HarnessConfig = {
      ticket: "ENG-11",
      destination: { directory: join(root, "results", "rung-01", "run", "1.1") },
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: join(root, "codex"),
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    const artifacts = await RunArtifacts.create(config, "exact prompt");
    const artifactDir = await artifacts.startAttempt(
      config.arms[0],
      { prompt: "exact prompt", cwd: "/workspace" },
      "2026-07-27T00:00:00.000Z",
      1,
    );
    const finished = await artifacts.finishArm(
      {
        arm: "komodo",
        repo: "/tmp/komodo",
        attempt: 1,
        maxAttempts: 1,
        status: "succeeded",
        startedAt: "2026-07-27T00:00:00.000Z",
        completedAt: "2026-07-27T00:01:00.000Z",
        durationMs: 60_000,
        threadId: "thread",
        output: "done",
        artifactDir,
      },
      undefined,
      async (_arm, _thread, destination) => {
        await writeFile(destination, '{"turn":"build"}\n');
        return "container:/codex/sessions/thread.jsonl";
      },
    );
    const landed = await artifacts.recordLanding(
      {
        arm: "komodo",
        status: "merged",
        startedAt: "2026-07-27T00:01:00.000Z",
        completedAt: "2026-07-27T00:02:00.000Z",
        reviewRounds: [],
        conversation: [],
        notes: [],
      },
      finished,
      async (_arm, _thread, destination) => {
        await writeFile(destination, '{"turn":"review","truncated":');
        throw new Error("container disappeared before refresh");
      },
    );

    expect(landed.status).toBe("succeeded");
    expect(landed.transcriptStatus).toBe("partial");
    expect(landed.transcriptError).toBe(
      "container disappeared before refresh",
    );
    expect(await readFile(join(artifactDir, "transcript.jsonl"), "utf8")).toBe(
      '{"turn":"build"}\n',
    );
  });

  // A review round's diff is raw text and lands as a file beside the attempts,
  // with run.json keeping only the pointer — inlining it would bloat every
  // rewrite of the record for the life of the run.
  it("moves each round's diff into rounds/ and leaves a pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const config: HarnessConfig = {
      ticket: "ENG-12",
      destination: { directory: join(root, "results", "rung-01", "run", "1.1") },
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome: join(root, "codex"),
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    const artifacts = await RunArtifacts.create(config, "prompt");
    const artifactDir = await artifacts.startAttempt(
      config.arms[1],
      { prompt: "prompt", cwd: "/workspace" },
      "2026-07-29T00:00:00.000Z",
      1,
    );
    const finished = await artifacts.finishArm({
      arm: "tuatara",
      repo: "/tmp/tuatara",
      attempt: 1,
      maxAttempts: 1,
      status: "succeeded",
      startedAt: "2026-07-29T00:00:00.000Z",
      completedAt: "2026-07-29T00:01:00.000Z",
      durationMs: 60_000,
      output: "done",
      artifactDir,
    });
    await artifacts.recordLanding(
      {
        arm: "tuatara",
        status: "merged",
        startedAt: "2026-07-29T00:01:00.000Z",
        completedAt: "2026-07-29T00:02:00.000Z",
        reviewRounds: [
          {
            round: 1,
            reviewer: "greptile-apps[bot]",
            waitedMs: 0,
            timedOut: false,
            found: [],
            reviewedSha: "aaa",
            respondedSha: "bbb",
            diff: "diff --git a/fix.ts b/fix.ts",
          },
        ],
        conversation: [],
        notes: [],
      },
      finished,
    );

    const record = JSON.parse(
      await readFile(join(artifacts.directory, "run.json"), "utf8"),
    );
    const [round] = record.arms.tuatara.landing.reviewRounds;
    expect(round.diff).toBeUndefined();
    expect(round.diffFile).toBe(
      join(artifacts.directory, "tuatara", "rounds", "round-01.diff"),
    );
    expect(await readFile(round.diffFile, "utf8")).toBe(
      "diff --git a/fix.ts b/fix.ts\n",
    );
  });

  // Codex can flush a session file after the session settles, so the copy at
  // finishArm can miss it — and the landing record is written long after,
  // when the file exists. Leaving the arm `not-found` forever would lose the
  // whole session record over a timing accident.
  it("recovers at landing time a transcript the first copy missed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, "codex");
    const sessions = join(codexHome, "sessions", "2026", "07", "27");
    await mkdir(sessions, { recursive: true });

    const config: HarnessConfig = {
      ticket: "ENG-7",
      destination: { directory: join(root, "results", "rung-01", "run", "1.1") },
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome,
      maxAttempts: 1,
      idleTimeoutMs: 600_000,
      reviewTimeoutMs: 1_000,
      reviewPollMs: 10,
      reviewDebounceMs: 0,
      reviewRounds: 2,
    };
    const artifacts = await RunArtifacts.create(config, "exact prompt");
    const threadId = "late-thread";
    const artifactDir = await artifacts.startAttempt(
      config.arms[0],
      { prompt: "exact prompt", cwd: "/tmp/komodo" },
      "2026-07-27T00:00:00.000Z",
      1,
    );
    // The session file does not exist yet when the arm finishes…
    const finished = await artifacts.finishArm({
      arm: "komodo",
      repo: "/tmp/komodo",
      attempt: 1,
      maxAttempts: 1,
      status: "succeeded",
      startedAt: "2026-07-27T00:00:00.000Z",
      completedAt: "2026-07-27T00:01:00.000Z",
      durationMs: 60_000,
      threadId,
      output: "komodo output",
      artifactDir,
    });
    expect(finished.transcriptStatus).toBe("not-found");

    // …and appears before the landing record is written.
    await writeFile(
      join(sessions, `rollout-2026-07-27-${threadId}.jsonl`),
      '{"arm":"komodo","late":true}\n',
    );
    const landed = await artifacts.recordLanding(
      {
        arm: "komodo",
        status: "merged",
        startedAt: "2026-07-27T00:01:00.000Z",
        completedAt: "2026-07-27T00:02:00.000Z",
        reviewRounds: [],
        conversation: [],
        notes: [],
      },
      finished,
    );

    expect(landed.transcriptStatus).toBe("copied");
    expect(await readFile(join(artifactDir, "transcript.jsonl"), "utf8")).toBe(
      '{"arm":"komodo","late":true}\n',
    );
  });
});
