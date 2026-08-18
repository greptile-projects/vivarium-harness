import { describe, expect, it } from "bun:test";
import {
  pullHarnessUpdate,
  replacementCommand,
  type CommandResult,
} from "../src/update.js";

describe("pullHarnessUpdate", () => {
  it("pulls fast-forward-only and reports the checked-out revision", async () => {
    const commands: string[][] = [];
    const results: CommandResult[] = [
      { code: 0, stdout: "Updating abc..def\n", stderr: "" },
      { code: 0, stdout: "def1234\n", stderr: "" },
    ];

    const result = await pullHarnessUpdate("/harness", async (command) => {
      commands.push(command);
      return results.shift()!;
    });

    expect(commands).toEqual([
      ["git", "pull", "--ff-only"],
      ["git", "rev-parse", "--short", "HEAD"],
    ]);
    expect(result).toEqual({
      ok: true,
      revision: "def1234",
      message:
        "harness updated to def1234 · restart scheduled after current task",
    });
  });

  it("reports a failed pull and does not read a revision", async () => {
    const commands: string[][] = [];
    const result = await pullHarnessUpdate("/harness", async (command) => {
      commands.push(command);
      return { code: 1, stdout: "", stderr: "fatal: not possible\n" };
    });

    expect(commands).toEqual([["git", "pull", "--ff-only"]]);
    expect(result).toEqual({
      ok: false,
      message: "harness pull failed: fatal: not possible",
    });
  });
});

describe("replacementCommand", () => {
  it("relaunches the same Bun entrypoint and arguments", () => {
    expect(
      replacementCommand("/bin/bun", [
        "/bin/bun",
        "/harness/src/index.ts",
        "--tui",
      ]),
    ).toEqual(["/bin/bun", "/harness/src/index.ts", "--tui"]);
  });
});
