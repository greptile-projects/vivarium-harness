import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const syncScript = join(repository, "scripts", "mirror_sync.sh");
const ghFixture = join(repository, "test", "fixtures", "mirror-sync-gh");

let suiteRoot: string;
let scenarioNumber = 0;

// These are offline integration tests: the GitHub CLI is stubbed, but Git and
// mirror_sync.sh are real. Leave headroom for slower CI filesystem operations.
setDefaultTimeout(15_000);

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function command(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr }),
    );
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await command("git", ["-C", cwd, ...args]);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.code}):\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function optionalFile(path: string, fallback = ""): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type SyncOverrides = {
  review?: string;
  sourcePr?: string;
  sourceTitle?: string;
  sourceBody?: string;
  sourceBodyFail?: string;
  reviewFetchFail?: string;
  pollTimeout?: string;
};

class Scenario {
  readonly path: string;
  readonly sourceBare: string;
  readonly mirrorBare: string;
  readonly stubDir: string;
  readonly work: string;
  readonly rootSha: string;

  // Where mirror_sync.sh writes each captured review. Per scenario, so nothing
  // lands in the repo's real results/ directory.
  get reviewDir(): string {
    return join(this.path, "reviews");
  }

  private constructor(
    path: string,
    sourceBare: string,
    mirrorBare: string,
    stubDir: string,
    work: string,
    rootSha: string,
  ) {
    this.path = path;
    this.sourceBare = sourceBare;
    this.mirrorBare = mirrorBare;
    this.stubDir = stubDir;
    this.work = work;
    this.rootSha = rootSha;
  }

