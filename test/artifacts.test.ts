import { afterEach, describe, expect, it } from "bun:test";
import {
  copyFile,
  mkdtemp,
  mkdir,
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
      arms: [
        { name: "komodo", repo: "/tmp/komodo" },
        { name: "tuatara", repo: "/tmp/tuatara" },
      ],
      sandbox: "workspace-write",
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

  it("accepts a transcript copied out of an ephemeral container", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-artifacts-"));
    temporaryDirectories.push(root);

    const hostHome = join(root, "host-codex");
    await mkdir(join(hostHome, "sessions"), { recursive: true });
    const containerTranscript = join(root, "container-transcript.jsonl");
    await writeFile(containerTranscript, '{"arm":"komodo"}\n');

    const config: HarnessConfig = {
      ticket: "ENG-9",
      arms: [
        {
          name: "komodo",
          repo: "https://github.com/org/komodo.git",
          container: "vivarium-komodo",
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
