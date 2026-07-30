import { homedir } from "node:os";
import { join } from "node:path";
import { realpath, stat } from "node:fs/promises";

// Fixed for the experiment — not configurable. Artifacts always land in
// ./results and each arm gets three autonomous attempts.
export const RESULTS_DIR = "results";
export const MAX_ATTEMPTS = 3;
export const CONTAINER_IMAGE = "vivarium-arm";
// Runaway guard for the ladder loop: pause once this many milestones (rungs)
// have been built (or planned, under --plan-only) so a human reconfirms the
// direction before more Codex runs are spent. The run always finishes the
// rung it is on — the pause lands between milestones, never mid-milestone.
// Lifted by --unbounded. It lives here beside the other fixed experiment
// constants, and because the usage text quotes it.
export const MAX_MILESTONES = 2;
// Default for the activity watchdog: abort a session after this much
// codex/event silence. Overridable via the IDLE_TIMEOUT_MS env var (0
// disables) — a hung external tool call otherwise holds a run for the full
// default before anything notices.
export const IDLE_TIMEOUT_MS = 240_000;
// How long the landing phase waits for the reviewer to say something about an
// arm's pull request before merging without it (REVIEW_TIMEOUT_MS), and how
// often it looks. The window is rolling: it is measured from the reviewer's
// last comment (as observed by the harness), or from the start of the wait
// when there has been none — "the reviewer has been silent this long", not a
// per-round allowance. A review that never arrives must not hold the climb:
// the same trade the review mirror makes — sync integrity beats review
// completeness — except here it is recorded as a timed-out round.
export const REVIEW_TIMEOUT_MS = 1_200_000;
export const REVIEW_POLL_MS = 30_000;
// Once reviewer activity appears, wait for one quiet interval before starting
// a Codex turn. GitHub exposes a single submitted review through multiple
// surfaces that can become visible a few seconds apart; batching them prevents
// one review from producing several arm prompts.
export const REVIEW_DEBOUNCE_MS = 30_000;
// How many review → answer → re-review rounds one pull request gets. Greptile
// re-reviews after a push, so round 2 is where "did the answer land" shows up,
// and later rounds are where a disagreement actually plays out — the reviewed
// arm pushing back, Greptile holding or conceding. That exchange is the
// experiment's subject matter, so the cap is set well above the point where
// most pull requests settle rather than at it.
//
// It is a *maximum*, not a count: the loop stops at the first round where the
// reviewer says nothing new (recorded as a timeout) or the arm's answer turn
// errors, so a pull request that settles in one round still costs one round.
// The wall-clock exposure is bounded the same way — only the final, unanswered
// round pays the full REVIEW_TIMEOUT_MS.
export const REVIEW_ROUNDS = 5;
// The login the reviewed arm has to answer to. This is part of the experiment,
// not deployment configuration; change it deliberately in code if the
// installed reviewer identity ever changes.
export const REVIEWER_LOGIN = "greptile-apps[bot]";

export type ArmName = "komodo" | "tuatara";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ArmConfig {
  name: ArmName;
  // Container mode: the Git remote cloned into /workspace by arm-run.sh.
  // Host smoke-test mode: the local checkout path. The deployment mode makes
  // the interpretation unambiguous, while keeping one configuration key.
  repo: string;
  // When set, the arm's codex runs via `docker exec` in this container instead
  // of on the host. In real runs this is a stable name prefix; runHarness adds
  // a unique suffix and creates a fresh container for each subticket.
  container?: string;
  // GitHub token the *harness* acts with on this arm's behalf (finding the pull
  // request, reading the review, merging). The same token the container gets,
  // so the record shows one identity per arm rather than the operator's.
  ghToken?: string;
  // Sandbox for this arm's Codex session. A containerized arm gets
  // danger-full-access by default: it needs the network to push a branch and
  // open a pull request, and the container — not the sandbox — is what keeps
  // it away from the host and the other arm.
  sandbox?: SandboxMode;
  // The reviewer login this arm has to answer to. Set on exactly one arm; that
  // asymmetry *is* the experiment. An arm without it merges as soon as its
  // pull request exists.
  reviewer?: string;
}

