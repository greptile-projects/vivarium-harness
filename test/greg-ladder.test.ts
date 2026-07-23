import { afterEach, describe, expect, it } from "bun:test";
import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendRunOutcome,
  appendRungPlan,
  ensureLadderLinks,
  initLadder,
  readLadder,
} from "../src/greg/ladder.js";
import type { HarnessRunResult } from "../src/harness.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "greg-ladder-"));
  temporaryDirectories.push(root);
  return root;
}

describe("ladder file", () => {
  it("initializes once with the North Star and leaves history intact", async () => {
    const root = await scratch();
    const ladderPath = join(root, "LADDER.md");

    await initLadder(ladderPath, "Build a GitHub clone");
    await appendRungPlan(ladderPath, {
      index: 1,
      title: "Bootstrap the app",
      ticket: "ENG-1",
      summary: "scaffold",
      description: "Create the project skeleton.",
    });

    // A second init must not wipe the appended rung.
    await initLadder(ladderPath, "A different goal");
    const ladder = await readLadder(ladderPath);

    expect(ladder).toContain("## North Star");
    expect(ladder).toContain("Build a GitHub clone");
    expect(ladder).not.toContain("A different goal");
    expect(ladder).toContain("## Rung 1: Bootstrap the app");
    expect(ladder).toContain("- **Linear:** ENG-1");
    expect(ladder).toContain("Create the project skeleton.");
  });

  it("renders a missing ticket as an em dash", async () => {
    const root = await scratch();
    const ladderPath = join(root, "LADDER.md");
    await initLadder(ladderPath, "goal");
    await appendRungPlan(ladderPath, {
      index: 2,
      title: "No ticket rung",
      description: "body",
    });

    expect(await readLadder(ladderPath)).toContain("- **Linear:** —");
  });

  it("records harness run outcomes with failed arms", async () => {
    const root = await scratch();
    const ladderPath = join(root, "LADDER.md");
    await initLadder(ladderPath, "goal");

    const run = {
      runId: "run-42",
      artifactDir: "/results/run-42",
      status: "completed_with_failures",
      results: [
        { arm: "control", status: "succeeded" },
        { arm: "greptile", status: "failed" },
      ],
    } as unknown as HarnessRunResult;
    await appendRunOutcome(ladderPath, run);

    const ladder = await readLadder(ladderPath);
    expect(ladder).toContain("**Run `run-42`:** completed_with_failures");
    expect(ladder).toContain("failed arms: greptile");
    expect(ladder).toContain("/results/run-42");
  });

  it("reads a missing ladder as empty", async () => {
    const root = await scratch();
    expect(await readLadder(join(root, "nope.md"))).toBe("");
  });
});

describe("ladder links", () => {
  it("creates a symlink into each repo and is idempotent", async () => {
    const root = await scratch();
    const ladderPath = join(root, "LADDER.md");
    await initLadder(ladderPath, "goal");
    const repoA = await scratch();
    const repoB = await scratch();

    const first = await ensureLadderLinks(ladderPath, [repoA, repoB]);
    expect(first.map((result) => result.status)).toEqual(["created", "created"]);
    expect(resolve(repoA, await readlink(join(repoA, "LADDER.md")))).toBe(
      resolve(ladderPath),
    );

    const second = await ensureLadderLinks(ladderPath, [repoA, repoB]);
    expect(second.map((result) => result.status)).toEqual(["exists", "exists"]);
  });

  it("refuses to clobber a pre-existing real file", async () => {
    const root = await scratch();
    const ladderPath = join(root, "LADDER.md");
    await initLadder(ladderPath, "goal");
    const repo = await scratch();
    await writeFile(join(repo, "LADDER.md"), "a real mounted file", "utf8");

    const [result] = await ensureLadderLinks(ladderPath, [repo]);
    expect(result.status).toBe("skipped-nonlink");
    // The real file is untouched, not a symlink.
    expect((await lstat(join(repo, "LADDER.md"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(repo, "LADDER.md"), "utf8")).toBe(
      "a real mounted file",
    );
  });
});
