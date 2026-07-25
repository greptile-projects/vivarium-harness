# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An A/B harness that runs the **same Linear ticket through two Codex workers at
once** — **Tuatara** (the Greptile-enabled checkout) and **Komodo** (the plain
checkout) — and durably records everything each one did, so the two outcomes
can be compared. Tuatara is presented first in human-facing output. The stable
internal identifiers remain `greptile` and `control`, respectively. The only
per-run input is `--ticket`; which two checkouts run, and whether they're
isolated in containers, is deployment configuration set once in `.env`, never
per ticket.

Each arm drives a real Codex session over MCP (`codex mcp-server`, stdio
transport). For real runs each arm's Codex runs inside its own Docker container
so it cannot see the other arm's checkout; the harness itself always runs on the
host and orchestrates both containers.

**Greg Tile** is the layer above, and the default behaviour of `bun start`: a
stateless planner loop that supplies the tickets itself. Rather than you passing
`--ticket`, Greg plans the next milestone toward a fixed North Star, writes it
into `LADDER.md` as checkbox subtickets, then mechanically runs the same two-arm
harness on each one. Greg takes no configuration of its own — it reuses the arms
from `.env`. The experiment *is* this loop running for a long time; a one-off
ticket run is a debugging option (`--ticket`), not the product.

## Commands

```bash
bun install
```

### Run the experiment

There is **one** run command. Bare `bun start` is the experiment itself: Greg
plans the next rung onto `LADDER.md`, both arms build its subtickets, repeat.
Everything else is an option on that loop, not a separate entrypoint.

```bash
bun start                        # climb: plan a rung, build its subtickets, pause after 2 rungs
bun start -- --unbounded         # same, without the 2-milestone pause
bun start -- --plan-only         # plan rungs onto the ladder; build nothing
bun start -- --ticket "..."      # skip the ladder: one ad-hoc ticket, then exit
bun start -- --demo              # throwaway read-only run against temp checkouts
bun start -- --no-tui --json     # machine-readable, for scripts
bun start -- --help              # the full option + env reference
```

- **Default (ladder mode)** — read `LADDER.md`, build the first unchecked
  subticket via `runHarness`, check its box, repeat; when nothing is pending,
  run a fresh planner session to append the next milestone. Pauses after
  `MAX_MILESTONES` (2) built milestones — always finishing the rung it is on,
  never stopping mid-milestone — so a human reconfirms the direction.
  Re-running resumes from the first unchecked box — everything is resumable.
- **`--unbounded`** lifts that cap (the loop then never returns on its own).
- **`--plan-only`** runs `planAhead` instead: plans milestone after milestone
  onto the ladder without ever invoking the harness, so several rungs can be
  reviewed before runs are spent on them. Same cap, also liftable with
  `--unbounded`. A later bare `bun start` builds everything queued this way.
- **`--ticket "..."`** is the escape hatch for debugging the harness itself
  (does `docker exec` work, does the transcript get copied) without invoking
  the planner or touching the ladder. It is not how the experiment runs.
- **`--demo`** is `--ticket` against two throwaway temp dirs, read-only and
  single-attempt — exercises the plumbing with no experiment repos configured.
  It is explicit now; there is no silent fallback when the repo env is missing.
  Alone among the modes it **does not close its own view**: when the arms
  settle the TUI stays on the final frame (footer reads `run finished`) until
  `q`, because a demo you cannot look at is not a demo. The summary still
  prints once you quit.
- **`--tui` / `--no-tui`** force the live view (default: on when stdout is a
  TTY). The live view is fullscreen and tabbed: an **overview** of every arm, a
  tab **per arm** with its context meter, activity trail and answer, Greg's
  **ladder** notes, and the raw **log**. `↹`/`←→` or `1`-`9` switch tabs, `↑↓`
  scroll the list tabs, `q` quits — the **view**, not the run: the sessions keep
  working and the CLI says so, naming what is still running. `--abort-on-quit`
  makes `q` (and Ctrl-C) tear the run down instead, aborting every live session
  and exiting 1; it is rejected up front with `--no-tui`/`--json`, where there
  would be no view to quit. It runs on the alternate screen and gives the
  terminal back on exit, so the closing summary is what survives. Every mode
  writes one `results/live-<ts>/<arm>/progress.log` per arm either way.
- **`--json`** prints the machine-readable result and implies `--no-tui`.
- Exit code is **1** whenever an arm exhausts its retries or the run throws, in
  every mode — the watchable path and the scriptable path are the same path.
