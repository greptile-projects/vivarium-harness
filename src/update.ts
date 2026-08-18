export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string[],
  options: { cwd: string; inherit?: boolean },
) => Promise<CommandResult>;

const runCommand: CommandRunner = async (command, options) => {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: process.env,
    stdin: options.inherit ? "inherit" : "ignore",
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    options.inherit
      ? Promise.resolve("")
      : new Response(child.stdout).text(),
    options.inherit
      ? Promise.resolve("")
      : new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

export type HarnessUpdateResult =
  | { ok: true; revision?: string; message: string }
  | { ok: false; message: string };

function lastLine(value: string): string | undefined {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

// Pull while the current task is still running. This process has already
// loaded its TypeScript modules; the replacement process launched at the next
// boundary sees the new tree. Fast-forward-only keeps a hotfix refresh from
// creating a surprise merge commit in the harness checkout.
export async function pullHarnessUpdate(
  cwd: string = process.cwd(),
  run: CommandRunner = runCommand,
): Promise<HarnessUpdateResult> {
  let pulled: CommandResult;
  try {
    pulled = await run(["git", "pull", "--ff-only"], { cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `harness pull failed: ${message}` };
  }
  if (pulled.code !== 0) {
    const detail = lastLine(pulled.stderr) ?? lastLine(pulled.stdout);
    return {
      ok: false,
      message: `harness pull failed${detail ? `: ${detail}` : ""}`,
    };
  }

  try {
    const revision = await run(["git", "rev-parse", "--short", "HEAD"], {
      cwd,
    });
    const sha = revision.code === 0 ? lastLine(revision.stdout) : undefined;
    return {
      ok: true,
      revision: sha,
      message: sha
        ? `harness updated to ${sha} · restart scheduled after current task`
        : "harness updated · restart scheduled after current task",
    };
  } catch {
    return {
      ok: true,
      message: "harness updated · restart scheduled after current task",
    };
  }
}

export function replacementCommand(
  execPath: string = process.execPath,
  argv: string[] = process.argv,
): string[] {
  return [execPath, ...argv.slice(1)];
}

// Keep this process as a small supervisor so an attached shell does not print
// a prompt underneath the restarted TUI. In tmux the replacement remains in
// the same pane and continues normally after the user detaches.
export async function runReplacementHarness(
  cwd: string = process.cwd(),
  command: string[] = replacementCommand(),
  run: CommandRunner = runCommand,
): Promise<number> {
  const result = await run(command, { cwd, inherit: true });
  return result.code;
}