// Where one run's artifacts land. The climb fills this in per subticket so the
// record is filed by ladder coordinates (results/rung-01/run/1.2) rather than
// by an opaque run id. Optional on the type only because parseArgs cannot know
// it — RunArtifacts refuses to run without one.
export interface RunDestination {
  directory: string;
  // The ladder coordinates this run builds, recorded into run.json so the
  // directory tree and the record inside it can never disagree.
  subticket?: { number: string; milestone: number; title: string };
}

export interface HarnessConfig {
  ticket: string;
  arms: [ArmConfig, ArmConfig];
  sandbox: SandboxMode;
  // Run every Codex session on the fast service tier. Optional so injected
  // test configs and direct runHarness callers written before the toggle keep
  // their standard-tier behavior.
  fastMode?: boolean;
  resultsDir: string;
  destination?: RunDestination;
  codexHome: string;
  maxAttempts: number;
  idleTimeoutMs: number;
  reviewTimeoutMs: number;
  reviewPollMs: number;
  reviewDebounceMs: number;
  reviewRounds: number;
}

// An explicit CODEX_SANDBOX always wins; unset returns undefined so each arm
// can pick its own default (see armSandbox).
function sandboxFromEnv(value: string | undefined): SandboxMode | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const sandbox = value.trim();
  if (
    sandbox !== "read-only" &&
    sandbox !== "workspace-write" &&
    sandbox !== "danger-full-access"
  ) {
    throw new Error(
      "CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access",
    );
  }
  return sandbox;
}

// A containerized arm has to reach the network — it pushes a branch, opens a
// pull request and answers a review with `gh` — and the container is already
// the isolation boundary, so the sandbox inside it only gets in the way. A
// host-mode arm shares the operator's filesystem and stays fenced in.
export function armSandbox(
  explicit: SandboxMode | undefined,
  container: string | undefined,
): SandboxMode {
  if (explicit) return explicit;
  return container ? "danger-full-access" : "workspace-write";
}

function positiveFromEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function booleanFromEnv(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function parseArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): HarnessConfig {
  if (args.includes("--help")) {
    throw new Error("HELP");
  }

  if (!env.KOMODO_REPO || !env.TUATARA_REPO) {
    throw new Error("KOMODO_REPO and TUATARA_REPO must be configured");
  }

  const sandbox = sandboxFromEnv(env.CODEX_SANDBOX);

  return {
    // There is no per-run ticket input: the ladder loop fills this per
    // subticket from the rung's description. runHarness refuses to run on the
    // placeholder, so a wiring that forgets fails loudly.
    ticket: "",
    arms: [
      {
        name: "komodo",
        repo: env.KOMODO_REPO,
        container: env.KOMODO_CONTAINER,
        ghToken: env.KOMODO_GH_TOKEN,
        sandbox: armSandbox(sandbox, env.KOMODO_CONTAINER),
      },
      {
        name: "tuatara",
        repo: env.TUATARA_REPO,
        container: env.TUATARA_CONTAINER,
        ghToken: env.TUATARA_GH_TOKEN,
        sandbox: armSandbox(sandbox, env.TUATARA_CONTAINER),
        // The one asymmetry between the arms: this one has a reviewer whose
        // comments it has to answer on the record before its work lands.
        reviewer: REVIEWER_LOGIN,
      },
    ],
    sandbox: sandbox ?? "workspace-write",
    fastMode: booleanFromEnv(
      "CODEX_FAST_MODE",
      env.CODEX_FAST_MODE,
      false,
    ),
    resultsDir: RESULTS_DIR,
    codexHome: env.CODEX_HOME ?? join(homedir(), ".codex"),
    maxAttempts: MAX_ATTEMPTS,
    idleTimeoutMs: positiveFromEnv(
      "IDLE_TIMEOUT_MS",
      env.IDLE_TIMEOUT_MS,
      IDLE_TIMEOUT_MS,
    ),
    reviewTimeoutMs: positiveFromEnv(
      "REVIEW_TIMEOUT_MS",
      env.REVIEW_TIMEOUT_MS,
      REVIEW_TIMEOUT_MS,
    ),
    reviewPollMs: REVIEW_POLL_MS,
    reviewDebounceMs: REVIEW_DEBOUNCE_MS,
    reviewRounds: positiveFromEnv(
      "REVIEW_ROUNDS",
      env.REVIEW_ROUNDS,
      REVIEW_ROUNDS,
    ),
  };
}