  static async create(): Promise<Scenario> {
    const path = join(suiteRoot, `scenario-${++scenarioNumber}`);
    const sourceBare = join(path, "src.git");
    const mirrorBare = join(path, "mirror.git");
    const stubDir = join(path, "stub");
    const work = join(path, "work");
    await mkdir(stubDir, { recursive: true });
    await command("git", ["init", "-q", "--bare", sourceBare]);
    await command("git", ["init", "-q", "--bare", mirrorBare]);
    await command("git", ["clone", "-q", sourceBare, work]);
    await git(work, "config", "user.name", "komodo-agent");
    await git(work, "config", "user.email", "agent@armb.example");
    await writeFile(join(work, "file.txt"), "v1\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "initial commit");
    await git(work, "push", "-q", "origin", "HEAD:main");
    const rootSha = await git(work, "rev-parse", "HEAD");
    await git(work, "push", "-q", mirrorBare, "HEAD:main");
    await writeFile(join(stubDir, "state"), rootSha);
    await copyFile(ghFixture, join(stubDir, "gh"));
    await chmod(join(stubDir, "gh"), 0o755);
    return new Scenario(
      path,
      sourceBare,
      mirrorBare,
      stubDir,
      work,
      rootSha,
    );
  }

  async commit(content: string, message: string): Promise<string> {
    await writeFile(join(this.work, "file.txt"), `${content}\n`);
    await git(this.work, "add", "-A");
    await git(this.work, "commit", "-q", "-m", message);
    await git(this.work, "push", "-q", "origin", "HEAD:main");
    return await this.head();
  }

  async head(): Promise<string> {
    return await git(this.work, "rev-parse", "HEAD");
  }

  async run(overrides: SyncOverrides = {}): Promise<CommandResult> {
    const workdir = await mkdtemp(join(this.path, "wd-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${this.stubDir}:${process.env.PATH ?? ""}`,
      STUB_DIR: this.stubDir,
      MIRROR_BARE: this.mirrorBare,
      STUB_REVIEW: overrides.review ?? "1",
      STUB_SRC_PR: overrides.sourcePr ?? "",
      STUB_SRC_TITLE: overrides.sourceTitle ?? "",
      STUB_SRC_BODY: overrides.sourceBody ?? "",
      STUB_SRC_BODY_FAIL: overrides.sourceBodyFail ?? "",
      STUB_REVIEW_FETCH_FAIL: overrides.reviewFetchFail ?? "",
      MIRROR_REVIEW_DIR: this.reviewDir,
      API_RETRY_SLEEP: "0",
      MIRROR_PUSH_TOKEN: "dummy",
      HARNESS_ORG_TOKEN: "dummy",
      SOURCE_GIT_URL: `file://${this.sourceBare}`,
      MIRROR_GIT_URL: `file://${this.mirrorBare}`,
      WORKDIR: workdir,
      POLL_INTERVAL: "0",
      POLL_TIMEOUT: overrides.pollTimeout ?? "600",
    };
    const result = await command("bash", [syncScript], { env });
    await writeFile(join(this.path, "out.log"), result.stdout + result.stderr);
    return result;
  }

  async state(): Promise<string> {
    return await readFile(join(this.stubDir, "state"), "utf8");
  }

  async prCount(): Promise<number> {
    return Number(await optionalFile(join(this.stubDir, "counter"), "0"));
  }

  async titles(): Promise<string[]> {
    const value = await optionalFile(join(this.stubDir, "titles"));
    return value.trim() ? value.trimEnd().split("\n") : [];
  }

  async body(): Promise<string> {
    return await readFile(join(this.stubDir, "last_body"), "utf8");
  }

  // The capture directory mirror_sync.sh writes before merging one PR.
  async captureDir(sourceSha: string, pr: number): Promise<string> {
    const short = await git(this.sourceBare, "rev-parse", "--short=7", sourceSha);
    return join(this.reviewDir, `${short}-mirror-pr-${pr}`);
  }

  async capture(sourceSha: string, pr: number, file: string): Promise<string> {
    return await readFile(join(await this.captureDir(sourceSha, pr), file), "utf8");
  }

  async mirrorMain(): Promise<string> {
    return await git(this.mirrorBare, "rev-parse", "refs/heads/main");
  }

  async log(): Promise<string> {
    return await optionalFile(join(this.path, "out.log"));
  }

  async expectTreeAt(sourceSha: string): Promise<void> {
    const sourceTree = await git(
      this.sourceBare,
      "rev-parse",
      `${sourceSha}^{tree}`,
    );
    const mirrorTree = await git(
      this.mirrorBare,
      "rev-parse",
      "refs/heads/main^{tree}",
    );
    expect(mirrorTree).toBe(sourceTree);
  }
}

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), "mirror-sync-test-"));
});

afterAll(async () => {
  await rm(suiteRoot, { recursive: true, force: true });
});

