import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifacts } from "../src/artifacts.js";
import type { HarnessConfig } from "../src/config.js";
import { runArm } from "../src/harness.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("autonomous arm retries", () => {
  it("continues the same thread and preserves every attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "terrarium-retry-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, "codex");
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-retry-thread.jsonl"),
      '{"thread":"retry-thread"}\n',
    );

    const config: HarnessConfig = {
      ticket: "ENG-123",
      arms: [
        { name: "control", repo: "/tmp/control" },
        { name: "greptile", repo: "/tmp/greptile" },
      ],
      sandbox: "workspace-write",
      resultsDir: join(root, "results"),
      codexHome,
      maxAttempts: 3,
    };
    const artifacts = await RunArtifacts.create(config, "original prompt");
    const calls: Array<{ toolName: string; request: Record<string, unknown> }> =
      [];
    const responses = [
      {
        isError: true,
        structuredContent: {
          threadId: "retry-thread",
          content: "first attempt failed",
        },
        content: [{ type: "text", text: "first attempt failed" }],
      },
      {
        isError: false,
        structuredContent: {
          threadId: "retry-thread",
          content: "recovered",
        },
        content: [{ type: "text", text: "recovered" }],
      },
    ];
    const server = {
      async callToolResult(
        toolName: string,
        request: Record<string, unknown>,
      ) {
        calls.push({ toolName, request });
        return responses.shift() as never;
      },
    };

    const result = await runArm(
      server,
      config.arms[0],
      "original prompt",
      config,
      artifacts,
    );

    expect(result.status).toBe("succeeded");
    expect(result.attempt).toBe(2);
    expect(calls.map((call) => call.toolName)).toEqual([
      "codex",
      "codex-reply",
    ]);
    expect(calls[1].request.threadId).toBe("retry-thread");
    expect(calls[1].request.prompt).toContain("first attempt failed");
    expect(
      await readFile(
        join(artifacts.directory, "control", "attempt-01", "error.txt"),
        "utf8",
      ),
    ).toContain("first attempt failed");
    expect(
      await readFile(
        join(artifacts.directory, "control", "attempt-02", "output.txt"),
        "utf8",
      ),
    ).toBe("recovered\n");
  });
});
