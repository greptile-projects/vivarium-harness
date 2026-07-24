import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachLive } from "../src/live/attach.js";
import { LiveStore } from "../src/live/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("attachLive tee", () => {
  it("uses experiment names in the human-readable feed", async () => {
    const root = await mkdtemp(join(tmpdir(), "attach-"));
    temporaryDirectories.push(root);
    const logPath = join(root, "progress.log");

    const store = new LiveStore();
    store.register("greptile");
    const sinks = attachLive(store, { useTui: true, logPath });

    sinks.onEvent("greptile", { type: "task_started" });
    await sinks.flush();

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("  tuatara ");
    expect(log).not.toContain("  greptile ");
  });

  it("logs long agent messages in full as continuation lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "attach-"));
    temporaryDirectories.push(root);
    const logPath = join(root, "progress.log");

    const store = new LiveStore();
    store.register("greg");
    const sinks = attachLive(store, { useTui: true, logPath });

    const long =
      "Milestone 7 will add automated change validation: first a commit-check API, " +
      "then surfacing on pull requests, then enforcement on protected branches.\nSecond line.";
    sinks.onEvent("greg", { type: "agent_message", message: long });
    sinks.onEvent("greg", { type: "agent_message", message: "short answer" });
    await sinks.flush();

    const log = await readFile(logPath, "utf8");
    // Summary line still present and truncated…
    expect(log).toContain("answer: Milestone 7 will add automated change va");
    // …with the complete text (all lines) indented below it.
    expect(log).toContain("│ Milestone 7 will add automated change validation");
    expect(log).toContain("then enforcement on protected branches.");
    expect(log).toContain("│ Second line.");
    // Short answers already fit the summary — no duplicate continuation.
    expect(log).not.toContain("│ short answer");
  });
});
