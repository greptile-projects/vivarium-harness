import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLadder, readLadder } from "../src/greg/ladder.js";
import { reconcileLadder, reconcilePlan } from "../src/greg/reconcile.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

// A ladder mid-climb: one rung fully built and filed, one rung built but never
// closed, and a rung the filer only got halfway through before the crash.
async function scratchLadder(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "greg-reconcile-"));
  temporaryDirectories.push(root);
  const ladderPath = join(root, "LADDER.md");
  await initLadder(ladderPath, "goal");
  await appendFile(ladderPath, body, "utf8");
  return ladderPath;
}

const INTERRUPTED = `
## Milestone 1: Repo hosting — GRE-10

Stand the repos up.

### [x] 1.1 Create the repo — GRE-11

Body.

### [x] 1.2 Protect main — GRE-12

Body.

## Milestone 2: Quality gates — GRE-20

Make branches trustworthy.

### [x] 2.1 Commit checks — GRE-21

Body.

### [ ] 2.2 Branch rules

Body — the filer died before stamping this one.

### [ ] 2.3 Required reviews

Body — likewise.
`;

describe("reconcilePlan", () => {
  it("closes every built subticket that carries an id", async () => {
    const plan = reconcilePlan(await readLadder(await scratchLadder(INTERRUPTED)));

    expect(plan.close).toEqual([
      { number: "1.1", ticket: "GRE-11" },
      { number: "1.2", ticket: "GRE-12" },
      { number: "2.1", ticket: "GRE-21" },
    ]);
  });

  it("re-files the milestones whose subtickets never got stamped", async () => {
    const plan = reconcilePlan(await readLadder(await scratchLadder(INTERRUPTED)));

    // Milestone 1 is fully stamped; only the half-filed rung comes back, once.
    expect(plan.file).toEqual([2]);
  });

  it("wants nothing when every box and id already agrees", async () => {
    const ladder = await readLadder(
      await scratchLadder(
        "\n## Milestone 1: Done — GRE-10\n\nAll of it.\n\n### [x] 1.1 One — GRE-11\n\nBody.\n",
      ),
    );

    const plan = reconcilePlan(ladder);
    expect(plan.file).toEqual([]);
    expect(plan.close).toEqual([{ number: "1.1", ticket: "GRE-11" }]);
  });

  it("ignores unbuilt subtickets that already carry an id", async () => {
    const ladder = await readLadder(
      await scratchLadder(
        "\n## Milestone 4: Next — GRE-40\n\nPlanned, unbuilt.\n\n### [ ] 4.1 One — GRE-41\n\nBody.\n",
      ),
    );

    const plan = reconcilePlan(ladder);
    // Filed but not built: nothing to close, nothing to file.
    expect(plan.close).toEqual([]);
    expect(plan.file).toEqual([]);
  });
});

describe("reconcileLadder", () => {
  it("files the unstamped rung and closes every built issue", async () => {
    const ladderPath = await scratchLadder(INTERRUPTED);
    const filed: number[] = [];
    const closed: string[] = [];

    await reconcileLadder(ladderPath, () => {}, {
      file: async (_path, milestone) => {
        filed.push(milestone);
      },
      close: async (ticket) => {
        closed.push(ticket as string);
      },
    });

    expect(filed).toEqual([2]);
    expect(closed).toEqual(["GRE-11", "GRE-12", "GRE-21"]);
  });

  // Fails open, unlike the close inside the climb: this pass exists to shrink
  // drift that has already happened, so one unreachable issue must not abandon
  // the rest of the board.
  it("keeps going when one close fails, and reports what it planned", async () => {
    const ladderPath = await scratchLadder(INTERRUPTED);
    const closed: string[] = [];
    const logs: string[] = [];

    const plan = await reconcileLadder(ladderPath, (m) => logs.push(m), {
      file: async () => {},
      close: async (ticket) => {
        if (ticket === "GRE-12") throw new Error("Linear is down");
        closed.push(ticket as string);
      },
    });

    expect(closed).toEqual(["GRE-11", "GRE-21"]);
    expect(logs.join("\n")).toContain("Linear is down");
    expect(plan.close).toHaveLength(3);
  });

  it("keeps going when filing a milestone fails", async () => {
    const ladderPath = await scratchLadder(INTERRUPTED);
    const closed: string[] = [];
    const logs: string[] = [];

    await reconcileLadder(ladderPath, (m) => logs.push(m), {
      file: async () => {
        throw new Error("filer exploded");
      },
      close: async (ticket) => {
        closed.push(ticket as string);
      },
    });

    expect(logs.join("\n")).toContain("filer exploded");
    // The closes still ran.
    expect(closed).toEqual(["GRE-11", "GRE-12", "GRE-21"]);
  });

  it("does nothing and says so on a ladder that needs no reconciling", async () => {
    const ladderPath = await scratchLadder(
      "\n## Milestone 1: Next — GRE-40\n\nPlanned, unbuilt.\n\n### [ ] 1.1 One — GRE-41\n\nBody.\n",
    );
    const logs: string[] = [];
    let touched = false;

    await reconcileLadder(ladderPath, (m) => logs.push(m), {
      file: async () => {
        touched = true;
      },
      close: async () => {
        touched = true;
      },
    });

    expect(touched).toBe(false);
    expect(logs.join("\n")).toContain("already agree");
  });
});
