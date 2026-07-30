import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: resolve("."),
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveRun({ code: code ?? -1, stderr }),
    );
  });
}

describe("resume-clean.sh", () => {
  it("removes every sandbox without letting sbx exec consume the list", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-resume-clean-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const log = join(root, "sbx.log");
    await mkdir(bin);
    await writeFile(
      join(bin, "sbx"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$VIVARIUM_TEST_SBX_LOG"
if [ "$1" = "ls" ]; then
  printf '%s\\n' vivarium-test-komodo-run123 vivarium-test-tuatara-run123
  exit 0
fi
if [ "$1" = "exec" ]; then
  # Model an sbx client that inspects stdin. Cleanup must give it /dev/null,
  # not the while-read stream containing the remaining sandbox names.
  cat >/dev/null
  case "$*" in
    *"git rev-parse"*) echo main ;;
  esac
  exit 0
fi
exit 0
`,
    );
    await chmod(join(bin, "sbx"), 0o755);

    const result = await run(
      resolve("scripts/resume-clean.sh"),
      ["--apply"],
      {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        VIVARIUM_TEST_SBX_LOG: log,
        // Supplied through the environment so the test runs in a clean
        // checkout with no .env — the script's guards accept either source.
        KOMODO_SANDBOX: "vivarium-test-komodo",
        TUATARA_SANDBOX: "vivarium-test-tuatara",
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "removed 2 leftover ephemeral environment(s)",
    );
    const commands = await readFile(log, "utf8");
    expect(commands).toContain(
      "secret rm vivarium-test-komodo-run123 github --force",
    );
    expect(commands).toContain("rm --force vivarium-test-komodo-run123");
    expect(commands).toContain("rm --force vivarium-test-tuatara-run123");
    expect(commands).not.toMatch(/^exec .* -i(?: |$)/m);
  });
});
