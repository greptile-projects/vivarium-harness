import { describe, expect, it } from "bun:test";
import type { CommandRunner } from "../src/harness/github.js";
import { harnessProvenance } from "../src/harness/provenance.js";

// Which harness commit produced a run. The exec is injected for the same reason
// every other outside-world call in this suite is: nothing here runs git.

function fakeGit(
  answers: Record<string, { code?: number; stdout?: string }>,
): { exec: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const exec: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    // Key on the git subcommand, skipping the "-C <root>" prefix.
    const key = args.slice(2).join(" ");
    const answer = answers[key] ?? { code: 1, stdout: "" };
    return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

describe("harnessProvenance", () => {
  it("reports the commit, branch and a clean tree", async () => {
    const { exec, calls } = fakeGit({
      "rev-parse HEAD": { stdout: "abc123def\n" },
      "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
    });

    expect(await harnessProvenance(exec, "/harness")).toEqual({
      commit: "abc123def",
      branch: "main",
      dirty: false,
    });
    // Always asked against the harness root, never the process cwd.
    expect(calls[0].slice(0, 3)).toEqual(["git", "-C", "/harness"]);
  });

  it("flags a dirty tree — that run's code exists nowhere", async () => {
    const { exec } = fakeGit({
      "rev-parse HEAD": { stdout: "abc123def\n" },
      "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      "status --porcelain": { stdout: " M src/prompt.ts\n" },
    });
    expect((await harnessProvenance(exec, "/harness")).dirty).toBe(true);
  });

  it("leaves dirty unknown when status itself fails, rather than claiming clean", async () => {
    const { exec } = fakeGit({
      "rev-parse HEAD": { stdout: "abc123def\n" },
      "rev-parse --abbrev-ref HEAD": { code: 1 },
      "status --porcelain": { code: 128 },
    });
    const provenance = await harnessProvenance(exec, "/harness");
    expect(provenance.commit).toBe("abc123def");
    expect(provenance.dirty).toBeUndefined();
    expect(provenance.branch).toBeUndefined();
  });

  it("records the failure instead of omitting the field", async () => {
    // An absent provenance block would read identically to a run made before
    // this existed; a recorded error says which it was.
    const { exec } = fakeGit({});
    expect((await harnessProvenance(exec, "/nope")).error).toContain(
      "git rev-parse HEAD failed",
    );
  });

  it("survives a git that cannot be spawned at all", async () => {
    const exec: CommandRunner = async () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await harnessProvenance(exec, "/harness")).toEqual({
      error: "spawn git ENOENT",
    });
  });

  it("does not report a detached HEAD as a branch named HEAD", async () => {
    const { exec } = fakeGit({
      "rev-parse HEAD": { stdout: "abc123def\n" },
      "rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" },
      "status --porcelain": { stdout: "" },
    });
    expect((await harnessProvenance(exec, "/harness")).branch).toBeUndefined();
  });
});
