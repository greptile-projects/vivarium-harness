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
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: resolve("."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveRun({ code: code ?? -1, stdout, stderr }),
    );
  });
}

describe("sandbox-run.sh", () => {
  it("mounts only controlled inputs and proxies credentials into fresh state", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-sandbox-run-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const log = join(root, "sbx.log");
    const envFile = join(root, ".env");
    const scratch = join(root, "scratch");
    const ladderMount = join(root, "ladder");
    await mkdir(bin);
    await writeFile(
      envFile,
      [
        "KOMODO_SANDBOX=vivarium-komodo",
        "KOMODO_REPO=https://github.com/org/komodo.git",
        "KOMODO_GH_TOKEN=fake-token",
        // Former deployment knobs must be ignored.
        "KOMODO_NOVNC_PORT=9999",
        "VIVARIUM_SCREEN=1x1x1",
        "VIVARIUM_IMAGE=wrong-image",
      ].join("\n"),
    );
    await writeFile(
      join(bin, "sbx"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$VIVARIUM_TEST_SBX_LOG"
if [ "$1 $2" = "secret set" ]; then cat >/dev/null; exit 0; fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *"gh api user"*) printf 'komodo-viv\\t1234\\n' ;;
  esac
  exit 0
fi
exit 0
`,
    );
    await chmod(join(bin, "sbx"), 0o755);

    const result = await run(
      resolve("scripts/sandbox-run.sh"),
      ["komodo"],
      {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        ENV_FILE: envFile,
        VIVARIUM_SANDBOX_NAME: "runtime-komodo",
        VIVARIUM_WORKSPACE_MOUNT: scratch,
        VIVARIUM_LADDER_MOUNT: ladderMount,
        VIVARIUM_RUN_ID: "run-123",
        VIVARIUM_TEST_SBX_LOG: log,
      },
    );

    expect(result.code).toBe(0);
    const commands = await readFile(log, "utf8");
    const create = commands
      .split("\n")
      .find((line) => line.startsWith("create "));
    expect(create).toContain("--name runtime-komodo");
    expect(create).toContain("--no-share-skills");
    expect(create).toContain("--cpus 4");
    expect(create).toContain("--memory 8g");
    expect(create).toContain("--template vivarium-arm:latest");
    expect(create).toContain("--publish 127.0.0.1:6080:6080/tcp4");
    expect(create).toContain(`codex ${scratch}`);
    expect(create).toContain(`${ladderMount}:ro`);
    expect(create).not.toContain("9999");
    expect(create).not.toContain("wrong-image");
    expect(create).not.toContain("1x1x1");
    expect(commands).toContain("secret set runtime-komodo github");
    expect(commands).toContain(
      "exec -e GH_TOKEN=proxy-managed -e GITHUB_TOKEN=proxy-managed runtime-komodo git clone --origin origin https://github.com/org/komodo.git /workspace",
    );
    expect(commands).not.toContain("fake-token");
    expect(commands).not.toContain(".codex/auth.json");
    expect(commands).not.toContain("/results");
    expect(await readFile(join(ladderMount, "LADDER.md"), "utf8")).toBe(
      await readFile(resolve("LADDER.md"), "utf8"),
    );
  });
});
