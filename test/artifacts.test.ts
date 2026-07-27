import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
});
