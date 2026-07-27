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
// often it looks. A review that never arrives must not hold the climb: the
// same trade the review mirror makes — sync integrity beats review
// completeness — except here it is recorded as a timed-out round.
export const REVIEW_TIMEOUT_MS = 3_600_000;
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
// The login the reviewed arm has to answer to. Confirmed live on the mirror
// pipeline; overridable with GREPTILE_BOT_LOGIN.
export const REVIEWER_LOGIN = "greptile-apps[bot]";

export type ArmName = "komodo" | "tuatara";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ArmConfig {
  name: ArmName;
  // Host path to the arm's checkout: the bind-mount source and where the
  // harness runs its own file ops (artifacts, greptile review).
  repo: string;
  // When set, the arm's codex runs via `docker exec` in this container instead
  // of on the host, giving each arm an isolated filesystem.
  container?: string;
  // Host CODEX_HOME for this arm — the directory whose `sessions/` the harness
  // scans to recover the arm's transcript. Containerized arms write sessions
  // inside the container, so this must point at the host dir arm-run.sh mounts
  // in. Unset means fall back to the run-wide CODEX_HOME.
  codexHome?: string;
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

export interface HarnessConfig {
  ticket: string;
  arms: [ArmConfig, ArmConfig];
  sandbox: SandboxMode;
  resultsDir: string;
  codexHome: string;
  // Image used by the arm launchers and Greg's ephemeral planning container.
  containerImage: string;
  maxAttempts: number;
  idleTimeoutMs: number;
  reviewTimeoutMs: number;
  reviewPollMs: number;
  reviewDebounceMs: number;
  reviewRounds: number;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
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

// A containerized arm writes its Codex sessions inside the container, so they
// must land on a host directory the harness can scan. arm-run.sh mounts
// $HOME/.vivarium/<container>/sessions into the container's CODEX_HOME; mirror
// that convention here so finishArm finds the transcript. Host-mode arms
// (no container) return undefined and fall back to the run-wide CODEX_HOME.
function armCodexHomeFromEnv(
  explicit: string | undefined,
  container: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  if (container) return join(homedir(), ".vivarium", container);
  return undefined;
}

export function parseArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): HarnessConfig {
  if (args.includes("--help")) {
    throw new Error("HELP");
  }

  const ticket = valueAfter(args, "--ticket");
  if (!ticket) {
    throw new Error("--ticket is required");
  }
  if (!env.KOMODO_REPO || !env.TUATARA_REPO) {
    throw new Error("KOMODO_REPO and TUATARA_REPO must be configured");
  }

  const sandbox = sandboxFromEnv(env.CODEX_SANDBOX);

  return {
    ticket,
    arms: [
      {
        name: "komodo",
        repo: env.KOMODO_REPO,
        container: env.KOMODO_CONTAINER,
        codexHome: armCodexHomeFromEnv(
          env.KOMODO_CODEX_HOME,
          env.KOMODO_CONTAINER,
        ),
        ghToken: env.KOMODO_GH_TOKEN,
        sandbox: armSandbox(sandbox, env.KOMODO_CONTAINER),
      },
      {
        name: "tuatara",
        repo: env.TUATARA_REPO,
        container: env.TUATARA_CONTAINER,
        codexHome: armCodexHomeFromEnv(
          env.TUATARA_CODEX_HOME,
          env.TUATARA_CONTAINER,
        ),
        ghToken: env.TUATARA_GH_TOKEN,
        sandbox: armSandbox(sandbox, env.TUATARA_CONTAINER),
        // The one asymmetry between the arms: this one has a reviewer whose
        // comments it has to answer on the record before its work lands.
        // Blank falls back too, not just unset: "" is falsy where the landing
        // phase checks `arm.reviewer`, so an empty GREPTILE_BOT_LOGIN= line in
        // .env would silently switch off every review round — the experiment's
        // whole variable — while the run reported itself normal.
        reviewer: env.GREPTILE_BOT_LOGIN?.trim() || REVIEWER_LOGIN,
      },
    ],
    sandbox: sandbox ?? "workspace-write",
    resultsDir: RESULTS_DIR,
    codexHome: env.CODEX_HOME ?? join(homedir(), ".codex"),
    containerImage: env.VIVARIUM_IMAGE ?? CONTAINER_IMAGE,
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
// modifier on the one loop, so resolving them is pure argv reading — kept here
// beside parseArgs (and out of the entrypoint's main()) so it is testable.
export interface RunMode {
  // "ladder" is the experiment: plan a rung, build its subtickets, repeat.
  // "ticket" runs one ad-hoc ticket — the escape hatch for exercising the
  // harness without letting Greg write a debug milestone into LADDER.md, which
  // is part of the published record.
  kind: "ladder" | "ticket";
  planOnly: boolean;
  unbounded: boolean;
  ticket?: string;
  useTui: boolean;
  json: boolean;
}

export function parseRunMode(args: string[], isTty: boolean): RunMode {
  const json = args.includes("--json");
  const planOnly = args.includes("--plan-only");
  const unbounded = args.includes("--unbounded");
  const ticket = valueAfter(args, "--ticket");
  const kind = ticket !== undefined ? "ticket" : "ladder";

  // Reject combinations that could only be honoured by silently ignoring one
  // of the flags the caller typed.
  if (kind !== "ladder" && planOnly) {
    throw new Error(
      "--plan-only plans ladder rungs; it cannot be combined with --ticket",
    );
  }
  if (kind !== "ladder" && unbounded) {
    throw new Error(
      "--unbounded lifts the ladder's milestone cap; it has no meaning with --ticket",
    );
  }
  // --json is for machines; never fight it for the terminal.
  const useTui = args.includes("--tui")
    ? true
    : args.includes("--no-tui") || json
      ? false
      : isTty;

  return { kind, planOnly, unbounded, ticket, useTui, json };
}

export async function validateConfig(
  config: HarnessConfig,
): Promise<HarnessConfig> {
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
  --ticket <description>  Skip the ladder: run this one ticket through both
                          arms and exit. For debugging the harness itself.
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
  KOMODO_REPO=<path>      Checkout without access to Greptile comments
  TUATARA_REPO=<path>     Checkout with access to Greptile comments

Optional environment:
  KOMODO_CONTAINER=<name>     Run Komodo's codex via docker exec in that
                          container (arm-run.sh mounts the checkout at
                          /workspace). Unset runs on the host with no isolation.
  TUATARA_CONTAINER=<name>    Same, for Tuatara.
  KOMODO_CODEX_HOME=<path>    Host dir whose sessions/ holds the arm's Codex
  TUATARA_CODEX_HOME=<path>   transcript. Containerized arms default to
                          ~/.vivarium/<container>; host arms use CODEX_HOME.
  KOMODO_GH_TOKEN=<token>     GitHub token per arm: the container pushes and
  TUATARA_GH_TOKEN=<token>    opens its pull request with it, and the harness
                          merges with it, so each arm lands under its own
                          identity. Unset falls back to the host's gh auth.
  CODEX_SANDBOX=<mode>    Overrides both arms. Unset, a containerized arm runs
                          danger-full-access (it needs the network to push and
                          to answer a review; the container is the boundary)
                          and a host arm runs workspace-write.
  CODEX_HOME=<path>       Defaults to ~/.codex; used to copy transcripts
  VIVARIUM_IMAGE=<image>  Container image used by arm-run.sh and Greg's
                          isolated planner. Defaults to ${CONTAINER_IMAGE}.
  IDLE_TIMEOUT_MS=<ms>    Abort a session after this much event silence.
                          Defaults to 240000 (4m); 0 disables the watchdog.
  GREPTILE_BOT_LOGIN=<login>  The reviewer Tuatara must answer before its
                          pull request is merged. Defaults to
                          ${REVIEWER_LOGIN}.
  REVIEW_TIMEOUT_MS=<ms>  How long to wait for that review before merging
                          without it. Defaults to ${REVIEW_TIMEOUT_MS} (1h).
  REVIEW_ROUNDS=<n>       Review → answer → re-review rounds per pull request.
                          Defaults to ${REVIEW_ROUNDS}.

The caller supplies only --ticket. Repository and tool isolation are deployment
configuration, not per-ticket orchestration inputs. Results dir (./results) and
attempts per arm (3) are fixed constants.`;
