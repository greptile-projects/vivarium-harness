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
  highestMilestone,
  initLadder,
  malformedSubticketHeadings,
  nextPendingSubticket,
  parseSubtickets,
  readLadder,
  runOutcome,
} from "../src/greg-tile/ladder.js";
import type { HarnessRunResult } from "../src/harness/harness.js";

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

    await completeSubticket(ladderPath, "1.1");
    expect(nextPendingSubticket(await readLadder(ladderPath))?.number).toBe(
      "1.2",
    );

    await completeSubticket(ladderPath, "1.2");
    expect(nextPendingSubticket(await readLadder(ladderPath))).toBeNull();
  });
});

describe("completeSubticket", () => {
  it("checks the box and touches nothing else", async () => {
    const ladderPath = await seededLadder();
    const before = await readLadder(ladderPath);
    await completeSubticket(ladderPath, "1.1");
    const ladder = await readLadder(ladderPath);

    expect(ladder).toContain("### [x] 1.1 Bootstrap the app — ENG-11");
    // The second subticket is untouched.
    expect(ladder).toContain("### [ ] 1.2 Add git storage");
    // Exactly one line changed, and it is that heading. (Compared line by
    // line: the header's own example heading contains "### [ ] 1.1" too.)
    const changed = ladder
      .split("\n")
      .map((line, index) => [line, before.split("\n")[index]] as const)
      .filter(([now, was]) => now !== was);
    expect(changed).toEqual([
      [
        "### [x] 1.1 Bootstrap the app — ENG-11",
        "### [ ] 1.1 Bootstrap the app — ENG-11",
      ],
    ]);
  });

  // The regression that matters most in this file. The ladder is bind-mounted
  // read-only into both arms' containers and is also Greg's entire prompt, so
  // anything written here reaches every party the experiment depends on being
  // separated. It used to record the run: both merged pull request URLs (which
  // name both repositories) and, on failure, the arms by name.
  it("never writes anything that could identify the other arm", async () => {
    const ladderPath = await seededLadder();
    await completeSubticket(ladderPath, "1.1");
    const ladder = await readLadder(ladderPath);

    expect(ladder).not.toMatch(/https?:\/\//);
    expect(ladder).not.toMatch(/komodo|tuatara/i);
    expect(ladder).not.toMatch(/results\//);
    expect(ladder).not.toContain("pull/");
  });

  it("throws when the subticket number is not in the ladder", async () => {
    const ladderPath = await seededLadder();
    await expect(completeSubticket(ladderPath, "9.9")).rejects.toThrow(
      /not found in ladder/,
    );
  });

  // The parse contract's negative space: ### is reserved for subtickets, so a
  // ###-level line that does not parse is a heading Greg got almost right —
  // text that would sit on the ladder without ever being built.
  it("flags ### headings that do not parse as subtickets", async () => {
    const text = [
      "## Milestone 1: One",
      "",
      "### [ ] 1.1 Fine",
      "",
      "## Objective",
      "",
      "prose, not a heading",
      "",
      "### 1.2 Missing its checkbox",
      "",
      "### [x 1.3 Broken box",
    ].join("\n");

    expect(malformedSubticketHeadings(text)).toEqual([
      "### 1.2 Missing its checkbox",
      "### [x 1.3 Broken box",
    ]);
    expect(malformedSubticketHeadings("### [ ] 2.1 All good")).toEqual([]);
  });

  // Duplicate numbers should never exist (the planner rejects them), but a
  // hand-edit can still produce one — and flipping the first match would hit
  // the already-checked twin, leave the built rung pending, and send the loop
  // rebuilding it forever.
  it("flips the unchecked twin when a number is duplicated", async () => {
    const root = await mkdtemp(join(tmpdir(), "greg-ladder-"));
    temporaryDirectories.push(root);
    const ladderPath = join(root, "LADDER.md");
    await writeFile(
      ladderPath,
      [
        "## Milestone 1: One",
        "",
        "### [x] 1.1 Done already",
        "",
        "body",
        "",
        "### [ ] 1.1 The twin",
        "",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );

    await completeSubticket(ladderPath, "1.1");
    const ladder = await readLadder(ladderPath);

    expect(ladder).toContain("### [x] 1.1 The twin");
    expect(nextPendingSubticket(ladder)).toBeNull();
  });
});

describe("outcome lines", () => {
  it("records a harness run with its failed arms", () => {
    const run = {
      runId: "run-42",
      artifactDir: "/results/run-42",
      status: "completed_with_failures",
      results: [
        { arm: "komodo", status: "succeeded" },
        { arm: "tuatara", status: "failed" },
      ],
      landings: [
        {
          arm: "komodo",
          status: "merged",
          pullRequest: { number: 4, url: "https://github.com/org/repo/pull/4" },
          reviewRounds: [],
          conversation: [],
          notes: [],
        },
      ],
    } as unknown as HarnessRunResult;

    // What the line has to carry, not how it words it: the run, its status,
    // the arm that failed, and where the artifacts are.
    const outcome = runOutcome(run);
    expect(outcome).toContain("run-42");
    expect(outcome).toContain("completed_with_failures");
    expect(outcome).toContain("tuatara");
    expect(outcome).toContain("/results/run-42");
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
