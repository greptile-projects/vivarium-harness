import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  completeSubticket,
  ensureLadderLinks,
  errorOutcome,
  highestMilestone,
  initLadder,
  nextPendingSubticket,
  parseSubtickets,
  readLadder,
  runOutcome,
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

// A ladder with one milestone and two subtickets, as Greg would have written it.
async function seededLadder(): Promise<string> {
  const ladderPath = join(await scratch(), "LADDER.md");
  await initLadder(ladderPath, "Build a GitHub clone");
  await appendFile(
    ladderPath,
    [
      "",
      "## Milestone 1: Repo hosting — ENG-10",
      "",
      "Host git repositories.",
      "",
      "### [ ] 1.1 Bootstrap the app — ENG-11",
      "",
      "Create the project skeleton.",
      "",
      "### [ ] 1.2 Add git storage",
      "",
      "Store bare repos on disk.",
      "",
    ].join("\n"),
    "utf8",
  );
  return ladderPath;
}

describe("ladder file", () => {
  it("initializes once with the North Star and leaves history intact", async () => {
    const ladderPath = await seededLadder();

    // A second init must not wipe the appended milestone.
    await initLadder(ladderPath, "A different goal");
    const ladder = await readLadder(ladderPath);

    expect(ladder).toContain("## North Star");
    expect(ladder).toContain("Build a GitHub clone");
    expect(ladder).not.toContain("A different goal");
    expect(ladder).toContain("## Milestone 1: Repo hosting");
    expect(ladder).toContain("### [ ] 1.1 Bootstrap the app");
    expect(ladder).toContain("Create the project skeleton.");
  });

  it("reads a missing ladder as empty", async () => {
    const root = await scratch();
    expect(await readLadder(join(root, "nope.md"))).toBe("");
  });
});

describe("parseSubtickets", () => {
  it("parses checkbox headings into number, title, ticket, and body", async () => {
    const ladder = await readLadder(await seededLadder());
    const subtickets = parseSubtickets(ladder);

    expect(subtickets).toHaveLength(2);
    expect(subtickets[0]).toMatchObject({
      number: "1.1",
      title: "Bootstrap the app",
      ticket: "ENG-11",
      done: false,
      milestone: 1,
      description: "Create the project skeleton.",
    });
    // A subticket with no trailing " — TICKET" leaves the ticket undefined and
    // keeps the whole heading text as the title.
    expect(subtickets[1]).toMatchObject({
      number: "1.2",
      title: "Add git storage",
      ticket: undefined,
      done: false,
      milestone: 1,
      description: "Store bare repos on disk.",
    });
  });

  it("keeps an em dash in the title when the trailer is not a ticket id", () => {
    const [subticket] = parseSubtickets(
      "## Milestone 1: M\n\n### [ ] 1.1 Add login — and logout\n\nbody\n",
    );
    expect(subticket.title).toBe("Add login — and logout");
    expect(subticket.ticket).toBeUndefined();
  });

  it("reflects the checkbox state in `done`", () => {
    const [subticket] = parseSubtickets(
      "## Milestone 1: M\n\n### [x] 1.1 Built\n\nbody\n",
    );
    expect(subticket.done).toBe(true);
  });
});

describe("highestMilestone", () => {
  it("returns the highest milestone number for resume numbering", async () => {
    expect(highestMilestone(await readLadder(await seededLadder()))).toBe(1);
    expect(highestMilestone("no milestones here")).toBe(0);
    expect(highestMilestone("## Milestone 2: Two\n## Milestone 5: Five")).toBe(
      5,
    );
  });
});

describe("nextPendingSubticket", () => {
  it("returns the first unchecked subticket, or null when all are built", async () => {
    const ladderPath = await seededLadder();
    expect(nextPendingSubticket(await readLadder(ladderPath))?.number).toBe(
      "1.1",
    );

    await completeSubticket(ladderPath, "1.1", "Run `r1`: completed");
    expect(nextPendingSubticket(await readLadder(ladderPath))?.number).toBe(
      "1.2",
    );

    await completeSubticket(ladderPath, "1.2", "Run `r2`: completed");
    expect(nextPendingSubticket(await readLadder(ladderPath))).toBeNull();
  });
});

describe("completeSubticket", () => {
  it("checks the box and appends the outcome under that subticket only", async () => {
    const ladderPath = await seededLadder();
    await completeSubticket(ladderPath, "1.1", "Run `run-1`: completed — /x");
    const ladder = await readLadder(ladderPath);

    expect(ladder).toContain("### [x] 1.1 Bootstrap the app — ENG-11");
    expect(ladder).toContain("> Run `run-1`: completed — /x");
    // The second subticket is untouched.
    expect(ladder).toContain("### [ ] 1.2 Add git storage");

    // The outcome lands inside 1.1's section, before the 1.2 heading.
    const outcomeAt = ladder.indexOf("> Run `run-1`");
    const nextHeadingAt = ladder.indexOf("### [ ] 1.2");
    expect(outcomeAt).toBeGreaterThan(0);
    expect(outcomeAt).toBeLessThan(nextHeadingAt);
  });

  it("throws when the subticket number is not in the ladder", async () => {
    const ladderPath = await seededLadder();
    await expect(completeSubticket(ladderPath, "9.9", "x")).rejects.toThrow(
      /not found in ladder/,
    );
  });
});

describe("outcome lines", () => {
  it("records a harness run with its failed arms", () => {
    const run = {
      runId: "run-42",
      artifactDir: "/results/run-42",
      status: "completed_with_failures",
      results: [
        { arm: "control", status: "succeeded" },
        { arm: "greptile", status: "failed" },
      ],
    } as unknown as HarnessRunResult;

    const outcome = runOutcome(run);
    expect(outcome).toContain("Run `run-42`: completed_with_failures");
    expect(outcome).toContain("failed arms: greptile");
    expect(outcome).toContain("/results/run-42");
  });

  it("reduces an infrastructure error to its first line", () => {
    expect(errorOutcome("docker daemon unavailable\nstack trace…")).toBe(
      "Run failed (infrastructure): docker daemon unavailable",
    );
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
    expect((await lstat(join(repo, "LADDER.md"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(repo, "LADDER.md"), "utf8")).toBe(
      "a real mounted file",
    );
  });
});