// How a single `bun start` invocation should behave. Every option is a
// modifier on the one ladder loop, so resolving them is pure argv reading —
// kept here beside parseArgs (and out of the entrypoint's main()) so it is
// testable.
export interface RunMode {
  planOnly: boolean;
  unbounded: boolean;
  useTui: boolean;
  json: boolean;
}

export function parseRunMode(args: string[], isTty: boolean): RunMode {
  // The one-ticket escape hatch is gone: the ladder is the only run mode.
  // Refuse the old flag rather than silently climbing the ladder under a
  // caller who asked for something else.
  if (args.includes("--ticket")) {
    throw new Error(
      "--ticket has been removed; bun start always climbs the ladder",
    );
  }

  const json = args.includes("--json");
  const planOnly = args.includes("--plan-only");
  const unbounded = args.includes("--unbounded");
  // --json is for machines; never fight it for the terminal.
  const useTui = args.includes("--tui")
    ? true
    : args.includes("--no-tui") || json
      ? false
      : isTty;

  return { planOnly, unbounded, useTui, json };
}

export async function validateConfig(
  config: HarnessConfig,
): Promise<HarnessConfig> {
  // Isolation has to be all-or-nothing. Each arm derives `container` — and
  // therefore its sandbox — from its own `<ARM>_CONTAINER`, so one unset or
  // typo'd variable (or a container that failed to start) would leave that arm
  // running Codex on the *host* at `workspace-write` while the other runs in a
  // container at `danger-full-access`. Different sandbox, different tool
  // reach, and the host-mode arm can read the other arm's checkout, `results/`
  // and `.env` directly — an asymmetry between the arms that the manifest would
  // record as a perfectly normal run. Refuse it here instead.
  const containerized = config.arms.filter((arm) => arm.container);
  if (containerized.length !== 0 && containerized.length !== config.arms.length) {
    const missing = config.arms
      .filter((arm) => !arm.container)
      .map((arm) => `${arm.name.toUpperCase()}_CONTAINER`);
    throw new Error(
      `every arm must be containerized or none may be — set ${missing.join(" and ")}, or unset the others to run both on the host`,
    );
  }

  if (containerized.length === config.arms.length) {
    const containerPrefixes = config.arms.map((arm) => arm.container as string);
    for (const [index, prefix] of containerPrefixes.entries()) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix)) {
        throw new Error(
          `${config.arms[index]!.name.toUpperCase()}_CONTAINER must be a valid Docker name prefix`,
        );
      }
    }
    if (containerPrefixes[0] === containerPrefixes[1]) {
      throw new Error(
        "KOMODO_CONTAINER and TUATARA_CONTAINER must use different name prefixes",
      );
    }

    const remotes = config.arms.map((arm) => arm.repo.trim());
    for (const [index, remote] of remotes.entries()) {
      if (/^https:\/\/[^/]*@/.test(remote)) {
        throw new Error(
          `${config.arms[index]!.name.toUpperCase()}_REPO must not contain credentials; use the matching *_GH_TOKEN`,
        );
      }
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(remote)) {
        throw new Error(
          `${config.arms[index]!.name.toUpperCase()}_REPO must be an HTTPS GitHub clone URL in container mode`,
        );
      }
    }
    const normalized = remotes.map((remote) =>
      remote.replace(/\.git$/, "").toLowerCase(),
    );
    if (normalized[0] === normalized[1]) {
      throw new Error(
        "KOMODO_REPO and TUATARA_REPO must be different GitHub repositories",
      );
    }
    return {
      ...config,
      arms: config.arms.map((arm, index) => ({
        ...arm,
        repo: remotes[index]!,
      })) as [ArmConfig, ArmConfig],
    };
  }

  const canonicalRepos = await Promise.all(
    config.arms.map(async (arm) => {
      const repo = await realpath(arm.repo);
      const info = await stat(repo);
      if (!info.isDirectory()) {
        throw new Error(`${repo} is not a directory`);
      }
      return repo;
    }),
  );

  if (canonicalRepos[0] === canonicalRepos[1]) {
    throw new Error("KOMODO_REPO and TUATARA_REPO must be different checkouts");
  }

  return {
    ...config,
    arms: config.arms.map((arm, index) => ({
      ...arm,
      repo: canonicalRepos[index],
    })) as [ArmConfig, ArmConfig],
  };
}