- Conflicting combinations (`--ticket` with `--plan-only` or `--unbounded`)
  fail up front rather than silently ignoring a flag.

### Check, test, build

```bash
bun run check                  # typecheck only (tsc --noEmit, whole project)
bun test                       # all tests in test/
bun test test/config.test.ts   # single test file
bun test --test-name-pattern "watchdog"   # single test by name substring
bun run build                  # emit dist/ via tsconfig.build.json
```

`check` covers `src/` and `test/`; `build` compiles only what
`tsconfig.build.json` includes. Neither spawns Codex or Docker.

### Shell scripts

```bash
docker build -t vivarium-arm .   # build the arm image once
scripts/arm-run.sh control       # start the control arm's container from .env
scripts/arm-run.sh greptile      # same, for the greptile arm
scripts/mirror_sync.sh           # replay Komodo's main-states into the review mirror
scripts/mirror_sync_test.sh      # offline tests for mirror_sync.sh
scripts/resume-clean.sh          # report what an interrupted climb left behind
scripts/resume-clean.sh --apply  # …and reset both arms to the same baseline
```

`arm-run.sh` is the per-arm container launcher (details below).
`mirror_sync.sh` is the review-mirror pipeline — it materializes each successive
`vivarium-komodo` main-state as its own PR in a private mirror so Greptile reviews it
before merge, strictly one open PR at a time. It normally runs from
`.github/workflows/mirror-sync.yml`, not by hand, and needs two fine-grained
PATs (see `SETUP.md`). `mirror_sync_test.sh` exercises its local git logic
against throwaway bare repos with a `gh` stub — no network, safe to run anytime.
`resume-clean.sh` is the preflight for resuming an interrupted climb (below).

Runtime is **Bun** (not Node) — use `bun`, not `npm`/`node`. Source is authored
in ESM TypeScript/TSX but imports use `.js` specifiers (NodeNext resolution),
so keep writing `./foo.js` in imports even though the file is `foo.ts`. Bun
auto-loads `.env`, which is how arm config and `LINEAR_API_KEY` reach every
command above.

## Container setup (standard path for real runs)

All arm configuration lives in `.env` (`<ARM>_REPO`, `<ARM>_CONTAINER`,
`<ARM>_GH_TOKEN`, optionally `<ARM>_CODEX_HOME` / `<ARM>_WORKSPACE`). Both the
harness and `scripts/arm-run.sh` read it — nothing is passed on the command line.
Run-wide knobs live there too: `CODEX_SANDBOX` (unset gives a containerized
arm `danger-full-access` — it has to push, open a PR and answer a review, and
the container is the boundary — and a host arm `workspace-write`),
`GREPTILE_BOT_LOGIN` / `REVIEW_TIMEOUT_MS` / `REVIEW_ROUNDS` for the review
phase, `CODEX_HOME`, `IDLE_TIMEOUT_MS` (watchdog, default `600000`, `0` disables), and
`LINEAR_API_KEY` for the `linear` MCP server Greg's planner files tickets
through. See `.env.example` for the annotated list.

```bash
docker build -t vivarium-arm .
scripts/arm-run.sh control    # reads CONTROL_* from .env
scripts/arm-run.sh greptile   # reads GREPTILE_* from .env
```

`arm-run.sh` sources `.env` (override with `ENV_FILE`), resolves the arm's
`<ARM>_*` vars via bash indirect expansion, starts a detached container that
mounts only that arm's checkout at `/workspace` and `~/.codex/auth.json`
read-only, and passes `<ARM>_GH_TOKEN` in as `GH_TOKEN`/`GITHUB_TOKEN`. The
container idles (`sleep infinity`) so the harness can `docker exec` a fresh
`codex mcp-server` per attempt. Set `CONTROL_CONTAINER`/`GREPTILE_CONTAINER` and
the harness routes each arm through `docker exec` automatically; leaving them
unset runs both arms directly on the host with **no isolation** — only
acceptable for a throwaway smoke test.

The container's `CODEX_HOME` is `/codex`, so Codex writes transcripts to
`/codex/sessions` *inside* the container. `arm-run.sh` bind-mounts that back to a
per-arm host dir (`<ARM>_CODEX_HOME`, default `~/.vivarium/<container>`), and
each arm's `config.codexHome` defaults to the same value so
`RunArtifacts.finishArm` can find and copy the transcript. Both sides read the
same `<ARM>_CODEX_HOME`, so they stay in sync; a mismatch would leave transcripts
`not-found`.

