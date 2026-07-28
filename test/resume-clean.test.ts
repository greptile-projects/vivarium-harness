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
  it("removes every container without letting docker exec consume the list", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-resume-clean-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const log = join(root, "docker.log");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$VIVARIUM_TEST_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf '%s\\n' vivarium-test-komodo vivarium-test-tuatara
  exit 0
fi
if [ "$1" = "inspect" ]; then
  case "$3" in
    *vivarium.arm*) case "$*" in *komodo) echo komodo ;; *) echo tuatara ;; esac ;;
    *vivarium.run*) echo run-123 ;;
    *State.Running*) echo true ;;
  esac
  exit 0
fi
if [ "$1" = "exec" ]; then
  for argument in "$@"; do
    if [ "$argument" = "-i" ]; then
      cat >/dev/null
    fi
  done
  case "$*" in
    *"git rev-parse"*) echo main ;;
  esac
  exit 0
fi
exit 0
`,
    );
    await chmod(join(bin, "docker"), 0o755);

    const result = await run(
      resolve("scripts/resume-clean.sh"),
      ["--apply"],
      {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        VIVARIUM_TEST_DOCKER_LOG: log,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "removed 2 leftover ephemeral arm environment(s)",
    );
    const commands = await readFile(log, "utf8");
    expect(commands).toContain("rm -f -v vivarium-test-komodo");
    expect(commands).toContain("rm -f -v vivarium-test-tuatara");
    expect(commands).not.toMatch(/^exec .* -i(?: |$)/m);
  });
});