export const usage = `Usage:
  bun start                              climb the ladder: plan the next rung,
                                         then build its subtickets through both
                                         arms. Pauses after ${MAX_MILESTONES} milestones.
  bun start -- [options]

Options:
  --unbounded             Do not pause after ${MAX_MILESTONES} milestones (never returns).
  --plan-only             Plan rungs onto the ladder; build nothing. A later
                          \`bun start\` builds everything queued this way.
  --tui / --no-tui        Force the live view on/off (default: on when stdout
                          is a TTY). Both write one progress.log per arm under
                          results/live-<ts>/<arm>/.
  --json                  Print the machine-readable result; implies --no-tui.
  --help                  This message.

In the live view: tab / arrows switch tabs, 1-9 jump straight to one, up/down
scroll the ladder and log tabs (g returns to live), q quits.

Quitting stops the run. If sessions are still working, q asks first (y / n) and
names what would be torn down; y stops every one of them and exits 1, and any
other key goes back to watching. Ctrl-C stops the run without asking.

Exit code is 1 whenever an arm exhausts its retries or the run throws.

Required environment:
  KOMODO_REPO=<url>       HTTPS GitHub clone URL for Komodo
  TUATARA_REPO=<url>      HTTPS GitHub clone URL for Tuatara

Optional environment:
  KOMODO_CONTAINER=<name>     Run Komodo's codex via docker exec in that
                          container. arm-run.sh clones KOMODO_REPO into its
                          private /workspace. Unset uses KOMODO_REPO as a
                          local checkout path, for smoke tests only.
  TUATARA_CONTAINER=<name>    Same, for Tuatara.
  KOMODO_GH_TOKEN=<token>     GitHub token per arm: the container pushes and
  TUATARA_GH_TOKEN=<token>    opens its pull request with it, and the harness
                          merges with it, so each arm lands under its own
                          identity. Required by arm-run.sh; host smoke tests
                          may omit it and fall back to the host's gh auth.
  CODEX_SANDBOX=<mode>    Overrides both arms. Unset, a containerized arm runs
                          danger-full-access (it needs the network to push and
                          to answer a review; the container is the boundary)
                          and a host arm runs workspace-write.
  CODEX_FAST_MODE=<bool>  Use Codex's fast service tier for Greg and both
                          arms. Defaults to false. Fast mode consumes credits
                          faster and only applies to supported models.
  CODEX_HOME=<path>       Defaults to ~/.codex; used by Greg and host smoke
                          sessions. Arm transcripts are copied from containers.
  IDLE_TIMEOUT_MS=<ms>    Abort a session after this much event silence.
                          Defaults to 240000 (4m); 0 disables the watchdog.
  REVIEW_TIMEOUT_MS=<ms>  How long to wait for that review before merging
                          without it, rolling from the reviewer's last
                          comment. Defaults to ${REVIEW_TIMEOUT_MS} (20m).
  REVIEW_ROUNDS=<n>       Review → answer → re-review rounds per pull request.
                          Defaults to ${REVIEW_ROUNDS}.

The caller supplies nothing per run — the ladder is the input. Repository and
tool isolation are deployment configuration, not per-ticket orchestration
inputs. Results dir (./results) and attempts per arm (3) are fixed constants.`;