## Architecture

The pipeline is `config → prompt → harness → (per-arm streaming) → artifacts`,
with the live view tapping the same event stream.

- **`src/config.ts`** — turns `--ticket` + env into a validated `HarnessConfig`.
  `parseArgs` reads env (repos, containers, sandbox, attempts, timeout);
  `validateConfig` canonicalizes both repo paths with `realpath` and **rejects
  two checkouts that resolve to the same directory**. An arm gains `container`
  (+ optional `workspace`, default `/workspace`) when its `*_CONTAINER` var is
  set; that flag is what flips host vs. container execution downstream.

- **`src/prompt.ts`** — `workerPrompt(ticket)` builds the single autonomous
  worker instruction, and it asks for a branch, a pushed commit, a pull request
  opened with `gh`, and a closing `PR: <url>` line. Both arms get the
  *identical* worker prompt; keep it that way — divergence there would confound
  the experiment. `reviewPrompt(url, round, rounds)` is the one instruction only
  the reviewed arm ever sees: it names the pull request and tells the arm to
  **fetch its own review** and reply to every comment. The comments are
  deliberately not pasted in — what the arm chooses to read is part of what is
  being observed.

- **`src/github.ts`** — everything the harness does to git and GitHub *outside*
  Codex, bound per arm (`armGitHub(arm, exec)` → `ArmGitHub`) so a caller never
  passes a repo or a token around: `syncToBaseline` (fetch + `checkout -f -B`
  onto origin's default branch — untracked files survive, so `node_modules` and
  the mounted ladder are not collateral), `findPullRequest` (by the URL the arm
  reported, falling back to its branch), `conversation` (reviews + issue
  comments + inline review comments, merged chronologically), and `merge`. A
  token, when present, reaches git through a one-shot credential helper so it
  never lands in a remote URL. The whole interface is injected in tests — the
  suite touches neither git nor `gh`.

- **`src/land.ts`** — what happens to an arm's work *after* its session says it
  is done, and the piece that makes this an experiment rather than two agents
  writing into the void. `prepareArm` puts the checkout back on the shared
  baseline before a subticket starts; `landArm` finds the pull request, runs the
  review rounds, and merges. Both arms take the identical path: the reviewed
  arm's extra rounds come from `arm.reviewer` being set in config, never from a
  name check here. A round waits for something new from that login, hands the
  arm a `reviewPrompt` on **its own Codex thread**, and repeats up to
  `reviewRounds`; a review that never arrives merges unreviewed after
  `reviewTimeoutMs` rather than holding the climb, and the timeout is recorded
  as the round's outcome. `landingError` is the rule that a subticket's
  deliverable is a *merged pull request*: a session that opened none, or whose
  merge failed, becomes a failed arm however cheerfully it reported itself —
  which halts Greg and leaves the box unchecked.

- **`src/harness.ts`** — the orchestrator, and the run is now three phases:
  **prepare** (both checkouts synced to origin's default branch, sequentially,
  before either session starts — so a sync failure costs nothing already in
  flight, and every subticket begins where the last one merged), **build** (both
  arms concurrently with `Promise.all`), **land** (`landArm` per arm, on the
  same thread and the same event sinks, so the live view keeps watching one
  continuous arm through the review wait). Watchers are grouped in
  `HarnessSinks` (`onEvent`, `onArmComplete`, `onArmNote`, `onLanding`) and the
  outside world in `HarnessDeps` (`runner`, `github`, `wait`, `now`) — the
  landing phase is testable without git, `gh`, or a clock. `armExecution` is the
  single place host-vs-container execution and the arm's sandbox are decided, so
  the build attempts and the review rounds cannot drift apart. `runArm` owns the
  **retry loop**
  (`maxAttempts`, default 3): on failure it re-invokes with a `retryPrompt`,
  continuing the *same Codex thread* via `codex-reply` when a `threadId` exists,
  otherwise restarting fresh with the recovery context prepended to the original
  task. In container mode it prepends `["docker","exec","-i","-w",workspace,
  container]` as the exec prefix and points Codex's cwd at the in-container
  workspace. `runner` (the arm launcher) and the two event sinks are injected —
  tests pass a fake runner instead of spawning real Codex. An optional
  `AbortSignal` (from `--abort-on-quit`) is checked **between attempts** as well
  as handed to the session: aborting only the attempt in flight would hand
  straight back to the retry loop, which would immediately start another one —
  the opposite of stopping. In `stream.ts` that signal joins the *same*
  controller the watchdog uses, so there is one teardown path and the MCP
  client's `close()` kills the codex subprocess instead of orphaning it.