describe("mirror_sync.sh", () => {
  test("mirrors one source state through one PR", async () => {
    const scenario = await Scenario.create();
    const head = await scenario.commit("v2", "add feature X");

    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.prCount()).toBe(1);
    expect(await scenario.state()).toBe(head);
    await scenario.expectTreeAt(head);
  });

  test("replays a burst of states sequentially and in order", async () => {
    const scenario = await Scenario.create();
    await scenario.commit("v2", "commit two");
    await scenario.commit("v3", "commit three");
    const head = await scenario.commit("v4", "commit four");

    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.prCount()).toBe(3);
    expect(await scenario.state()).toBe(head);
    expect(await scenario.titles()).toEqual([
      "[codex] commit two",
      "[codex] commit three",
      "[codex] commit four",
    ]);
    await scenario.expectTreeAt(head);
  });

  test("advances state without a PR for a history-only rewrite", async () => {
    const scenario = await Scenario.create();
    await git(scenario.work, "commit", "-q", "--amend", "-m", "reworded");
    await git(scenario.work, "push", "-q", "-f", "origin", "HEAD:main");
    const head = await scenario.head();

    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.prCount()).toBe(0);
    expect(await scenario.state()).toBe(head);
  });

  test("coarsely mirrors a force-push with a marked PR", async () => {
    const scenario = await Scenario.create();
    await git(scenario.work, "checkout", "-q", "--orphan", "fp");
    await git(scenario.work, "rm", "-q", "-r", "-f", ".");
    await writeFile(join(scenario.work, "other.txt"), "totally different\n");
    await git(scenario.work, "add", "-A");
    await git(scenario.work, "commit", "-q", "-m", "force-push rewrite");
    await git(scenario.work, "push", "-q", "-f", "origin", "HEAD:main");
    const head = await scenario.head();

    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.prCount()).toBe(1);
    expect(await scenario.titles()).toEqual([
      "[codex] [force-push] force-push rewrite",
    ]);
    expect(await scenario.state()).toBe(head);
    await scenario.expectTreeAt(head);
  });

  test("resumes idempotently without duplicate PRs", async () => {
    const scenario = await Scenario.create();
    const head = await scenario.commit("v2", "resumable commit");

    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.prCount()).toBe(1);
    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.prCount()).toBe(1);
    expect(await scenario.state()).toBe(head);

    await writeFile(join(scenario.stubDir, "state"), scenario.rootSha);
    await writeFile(join(scenario.stubDir, "counter"), "0");
    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.prCount()).toBe(0);
    expect(await scenario.state()).toBe(head);
  });

  test("labels a review timeout and continues the queue", async () => {
    const scenario = await Scenario.create();
    const head = await scenario.commit("v2", "unreviewed commit");

    expect(
      (await scenario.run({ review: "0", pollTimeout: "0" })).code,
    ).toBe(0);
    expect(await scenario.prCount()).toBe(1);
    expect(await fileExists(join(scenario.stubDir, "timeout_marker"))).toBe(
      true,
    );
    expect(await scenario.state()).toBe(head);
    await scenario.expectTreeAt(head);
  });

  test("does not double an existing codex title marker", async () => {
    const scenario = await Scenario.create();
    await scenario.commit("v2", "[codex] already marked");

    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.titles()).toEqual(["[codex] already marked"]);
  });

  // Both arms now title their own pull requests "[codex] …" (the worker prompt
  // requires it), so a source title arriving already marked is the normal case,
  // not the exception. On the force-push path the per-path prefix used to land
  // *between* the marker and the title, which defeated the "already marked?"
  // check and produced "[codex] [force-push] [codex] …". The marker has to end
  // up outermost, exactly once.
  test("keeps the marker outermost and single on a marked force-push", async () => {
    const scenario = await Scenario.create();
    await git(scenario.work, "checkout", "-q", "--orphan", "fp2");
    await git(scenario.work, "rm", "-q", "-r", "-f", ".");
    await writeFile(join(scenario.work, "other.txt"), "totally different\n");
    await git(scenario.work, "add", "-A");
    await git(scenario.work, "commit", "-q", "-m", "[codex] marked rewrite");
    await git(scenario.work, "push", "-q", "-f", "origin", "HEAD:main");

    expect((await scenario.run()).code).toBe(0);
    expect(await scenario.titles()).toEqual([
      "[codex] [force-push] marked rewrite",
    ]);
  });

  test("carries the complete source PR description ahead of provenance", async () => {
    const scenario = await Scenario.create();
    const sourceBody = `## Original Ticket

## Objective

Give the platform a repository lifecycle.

## Deliverable

A caller can create, identify, reopen, and inspect an empty repository.

## What changed

Added the storage interface.`;
    await scenario.commit("v2", "1.1 Create and open repositories");

    expect(
      (
        await scenario.run({
          sourcePr: "42",
          sourceTitle: "1.1 Create and open repositories",
          sourceBody,
        })
      ).code,
    ).toBe(0);
    const body = await scenario.body();
    expect(body.startsWith("## Original Ticket\n")).toBe(true);
    expect(body).toContain("Give the platform a repository lifecycle.");
    expect(body).toContain("## Deliverable");
    expect(body).toMatch(/^Source SHA: /m);
  });

  test("omits the separator for an empty source PR description", async () => {
    const scenario = await Scenario.create();
    await scenario.commit("v2", "hotfix");

    expect(
      (
        await scenario.run({
          sourcePr: "43",
          sourceTitle: "hotfix",
          sourceBody: "",
        })
      ).code,
    ).toBe(0);
    const body = await scenario.body();
    expect(body.startsWith("Source PR: #43 — ")).toBe(true);
    expect(body).not.toMatch(/^---$/m);
  });

  test("fails without opening a PR when the description cannot be read", async () => {
    const scenario = await Scenario.create();
    await scenario.commit("v2", "1.2 Store and retrieve Git objects");
    const stateBefore = await scenario.state();

    const result = await scenario.run({
      sourcePr: "44",
      sourceTitle: "1.2 Store and retrieve Git objects",
      sourceBodyFail: "1",
    });
    expect(result.code).not.toBe(0);
    expect(await scenario.prCount()).toBe(0);
    expect(await scenario.state()).toBe(stateBefore);
    expect(result.stderr).toContain(
      "refusing to open a mirror PR without it",
    );
    expect(
      result.stderr.match(/could not read description.*\(attempt /g),
    ).toHaveLength(3);
  });

  // The review of the mirror IS the control arm's counterfactual — what Greptile
  // says about code written by the arm that cannot hear it. The pipeline used to
  // check only that a review *existed* and then merge past it, so the findings
  // themselves lived on the mirror PR and in an expiring Actions log, and in no
  // artifact of the experiment.
  test("captures the mirror review before merging past it", async () => {
    const scenario = await Scenario.create();
    const head = await scenario.commit("v2", "1.3 Reviewed commit");

    const result = await scenario.run({ sourcePr: "45" });
    expect(result.code).toBe(0);

    expect(await scenario.capture(head, 1, "reviews.json")).toContain(
      "stub greptile review body",
    );
    // Inline comments keep path/line/diff_hunk — the code each finding was
    // written against, which a body alone does not say.
    expect(await scenario.capture(head, 1, "review-comments.json")).toContain(
      "diff_hunk",
    );

    const meta = JSON.parse(await scenario.capture(head, 1, "meta.json"));
    expect(meta.timedOut).toBe(false);
    expect(meta.source.pullRequest).toBe(45);
    expect(meta.source.sha).toBe(head);
    expect(meta.mirror.pullRequest).toBe(1);

    // Captured before the merge: afterwards this pipeline never looks at the PR
    // again.
    const log = await scenario.log();
    expect(log.indexOf("captured review into")).toBeLessThan(
      log.indexOf(": merged"),
    );
  });

  // A review that never arrives is a real observation about the pipeline, so it
  // is recorded as an empty capture rather than as a missing file — those read
  // the same to anyone counting rungs later.
  test("records a timed-out review as an empty capture", async () => {
    const scenario = await Scenario.create();
    const head = await scenario.commit("v2", "unreviewed commit");

    expect(
      (await scenario.run({ review: "0", pollTimeout: "0" })).code,
    ).toBe(0);

    const meta = JSON.parse(await scenario.capture(head, 1, "meta.json"));
    expect(meta.timedOut).toBe(true);
    expect((await scenario.capture(head, 1, "reviews.json")).trim()).toBe("[]");
  });

  // Capturing runs before the merge precisely so this can fail closed: merging
  // past a review we could not read loses it for good, while dying costs a rerun
  // that resumes at the same open PR.
  test("stops the merge when the review cannot be read", async () => {
    const scenario = await Scenario.create();
    await scenario.commit("v2", "unreadable review");
    const stateBefore = await scenario.state();

    const result = await scenario.run({ reviewFetchFail: "1" });

    expect(result.code).not.toBe(0);
    expect(await scenario.state()).toBe(stateBefore);
    expect(await scenario.mirrorMain()).toBe(scenario.rootSha);
    expect(result.stderr).toContain(
      "refusing to merge past a review it cannot keep",
    );
    expect(
      result.stderr.match(/could not read reviews on mirror.*\(attempt /g),
    ).toHaveLength(3);
  });
});
