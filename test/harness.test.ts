import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifacts } from "../src/harness/artifacts.js";
import type { HarnessConfig } from "../src/harness/config.js";
import { runArm, sleep, type AttemptRunner } from "../src/harness/harness.js";
import type { StreamParams, StreamResult } from "../src/harness/session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeConfig(): Promise<{
  config: HarnessConfig;
  artifacts: RunArtifacts;
}> {
  const root = await mkdtemp(join(tmpdir(), "vivarium-retry-"));
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
    destination: {
      directory: join(root, "results", "rung-01", "run", "1.1"),
      subticket: { number: "1.1", milestone: 1, title: "Retry" },
    },
  };
  const artifacts = await RunArtifacts.create(config, "original prompt");
  return { config, artifacts };
}

describe("autonomous arm retries", () => {
  it("continues the same thread and preserves every attempt", async () => {
    const { config, artifacts } = await makeConfig();
    const calls: StreamParams[] = [];
    const results: StreamResult[] = [
      {
        isError: true,
        output: "first attempt failed",
        threadId: "retry-thread",
        timedOut: false,
      },
      {
        isError: false,
        output: "recovered",
        threadId: "retry-thread",
        timedOut: false,
      },
    ];
    const runner: AttemptRunner = async (params) => {
      calls.push(params);
      return results.shift() as StreamResult;
    };

    const result = await runArm(
      config.arms[0],
      "original prompt",
      config,
      artifacts,
      runner,
    );

    expect(result.status).toBe("succeeded");
    expect(result.attempt).toBe(2);
    // First attempt starts fresh; the retry continues the same thread.
    expect(calls[0].threadId).toBeUndefined();
    expect(calls[1].threadId).toBe("retry-thread");
    expect(calls[0].fastMode).toBe(true);
    expect(calls[1].fastMode).toBe(true);
    expect(calls[1].prompt).toContain("first attempt failed");
    expect(
      await readFile(
        join(artifacts.directory, "komodo", "attempt-01", "error.txt"),
        "utf8",
      ),
    ).toContain("first attempt failed");
    expect(
      await readFile(
        join(artifacts.directory, "komodo", "attempt-02", "output.txt"),
        "utf8",
      ),
    ).toBe("recovered\n");
  });

  it("records a watchdog abort as a failed attempt and retries", async () => {
    const { config, artifacts } = await makeConfig();
    const calls: StreamParams[] = [];
    let call = 0;
    const runner: AttemptRunner = async (params) => {
      calls.push(params);
      call += 1;
      if (call === 1) {
        throw new Error("watchdog aborted komodo: no activity for 600000ms");
      }
      return {
        isError: false,
        output: "recovered after watchdog",
        threadId: "retry-thread",
        timedOut: false,
      };
    };

    const result = await runArm(
      config.arms[0],
      "original prompt",
      config,
      artifacts,
      runner,
    );

    expect(result.status).toBe("succeeded");
    expect(result.attempt).toBe(2);
    // A thrown watchdog abort produced no thread id, so the retry restarts
    // fresh rather than continuing a thread that never formed.
    expect(calls[0].threadId).toBeUndefined();
    expect(calls[1].threadId).toBeUndefined();
    expect(
      await readFile(
        join(artifacts.directory, "komodo", "attempt-01", "error.txt"),
        "utf8",
      ),
    ).toContain("watchdog aborted");
  });
});

describe("aborting an arm", () => {
  // The point of quitting the view is that the run stops. Aborting only the
  // attempt in flight would hand straight back to the retry loop, which would
  // start another one — so the loop has to check the signal between attempts.
  it("does not spend a retry once the run has been aborted", async () => {
    const { config, artifacts } = await makeConfig();
    const controller = new AbortController();
    const calls: StreamParams[] = [];
    const runner: AttemptRunner = async (params) => {
      calls.push(params);
      // What the human quitting the view does mid-attempt.
      controller.abort(new Error("the live view was quit"));
      throw new Error("komodo aborted: the live view was quit");
    };

    const result = await runArm(
      config.arms[0],
      "original prompt",
      config,
      artifacts,
      runner,
      () => {},
      controller.signal,
    );

    expect(config.maxAttempts).toBe(3);
    expect(calls).toHaveLength(1); // not 3
    expect(result.status).toBe("failed");
    expect(result.attempt).toBe(1);
    expect(result.error).toContain("the live view was quit");
  });

  it("hands the signal to the session so it can tear the process down", async () => {
    const { config, artifacts } = await makeConfig();
    const controller = new AbortController();
    const calls: StreamParams[] = [];
    const runner: AttemptRunner = async (params) => {
      calls.push(params);
      return {
        isError: false,
        output: "done",
        threadId: "retry-thread",
        timedOut: false,
      };
    };

    await runArm(
      config.arms[0],
      "original prompt",
      config,
      artifacts,
      runner,
      () => {},
      controller.signal,
    );

    expect(calls[0].signal).toBe(controller.signal);
  });

  it("still retries normally when no signal is passed", async () => {
    const { config, artifacts } = await makeConfig();
    let call = 0;
    const runner: AttemptRunner = async () => {
      call += 1;
      if (call === 1) throw new Error("transient");
      return {
        isError: false,
        output: "recovered",
        threadId: "retry-thread",
        timedOut: false,
      };
    };

    const result = await runArm(
      config.arms[0],
      "original prompt",
      config,
      artifacts,
      runner,
    );

    expect(result.status).toBe("succeeded");
    expect(result.attempt).toBe(2);
  });
});

// The production wait behind every landing-phase poll. An abort has to clear
// the pending setTimeout, not just resolve past it — a timer left running
// keeps the Node process alive for the rest of a poll interval after landing
// and teardown have already returned.
describe("sleep", () => {
  it("resolves on schedule without a signal", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("resolves immediately on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("quit"));
    const start = Date.now();
    await sleep(60_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("cuts a pending sleep short when the signal fires", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const sleeping = sleep(60_000, controller.signal);
    setTimeout(() => controller.abort(new Error("quit")), 20);
    await sleeping;
    // Resolved on the abort, tens of seconds before the timer — which the
    // abort handler also cleared, or this suite's process would linger.
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