- **`src/live/stream.ts`** — `runArmStreaming` runs one Codex session over its
  own stdio MCP client. Three things to preserve: (1) it registers a
  `codex/event` notification handler so events are observable live (this is what
  feeds both the TUI and the watchdog) rather than discarded; (2) an **activity
  watchdog** aborts an arm after `idleTimeoutMs` of event silence (default 10m),
  independent of the 24h hard ceiling; (3) every fresh session is started with
  **`config: {features: {apps: false, plugins: false}}`** (`codexToolArguments`,
  the one pure, tested part of this module) — no ambient account tooling, in
  either arm or in Greg. `codex_apps` connectors (Linear, GitHub) are
  *account*-scoped and arrive via `$CODEX_HOME/auth.json` alone, which
  `arm-run.sh` mounts into every container, so an arm would otherwise read the
  experiment's own Linear board and reach the account's GitHub from inside its
  "isolated" checkout, around its per-arm `GH_TOKEN`; neither a bare
  `CODEX_HOME` nor a second auth file for the same account withholds them.
  Plugins are whatever the operator has installed (greptile,
  `github@openai-curated`, the bundled set) — an uncontrolled variable, and
  tools Greg's plan is meant to be blind to. Configured `mcp_servers` are
  deliberately **left alone**: explicit deployment config, not ambient state.
  The override must be set in the **tool call**: on the `mcp-server` path
  `--disable apps` and `-c features.apps=false` on the argv are silently
  ignored (they work for `codex exec` — that is the trap). When an `exec`
  prefix is present it spawns
  `docker exec … codex mcp-server` and does **not** anchor the host spawn cwd
  (the cwd is an in-container path).

- **`src/artifacts.ts`** — `RunArtifacts` owns the on-disk record under
  `results/<run-id>/`. Every write goes through `atomicWrite` (temp file +
  `rename`). The top-level `manifest.json` (`schemaVersion: 3`) is the source of
  truth for run status; manifest writes are **serialized through a promise
  chain** (`manifestWrite`) that swallows its own errors so one failed write
  can't poison later ones. After an arm finishes it locates that arm's Codex
  transcript under **that arm's** codex home (`arm.codexHome ?? config.codexHome`
  — see the container note above) `/sessions` by matching the `threadId` suffix
  and copies it in (`transcriptStatus` records copied / not-found / no-thread-id).
  `recordBaselines` writes the commit each arm started from (they should match;
  when they do not, that *is* the finding). `recordLanding` writes
  `<arm>/land.json` — pull request, every review round with what the reviewer
  said and what the arm answered, the merge — replaces the arm's final result
  (a session that opened no pull request is a failed arm), and **re-copies the
  transcript**, because the review rounds are more turns on the same thread and
  the first copy stops short of them.

- **`src/index.ts`** — the single entrypoint. Dispatches to either the ladder
  loop (default) or a one-ticket run, owns the `results/live-<ts>/` log
  directory and the exit code, and owns no run logic of its own. Flag resolution
  lives in `config.ts` as `parseRunMode` (pure, and tested in
  `test/config.test.ts`) — combinations that could only be honoured by ignoring
  a flag the caller typed throw instead.

