import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachLive, type LogTargets } from "../src/view/attach.js";
import {
  armLogPath,
  climbLogPath,
  plannerLogPath,
} from "../src/harness/state.js";
import { LiveStore } from "../src/view/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function resultsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "attach-"));
  temporaryDirectories.push(root);
  return root;
}

// The targets a climb supplies while it is building a subticket: each arm's
// feed into that subticket's run directory, climb lines into the one climb
// log. Mirrors the wiring in src/climb.ts.
function buildingIn(results: string, runDirectory: string): LogTargets {
  return {
    arm: (arm) => armLogPath(runDirectory, arm),
    climb: () => climbLogPath(results),
  };
}

describe("attachLive tee", () => {
  it("labels each line with its arm, in that arm's own file", async () => {
    const results = await resultsDir();
    const run = join(results, "rung-01", "run", "1.1");

    const store = new LiveStore();
    store.register("tuatara");
    store.register("komodo");
    const sinks = attachLive(store, {
      useTui: true,
      logs: buildingIn(results, run),
    });

    sinks.onEvent("tuatara", { type: "task_started" });
    await sinks.flush();

    // The artifact is a pair of independent builds: one arm's events must not
    // land in the other arm's log, or reading a three-hour run means grepping
    // the other arm out of every line first.
    const log = await readFile(armLogPath(run, "tuatara"), "utf8");
    expect(log).toContain("  tuatara ");
    const other = await readFile(armLogPath(run, "komodo"), "utf8").catch(
      () => "",
    );
    expect(other).not.toContain("tuatara");
  });

  it("logs long agent messages in full as continuation lines", async () => {
    const results = await resultsDir();
    const run = join(results, "rung-01", "run", "1.1");

    const store = new LiveStore();
    store.register("greg");
    const sinks = attachLive(store, {
      useTui: true,
      logs: buildingIn(results, run),
    });

    const long =
      "Milestone 7 will add automated change validation: first a commit-check API, " +
      "then surfacing on pull requests, then enforcement on protected branches.\nSecond line.";
    sinks.onEvent("greg", { type: "agent_message", message: long });
    sinks.onEvent("greg", { type: "agent_message", message: "short answer" });
    await sinks.flush();

    const log = await readFile(armLogPath(run, "greg"), "utf8");
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
    const results = await resultsDir();
    const run = join(results, "rung-01", "run", "1.1");

    const store = new LiveStore();
    store.register("tuatara");
    store.register("komodo");
    const sinks = attachLive(store, {
      useTui: true,
      logs: buildingIn(results, run),
    });

    sinks.onEvent("tuatara", { type: "agent_message", message: "tuatara says" });
    sinks.onEvent("komodo", { type: "agent_message", message: "komodo says" });
    sinks.note("milestone 1 planned");
    await sinks.flush();

    const tuatara = await readFile(armLogPath(run, "tuatara"), "utf8");
    const komodo = await readFile(armLogPath(run, "komodo"), "utf8");
    const climb = await readFile(climbLogPath(results), "utf8");

    expect(tuatara).toContain("tuatara says");
    expect(tuatara).not.toContain("komodo says");
    expect(komodo).toContain("komodo says");
    expect(komodo).not.toContain("tuatara says");
    // Climb-level lines belong to neither arm.
    expect(climb).toContain("milestone 1 planned");
    expect(tuatara).not.toContain("milestone 1 planned");
  });

  it("tees landing progress into the arm's feed and its activity trail", async () => {
    const results = await resultsDir();
    const run = join(results, "rung-01", "run", "1.1");

    const store = new LiveStore();
    store.register("tuatara");
    const sinks = attachLive(store, {
      useTui: true,
      logs: buildingIn(results, run),
    });

    sinks.onArmNote("tuatara", "waiting for greptile-apps[bot] on #7…");
    await sinks.flush();

    const log = await readFile(armLogPath(run, "tuatara"), "utf8");
    expect(log).toContain("landing");
    expect(log).toContain("waiting for greptile-apps[bot] on #7…");
    expect(store.snapshot()[0]?.activity).toContain("waiting for");
  });
});

// The point of the whole change: a feed is filed by what it describes, not by
// when the process that wrote it happened to start. The target is asked per
// line, so re-pointing it mid-run sends later lines somewhere else while the
// earlier ones stay where they belonged.
describe("attachLive destinations", () => {
  it("follows the climb from a rung's plan into that rung's subticket", async () => {
    const results = await resultsDir();
    const run = join(results, "rung-03", "run", "3.1");

    let target: LogTargets["arm"] = () => plannerLogPath(results, 3);
    const store = new LiveStore();
    store.register("greg");
    store.register("tuatara");
    const sinks = attachLive(store, {
      useTui: true,
      logs: { arm: (arm) => target?.(arm), climb: () => climbLogPath(results) },
    });

    sinks.onEvent("greg", { type: "agent_message", message: "planned rung 3" });
    // …the climb moves on to building the first subticket of that rung.
    target = (arm) => armLogPath(run, arm);
    sinks.onEvent("tuatara", { type: "agent_message", message: "built 3.1" });
    await sinks.flush();

    const plan = await readFile(plannerLogPath(results, 3), "utf8");
    const arm = await readFile(armLogPath(run, "tuatara"), "utf8");
    expect(plan).toContain("planned rung 3");
    expect(plan).not.toContain("built 3.1");
    expect(arm).toContain("built 3.1");
  });

  it("discards arm lines while no destination exists yet", async () => {
    const results = await resultsDir();

    const store = new LiveStore();
    store.register("tuatara");
    // No `arm` target — the state before the first phase begins. Nothing is
    // written and, crucially, no directory is created for it either.
    const sinks = attachLive(store, {
      useTui: true,
      logs: { climb: () => climbLogPath(results) },
    });

    sinks.onEvent("tuatara", { type: "agent_message", message: "orphan" });
    sinks.note("climb starting");
    await sinks.flush();

    const climb = await readFile(climbLogPath(results), "utf8");
    expect(climb).toContain("climb starting");
    // The store still saw it — only the file write was skipped.
    expect(store.snapshot()[0]?.answer).toContain("orphan");
  });
});
