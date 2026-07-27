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

describe("arm-run.sh", () => {
  it("mounts only controlled inputs and gives each run fresh state", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivarium-arm-run-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const home = join(root, "home");
    const log = join(root, "docker.log");
    const envFile = join(root, ".env");
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(bin);
    await writeFile(join(home, ".codex", "auth.json"), "{}\n");
    await writeFile(
      envFile,
      [
        "KOMODO_CONTAINER=vivarium-komodo",
        "KOMODO_REPO=https://github.com/org/komodo.git",
        "KOMODO_GH_TOKEN=fake-token",
        // Former deployment knobs must be ignored: these are fixed experiment
        // constants now.
        "KOMODO_NOVNC_PORT=9999",
        "VIVARIUM_DOCKER=0",
        "VIVARIUM_GUI=0",
        "VIVARIUM_SCREEN=1x1x1",
        "VIVARIUM_IMAGE=wrong-image",
      ].join("\n"),
    );
    await writeFile(
      join(bin, "gh"),
      "#!/bin/sh\nexit 1\n",
    );
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$VIVARIUM_TEST_DOCKER_LOG"
if [ "$1 $2" = "network inspect" ]; then exit 1; fi
if [ "$1" = "run" ]; then echo container-id; exit 0; fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *"test -f /run/vivarium/ready"*) exit 0 ;;
    *"docker version"*) echo 29.1.3; exit 0 ;;
  esac
  exit 0
fi
if [ "$1" = "inspect" ]; then echo true; exit 0; fi
exit 0
`,
    );
    await Promise.all([
      chmod(join(bin, "gh"), 0o755),
      chmod(join(bin, "docker"), 0o755),
    ]);

    const result = await run(
      resolve("scripts/arm-run.sh"),
      ["komodo"],
      {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        ENV_FILE: envFile,
        VIVARIUM_CONTAINER_NAME: "runtime-komodo",
        VIVARIUM_DOCKER_VOLUME: "runtime-komodo-docker",
        VIVARIUM_NETWORK_NAME: "runtime-komodo-net",
        VIVARIUM_RUN_ID: "run-123",
        VIVARIUM_TEST_DOCKER_LOG: log,
      },
    );

    expect(result.code).toBe(0);
    const commands = await readFile(log, "utf8");
    const dockerRun = commands
      .split("\n")
      .find((line) => line.startsWith("run "));
    expect(dockerRun).toContain("--name runtime-komodo");
    expect(dockerRun).toContain(
      "-v runtime-komodo-docker:/var/lib/docker",
    );
    expect(dockerRun).toContain("vivarium.ephemeral=true");
    expect(dockerRun).toContain("vivarium.run=run-123");
    expect(dockerRun).toContain("--privileged");
    expect(dockerRun).toContain("-p 127.0.0.1:6080:6080");
    expect(dockerRun).toMatch(/ vivarium-arm$/);
    expect(dockerRun).not.toContain("9999");
    expect(dockerRun).not.toContain("wrong-image");
    expect(dockerRun).not.toContain("1x1x1");
    expect(dockerRun).toContain(
      `${home}/.codex/auth.json:/codex/auth.json:ro`,
    );
    expect(dockerRun).not.toContain("/codex/sessions");
    expect(dockerRun).not.toMatch(/\s--rm\s/);
    expect(commands).toContain(
      "exec -i -w / runtime-komodo git clone --origin origin https://github.com/org/komodo.git /workspace",
    );
  });
});
