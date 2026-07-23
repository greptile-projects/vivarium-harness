import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseGregConfig } from "../src/greg/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function repoEnv(): Promise<NodeJS.ProcessEnv> {
  const control = await mkdtemp(join(tmpdir(), "greg-control-"));
  const greptile = await mkdtemp(join(tmpdir(), "greg-greptile-"));
  temporaryDirectories.push(control, greptile);
  return { CONTROL_REPO: control, GREPTILE_REPO: greptile };
}

describe("parseGregConfig", () => {
  it("applies defaults", async () => {
    const config = await parseGregConfig([], await repoEnv());
    expect(config.maxRungs).toBe(10);
    expect(config.plannerSandbox).toBe("read-only");
    expect(config.northStar).toContain("clone of GitHub");
    expect(config.ladderPath).toBe(resolve("LADDER.md"));
    expect(config.ladderLinkName).toBe("LADDER.md");
    expect(config.base.arms).toHaveLength(2);
  });

  it("lets flags override env and defaults", async () => {
    const env = {
      ...(await repoEnv()),
      GREG_NORTH_STAR: "env goal",
      GREG_MAX_RUNGS: "3",
      GREG_SANDBOX: "workspace-write",
    };
    const config = await parseGregConfig(
      ["--north-star", "flag goal", "--max-rungs", "5", "--ladder", "/tmp/L.md"],
      env,
    );
    expect(config.northStar).toBe("flag goal");
    expect(config.maxRungs).toBe(5);
    expect(config.ladderPath).toBe("/tmp/L.md");
    expect(config.plannerSandbox).toBe("workspace-write");
  });

  it("reads greg settings from env when no flags are given", async () => {
    const config = await parseGregConfig([], {
      ...(await repoEnv()),
      GREG_MAX_RUNGS: "2",
      GREG_NORTH_STAR: "just this",
    });
    expect(config.maxRungs).toBe(2);
    expect(config.northStar).toBe("just this");
  });

  it("rejects an invalid max-rungs", async () => {
    await expect(
      parseGregConfig(["--max-rungs", "0"], await repoEnv()),
    ).rejects.toThrow(/positive integer/);
  });

  it("requires the harness arm configuration", async () => {
    await expect(parseGregConfig([], {})).rejects.toThrow(
      /CONTROL_REPO.*GREPTILE_REPO/,
    );
  });

  it("signals help", async () => {
    await expect(parseGregConfig(["--help"], {})).rejects.toThrow("HELP");
  });
});