- **`src/live/`** — the live view. `attach.ts` is the shared sink wiring
  (`attachLive`): it updates the store, tees a readable line into **that arm's
  own** `progress.log` through a serialized write chain, mirrors that line to
  the TUI's log tab, and echoes to stdout when no TUI is mounted — **both** run
  modes go through it, so a change to the feed can't drift between them. One
  file per arm (`live-<ts>/<arm>/progress.log`, plus `ladder.log` for the
  climb's own lines): one combined file read fine live, where the label column
  tells the arms apart, but the artifact is a *pair* of independent builds and
  reading one arm's three-hour run meant grepping the other one out of every
  line first. The interleaved view survives where it belongs — in the log tab.
  `store.ts` reduces raw `codex/event` messages into per-arm `ArmState`, plus
  `note()` for landing progress (waiting on a review is the arm working with
  its session idle, and it belongs on the same activity trail);
  `model.ts` is `LiveModel`, the one view model **both** run modes render from
  (arms, a subtitle, notes, the mirrored log, and the merged pull requests per
  arm — those live on the model, not the store, because the store is cleared
  between phases and merged pull requests are exactly what should accumulate
  across them). `quit.ts` owns what closing the
  view means — `quitNotice` is pure, and `onViewClosed` is the shared hook both
  modes hand to `mountLive`. It decides from the **model**, not the keypress,
  so the ordinary end-of-run unmount stays silent while an early quit names
  what is still running. `run.tsx` is the one-ticket run.
  The live view and the durable artifacts come from the **same single run** —
  watching is a display choice, never a second execution path.

- **`src/live/tui/`** — the fullscreen view. It takes over the terminal via the
  alternate screen buffer (`fullscreen.ts`) and hands it back on exit, so the
  run's frames never bury the user's scrollback and the closing summary always
  prints to the normal buffer. The restore is bound to Ink's exit at **mount**
  (`restoreOnExit`), not to the caller's `await`: callers only await once the
  run is over, but `q` can end the view hours earlier, and binding it late
  stranded the terminal on the alternate screen with a hidden cursor for the
  rest of the run. `app.tsx` is the shell: header, tab strip, body,
  key handling. `tabs.ts` is the pure tab logic, keyed on **stable ids, never
  indices** — Greg swaps which sessions are live between phases, so the tab list
  changes shape mid-run; a future tab (a recent-PR list) slots into `tabsFor`
  and nothing else changes. `panes.tsx` holds the panes: `Overview` (one calm
  card per arm), `ArmDetail` (one arm in full — context meter, the pull
  requests it has merged with their GitHub links, activity trail, answer),
  `Feed` (tail-following list, used by both the notes and log tabs). The pull
  request rows are budgeted *before* the answer and print the URL whole,
  truncating the title instead: those rows exist to be opened, and a truncated
  link is not a link.
  Every pane is told its height and **budgets its rows explicitly**: Ink resolves
  overflow by drawing rows on top of each other rather than scrolling, so a pane
  drops a section instead of nearly fitting. `wrapLines` in `format.ts` exists
  for the same reason — a block has to know its real height before it renders,
  and so does `scroll.ts`, the pure scrollback logic behind `Feed`: it hands out
  `height - 1` content rows because the status row at the bottom is permanent,
  bounds a scroll to the buffer, and parks the view on a **line id** rather than
  a distance from the end, so arriving events cannot drag the text a human is
  reading out from under them.

- **`src/greg/`** — the planner loop that sits *above* the harness.
  `ladder.ts` owns `LADDER.md`: parsing `### [ ] 1.2 Title — ENG-12` checkbox
  headings into subtickets, flipping a box to `[x]` with a run-outcome line, and
  symlinking the ladder into both checkouts (the local stand-in for the bind
  mount). `planner.ts` builds the stateless planner prompt — the ladder text is
  the *only* context Greg gets, he cannot see the builders' code — and runs a
  fresh session (never a continued thread) with `PLANNER_ATTEMPTS` retries for
  transient session failures. `loop.ts` is the todo-runner: `runGreg` builds the
  next unchecked subticket and **halts on any failure, leaving the box
  unchecked**, so a broken rung can never look built; `planAhead` is the
  `--plan-only` variant that plans without building. `main.tsx` wires the loop's
  injectable deps to the live view, reusing `attachLive`, `LiveModel` and the
  TUI from `src/live/` — Greg adds only a "ladder" notes tab and a phase per
  milestone. The ladder file **is** the state — no JSON hand-off, nothing to
  drift.

## Run statuses

`completed` (both arms succeeded) · `completed_with_failures` (an arm exhausted
its retries, **or landed nothing** — process exits 1) · `failed` (the harness
itself threw). These appear in both the CLI JSON result and `manifest.json`.

Succeeding means landing: an arm whose session ended cheerfully but opened no
pull request, or whose pull request could not be merged, is a failed arm
(`land.json` says which, as `no-pull-request` or `merge-failed`). The ladder
halts and leaves the box unchecked — a rung that did not land must not look
built.

## Resuming an interrupted climb

The ladder resumes on its own. A subticket's box is only checked **after** its
run succeeded, so a machine that dies mid-run leaves the box `[ ]` and the next
`bun start` retries it. Nothing else is checkpointed — in particular the arm's
Codex `threadId` is written into `status.json` but never read back, so the
interrupted subticket restarts from attempt 1 on a fresh thread. Subtickets are
one PR-sized step, which is what makes that affordable.

What does *not* reset is the arms' checkouts, and that is the part worth
handling. `runHarness` runs both arms concurrently, so a crash after one arm
pushed and before the other did leaves the box unchecked while one arm's work
already sits in its checkout. The retry then replays both arms against it: the
arm that already finished re-solves a solved ticket in seconds and "wins", and
the manifest records two clean successes. The rung's A/B comparison is silently
worthless, which is worse than losing it loudly.

So the preflight is symmetric — both arms back to the same baseline, or
neither:

```bash
scripts/resume-clean.sh                     # report only; changes nothing
scripts/resume-clean.sh --apply             # reset both arms to origin/main
scripts/resume-clean.sh --apply --reconcile-linear
```

It never touches `main` beyond fast-forwarding to `origin/main` — main is the
accumulated climb. Work that already **merged** is reported, not discarded,
with a warning: if the crash beat the checkbox, check that box by hand or the
next run builds it twice. On a clean shutdown the whole thing is a no-op, so it
can sit unconditionally in front of `bun start` in a systemd unit.

`--reconcile-linear` runs `src/greg/reconcile.ts`, which fixes the two ways
Linear drifts from the ladder (neither self-heals, and neither affects the
build — ids are bookkeeping): an issue left open because the crash landed
between `completeSubticket` and `close`, and subtickets left unstamped because
it landed inside the filer, which only ever runs right after planning. It reads
the ladder — still the only source of truth — and makes Linear agree. Unlike
the close inside the climb, this pass **fails open**: the drift has already
happened and this exists to shrink it, so one unreachable issue must not
abandon the rest. Re-running finishes whatever was left.

## Artifact layout

```
results/<run-id>/
  manifest.json ticket.txt prompt.txt config.json baselines.json
  greptile/land.json          # pull request, review rounds, conversation, merge
  greptile/attempt-01/  request.json status.json response.json output.txt
                        error.txt transcript.jsonl
  control/land.json     ...
  control/attempt-01/   ...
results/live-<ts>/
  greptile/progress.log       # one feed per arm, written by the live view
  control/progress.log
  greg/progress.log           # the planner session, when there is one
  ladder.log                  # the climb's own lines
```

`land.json` is the close-reading input the experiment is for: the reviewer's
findings and the arm's answers to them, in one chronological list per pull
request, beside the transcript of the session that wrote both.

`LADDER.md` sits at the repo root, outside `results/` — it is Greg's durable
state across runs (North Star, every milestone, every subticket and its
outcome), symlinked into both checkouts so the builders can see it.

## Testing notes

Tests inject a fake `AttemptRunner` into `runArm`/`runHarness` — no real Codex
process or container is spawned, so the suite runs offline. When changing the
retry/threading logic in `harness.ts` or the artifact schema in `artifacts.ts`,
update `test/harness.test.ts` / `test/artifacts.test.ts` accordingly.

The landing phase is faked the same way, one level out: `test/land.test.ts`
injects an `ArmGitHub` that answers from a script (including "the review arrives
on the third poll") plus a fake clock, and `test/harness-land.test.ts` drives a
whole `runHarness` with both fakes to check the artifacts it leaves behind.
Nothing in the suite runs `git`, `gh`, Docker, or Linear.

Greg's tests do the same one level up: `greg-loop.test.ts` injects fake `plan` /
`harness` / `log` deps (`GregDeps`) and a temp ladder path, `greg-ladder.test.ts`
covers the markdown parse/complete/link logic, and `greg-planner.test.ts` fakes
the runner to check the prompt and the "did Greg actually append milestone N"
guard, and `greg-reconcile.test.ts` fakes the filer/closer to check what a
half-filed, half-closed ladder asks Linear for — and that one failure does not
abandon the rest of the pass. Nothing in the suite touches Docker, Linear, or
the real `LADDER.md`.

`live-fullscreen.test.ts` covers the terminal handoff without rendering Ink:
`restoreOnExit` is the pure lifecycle seam, so the regression it pins (the
terminal coming back when the *view* exits, not when the caller finally awaits)
is a plain promise-ordering test. `live-quit.test.ts` does the same for what
quitting means — `quitNotice` is pure, and `onViewClosed` is checked against a
real `LiveModel` with stdout spied. The matching harness-side guarantee lives
in `harness.test.ts`: an aborted arm must record one failed attempt, **not**
spend its remaining retries.
