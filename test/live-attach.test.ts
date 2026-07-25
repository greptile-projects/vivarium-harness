import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armLogPath,
  attachLive,
  ladderLogPath,
} from "../src/live/attach.js";
import { LiveStore } from "../src/live/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function liveDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "attach-"));
  temporaryDirectories.push(root);
  return root;
}

describe("attachLive tee", () => {
  it("uses experiment names in the human-readable feed", async () => {
    const logDir = await liveDir();

    const store = new LiveStore();
    store.register("greptile");
    const sinks = attachLive(store, { useTui: true, logDir });

    sinks.onEvent("greptile", { type: "task_started" });
    await sinks.flush();

    const log = await readFile(armLogPath(logDir, "greptile"), "utf8");
    expect(log).toContain("  tuatara ");
    expect(log).not.toContain("  greptile ");
  });

  it("logs long agent messages in full as continuation lines", async () => {
    const logDir = await liveDir();

    const store = new LiveStore();
    store.register("greg");
    const sinks = attachLive(store, { useTui: true, logDir });

    const long =
      "Milestone 7 will add automated change validation: first a commit-check API, " +
      "then surfacing on pull requests, then enforcement on protected branches.\nSecond line.";
    sinks.onEvent("greg", { type: "agent_message", message: long });
    sinks.onEvent("greg", { type: "agent_message", message: "short answer" });
    await sinks.flush();

    const log = await readFile(armLogPath(logDir, "greg"), "utf8");
    // Summary line still present and truncated…
    expect(log).toContain("answer: Milestone 7 will add automated change va");
    // …with the complete text (all lines) indented below it.
    expect(log).toContain("│ Milestone 7 will add automated change validation");
    expect(log).toContain("then enforcement on protected branches.");
    expect(log).toContain("│ Second line.");
    // Short answers already fit the summary — no duplicate continuation.
    expect(log).not.toContain("│ short answer");
  });

  it("keeps each arm's feed in its own file", async () => {
    const logDir = await liveDir();

    const store = new LiveStore();
    store.register("greptile");
    store.register("control");
    const sinks = attachLive(store, { useTui: true, logDir });

    sinks.onEvent("greptile", { type: "agent_message", message: "tuatara says" });
    sinks.onEvent("control", { type: "agent_message", message: "komodo says" });
    sinks.note("milestone 1 planned");
    await sinks.flush();

    const tuatara = await readFile(armLogPath(logDir, "greptile"), "utf8");
    const komodo = await readFile(armLogPath(logDir, "control"), "utf8");
    const ladder = await readFile(ladderLogPath(logDir), "utf8");

    expect(tuatara).toContain("tuatara says");
    expect(tuatara).not.toContain("komodo says");
    expect(komodo).toContain("komodo says");
    expect(komodo).not.toContain("tuatara says");
    // Climb-level lines belong to neither arm.
    expect(ladder).toContain("milestone 1 planned");
    expect(tuatara).not.toContain("milestone 1 planned");
  });

  it("tees landing progress into the arm's feed and its activity trail", async () => {
    const logDir = await liveDir();

    const store = new LiveStore();
    store.register("greptile");
    const sinks = attachLive(store, { useTui: true, logDir });

    sinks.onArmNote("greptile", "waiting for greptile-apps[bot] on #7…");
    await sinks.flush();

    const log = await readFile(armLogPath(logDir, "greptile"), "utf8");
    expect(log).toContain("landing");
    expect(log).toContain("waiting for greptile-apps[bot] on #7…");
    expect(store.snapshot()[0]?.activity).toContain("waiting for");
  });
});
