# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` points here,
so Claude Code and Codex read the same file — the instructions should never
fork by which agent happens to be running.

## What this is

An A/B harness that runs the **same ticket through two Codex workers at
once** — **Tuatara** (the Greptile-enabled checkout) and **Komodo** (the plain
checkout) — and durably records everything each one did, so the two outcomes
can be compared. Tuatara is presented first in human-facing output. `tuatara`
and `komodo` are the identifiers everywhere — env vars (`TUATARA_*`,
`KOMODO_*`), artifact directories, and the code — with no second vocabulary to
translate through. The only
per-run input is `--ticket`; which two checkouts run, and whether they're
isolated in containers, is deployment configuration set once in `.env`, never
per ticket.

Each arm drives a real Codex session over MCP (`codex mcp-server`, stdio
transport). For real runs each arm's Codex runs inside its own Docker container
so it cannot see the other arm's checkout. Greg's fresh planning attempts run
in ephemeral containers containing only a scratch ladder. The harness itself
always runs on the host and orchestrates them.

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
- **`--ticket "..."`** is the escape hatch for exercising the harness itself
  (does `docker exec` work, does the transcript get copied) without invoking
  the planner or touching the ladder. It is not how the experiment runs — it
  exists so harness debugging never has to write a throwaway milestone into
  `LADDER.md`, which is part of the published record.
- **`--tui` / `--no-tui`** force the live view (default: on when stdout is a
  TTY). The live view is fullscreen and tabbed: an **overview** of every arm, a
  tab **per arm** with its context meter, recent activity and answer, the
  **climb** (every rung built, with both arms' pull requests, the rung in
  flight, and the next few), and the raw **log**. `↹`/`←→` or `1`-`9` switch tabs, `↑↓`
  scroll the list tabs. Each arm's duration excludes time spent idle at the
  merge barrier waiting only for its peer, so the two A/B timings do not
  collapse into the shared run duration. `q` quits — and quitting **stops the
  run**. The in-view confirmation offers `y` to stop immediately, `n` to keep
  watching, and, during a climb, `S` to finish every subticket in the current
  rung and stop before the next one; once everything has settled the view is a report and closes
  without asking. Ctrl-C stops the run without asking — it has one meaning
  everywhere else and does not acquire a second one here. Stopping live
  sessions exits 1. It runs on the alternate screen and gives the
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
scripts/mirror_sync.sh           # replay Komodo's main-states into the review mirror
scripts/resume-clean.sh          # report what an interrupted climb left behind
scripts/resume-clean.sh --apply  # …and destroy those leftover environments
```

`arm-run.sh` is the harness-internal per-arm container launcher (details below);
`arm-init.sh`
and `arm-browser.sh` run *inside* that container — the first is its entrypoint
payload (dockerd + the GUI), the second is installed as `browser`.
`mirror_sync.sh` is the review-mirror pipeline — it materializes each successive
`vivarium-komodo` main-state as its own PR in a private mirror so Greptile reviews it
before merge, strictly one open PR at a time. It normally runs from
`.github/workflows/mirror-sync.yml`, not by hand, and its credentials are the
`vivarium-mirror` GitHub App (mirror-side writes, so they are attributed to
`vivarium-mirror[bot]` and not a human) plus one org-scoped fine-grained PAT for
reading Komodo and moving the state variable — `docs/mirror-sync.md` is the
runbook for creating both. `test/mirror-sync.test.ts` exercises its local git
logic against throwaway bare repos with a `gh` stub — no network, and included
in the normal `bun test` suite.
`resume-clean.sh` is the preflight for resuming an interrupted climb (below).

Runtime is **Bun** (not Node) — use `bun`, not `npm`/`node`. Source is authored
in ESM TypeScript/TSX but imports use `.js` specifiers (NodeNext resolution),
so keep writing `./foo.js` in imports even though the file is `foo.ts`. Bun
auto-loads `.env`, which is how arm config reaches every command above.

## Container setup (standard path for real runs)

All arm configuration lives in `.env` (`<ARM>_REPO`, `<ARM>_CONTAINER`,
`<ARM>_GH_TOKEN`). Both the
harness and `scripts/arm-run.sh` read it — nothing is passed on the command line.
Run-wide knobs live there too: `CODEX_SANDBOX` (unset gives a containerized
arm `danger-full-access` — it has to push, open a PR and answer a review, and
the container is the boundary — and a host arm `workspace-write`),
`REVIEW_TIMEOUT_MS` / `REVIEW_ROUNDS` for the review phase, `CODEX_HOME`, and
`IDLE_TIMEOUT_MS` (watchdog, default `240000`, `0` disables). The image,
nested Docker, GUI, screen geometry, noVNC ports, and reviewer identity are
fixed experiment constants rather than deployment knobs. See `.env.example`
for the annotated list.

```bash
docker build -t vivarium-arm .
bun start                     # the harness creates the arm environments
```

Each `runHarness` call is one subticket and owns two fresh environments.
`environment.ts` derives unique runtime names from the configured
`<ARM>_CONTAINER` prefixes, calls `arm-run.sh` for both arms, and destroys their
containers, nested-Docker volumes, and networks in a `finally` block after
landing. `arm-run.sh` sources `.env`, starts one detached container, clones that
arm's HTTPS `<ARM>_REPO` URL into its private `/workspace`, mounts only
`~/.codex/auth.json` and the ladder read-only, and passes `<ARM>_GH_TOKEN` as
`GH_TOKEN`/`GITHUB_TOKEN`. The URL never contains credentials; the image's
GitHub CLI credential helper reads the token from the container environment.
No checkout, browser profile, Docker cache, dependency directory, or Codex
session survives into the next subticket. The container remains alive only
within one subticket so retries and review rounds keep the same checkout and
Codex thread, as `retryPrompt` promises. Leaving both container prefixes unset
runs both arms directly on the host with **no isolation** — only acceptable for
a throwaway smoke test.

When both arms are containerized, Greg also uses the fixed `vivarium-arm`
image but gets a new `docker run --rm` container per planning
attempt—not either arm's subticket container. It mounts only the temporary
ladder workspace, Codex auth read-only, and a fresh empty session sink; the
harness copies that attempt's transcript into the host Codex home only after
the container exits. Nested Docker and the GUI are disabled. With both arm
containers unset, Greg retains the host `workspace-write` smoke-test path.

It also starts the two services the arm's *own* work needs, both of which live
in `scripts/arm-init.sh`, the image's entrypoint payload. Neither is per-arm
configuration — they are fixed parts of the controlled environment, identical
in both arms. Only Greg's internal planner launch disables them, because its
scratch ladder needs neither:

- **A Docker engine of the arm's own** (`dockerd`, nested), so `docker build`,
  `docker run` and container-based tests work inside the arm. It is emphatically
  **not** the host's `/var/run/docker.sock` bind-mounted in, which is the usual
  shortcut and is unavailable here: that socket *is* the host daemon, so an arm
  holding it needs one `docker run -v /:/host` to read the other arm's checkout,
  `.env` with both arms' tokens, and every transcript under `results/` — the
  isolation the experiment rests on, gone, with the manifest still recording a
  normal run. It would also put both arms' containers in one namespace where
  each can see the other exists. The price is `--privileged` and a few seconds
  of startup. `/var/lib/docker` must be a volume — the container's rootfs is
  overlayfs and overlay2 will not stack on it — so `environment.ts` names one
  fresh volume per arm and subticket (`<runtime-container>-docker`) and removes
  it at teardown. There is deliberately no warm image cache to leak work from
  one subticket into the next.
- **A screen with a browser on it.** Xvfb on `:99` (the image sets `DISPLAY`),
  fluxbox to place and focus windows, chromium, and x11vnc + noVNC putting that
  screen on a port. The arms build a web application, and until now anything
  that had to be *looked at* could only be reasoned about and handed to CI.
  `arm-run.sh` publishes noVNC on the fixed host ports
  `127.0.0.1:6080/6081` (Komodo/Tuatara) —
  loopback only, because x11vnc runs with no password and the port is a live
  view of a root browser session. The host ports differ per arm because two
  containers cannot share one; inside the container both are `:99` on 6080, so
  nothing an arm can observe differs. `scripts/arm-browser.sh` is installed as
  `browser`: it keeps **one** chromium on **one** profile for that subticket and prints
  the DevTools endpoint (`http://127.0.0.1:9222`), which is the part a script
  can act on — a bare `chromium <url>` returns nothing usable and a second
  invocation on a different profile dir starts an unrelated second browser.
  `prompts.ts` tells the arm all of this, and that text is the only way it finds
  out: `docker` on PATH says nothing about whose daemon it is, and an X server
  nobody mentions is one the arm never draws on.

`arm-run.sh` blocks until both services report ready (`/run/vivarium/ready`)
before it prints success, and dumps `/var/log/vivarium/*.log` and exits 1 if
they do not. A container that comes up degraded stays up rather than dying, so
`--rm` does not delete the evidence — but the harness must never exec a
subticket into it, because an arm discovers a missing engine halfway through,
after the work is done.

Two more things it sets up, both of which the arm only discovers it needs
halfway through a subticket, after the work is done:

- **A git identity.** It asks GitHub who `<ARM>_GH_TOKEN` belongs to and commits
  as that account (`<id>+<login>@users.noreply.github.com`), so every line on
  main is attributed to the arm that wrote it rather than to nobody. With no
  network it falls back to the arm's display name, which still tells
  the two apart locally. The image carries a last-resort identity too, because
  `git commit` will not guess one. It also sets `safe.directory` defensively and
  a credential helper that resolves `GH_TOKEN` at clone/fetch/push time, so the
  token never reaches a remote URL or argv.
- **The ladder.** `arm-run.sh` gives the private clone a read-only view of the
  real file: the launcher pre-creates it when necessary, bind-mounts it at
  `/vivarium/LADDER.md`, and after cloning
  the launcher symlinks it into `/workspace/LADDER.md`. Greg writes the ladder
  in place rather than through a rename, so the mount keeps showing current
  text instead of pinning the inode it started on.

The container's `CODEX_HOME` is `/codex`, so Codex writes transcripts to
`/codex/sessions` in the ephemeral writable layer. Nothing mounts that
directory. `environment.ts` finds the current thread by id and uses `docker cp`
to export it into the attempt artifact after the build and again after review;
only then does teardown remove the container. Export is evidence collection,
not arm execution: a failed find/copy is recorded as `copy-failed` (or
`partial` when the earlier build-time copy survives) and never retries
successful work or prevents a ready pull request from landing. Refreshes copy
to a sibling staging file and atomically rename it into place only on success,
so a partial `docker cp` cannot corrupt the earlier durable copy. Thus
transcripts are outputs, not historical input visible to a later arm.

## Architecture

The pipeline is `config → prompt → harness → (per-arm streaming) → artifacts`,
with the live view tapping the same event stream.

Those three stages are three directories, and `src/` itself holds only the
entrypoint and the two run-mode wirings:

```
src/index.ts climb.ts ticket.ts   # entrypoint + the two run-mode wirings
src/harness/                      # running one ticket through both arms, and landing it
src/greg-tile/                    # the planner loop above the harness
src/view/                         # the live view watching it
```

`harness/` is the layer the other two are defined against — `greg-tile/` calls
into it and `view/` watches what it emits, while it imports from neither. Its
own modules are siblings, so they refer to each other by bare `./name.js`; a
cross-layer import is always visible as a `../harness/` in the specifier.

- **`src/harness/config.ts`** — turns `--ticket` + env into a validated `HarnessConfig`.
  `parseArgs` reads env (repos, containers, sandbox, attempts, timeout);
  for container deployments `validateConfig` requires two distinct plain HTTPS
  GitHub clone URLs, while the host smoke path canonicalizes local repo paths
  with `realpath` and rejects two paths resolving to the same directory. An arm gains `container`
  when its `*_CONTAINER` var is set; its value is a stable name prefix and that
  flag is what flips host vs. container
  execution downstream — and `validateConfig` **rejects a mixed configuration**,
  because one unset variable would otherwise leave one arm on the host at
  `workspace-write` while the other runs in a container at
  `danger-full-access`: different sandbox, different tool reach, and the
  host-mode arm able to read the other arm's checkout and `.env` directly, all
  recorded as a perfectly normal run. The in-container workspace is the fixed
  `/workspace`, not config: `arm-run.sh` clones there, so a configurable cwd
  could only ever name a path that isn't the checkout.

- **`src/harness/prompts.ts`** — **every string a model ever sees**, and nothing else:
  the worker instruction, its retry, the review round, and Greg's planning turn.
  Prompts are the experiment's independent variable, so they live where one read
  audits them all rather than in the four modules that happen to send them; the
  module imports nothing, which is what lets `plannerPrompt` sit here without
  inverting the `greg-tile/` → harness dependency. `TOOLCHAIN` is the one text
  shared by the worker instruction and both review rounds — every message that
  can arrive as an arm's *first* — and it is a **description of the image**:
  change the `Dockerfile` and change it here too, or the arm never learns what
  it gained. The two capabilities it cannot find by looking around are named
  explicitly — `docker` is the arm's *own* nested daemon, not the host's, and
  `$DISPLAY` is a real screen reachable with `browser`. No test asserts what
  any of this text *says* — prompt wording is the experiment's dial and is
  rewritten freely, so pinning phrases would only manufacture churn.
  `workerPrompt(ticket)` builds
  the single autonomous
  worker instruction, and it asks for a branch, a pushed commit, a pull request
  opened with `gh`, and a closing `PR: <url>` line. It also fixes the pull
  request **title** as `[codex] <description>`: Greptile keys off that marker to
  treat a pull request as agent-authored, and `mirror_sync.sh` already forces it
  on every mirror PR, so without it here Komodo's counterfactual reviews would
  be collected in agent mode and Tuatara's in default mode — two review
  populations that cannot be compared. Both arms get the
  *identical* worker prompt; keep it that way — divergence there would confound
  the experiment. The pull request body must **open with the ticket** under an
  `## Original Ticket` heading, with every ticket heading demoted one level and
  a horizontal rule before the PR's own material: the reviewer opening it has
  no other way to see what was asked for. `mirror_sync.sh` carries the source PR's
  **whole description** into the mirror PR for the same reason — Greptile
  reviews the mirror, not Komodo, and Tuatara's reviewer is not handed an
  extract either. Whole body rather than the ticket section alone is also the
  only safe read: ticket bodies carry their own `## Objective`/`## Deliverable`
  headings, so anything that ends the section at the next `## ` captures the
  heading and nothing else. That read **fails closed** — a description the API
  will not hand over is retried and then fatal, because a mirror PR is written
  once and reviewed before anyone sees it, so shipping a blank one is
  unrecoverable while dying costs a rerun (nothing advanced; `write_state` runs
  only after a merge). `reviewPrompt(url, round, rounds)` is the one instruction only
  the reviewed arm ever sees: it names the pull request and tells the arm to
  **fetch its own review**. The comments are
  deliberately not pasted in — what the arm chooses to read is part of what is
  being observed. The obligation follows **comment shape, not round number**.
  A new root comment (no `in_reply_to_id`) must always receive an individual
  answer, whether it arrives in round one or after a later fix. A Greptile
  reply inside a thread the arm already answered is conversational: the arm
  may accept it and fix the code, state a final disagreement and stop replying
  in that thread, answer a new question, or say nothing to a restatement. A
  settled thread does not close review of the whole pull request; fixes can
  introduce fresh root findings elsewhere, and those still require answers.
  Both rounds also name the **inline** comment API (`gh api
  repos/{owner}/{repo}/pulls/{n}/comments`), because `gh pr view --comments`
  does not print inline comments and a thread reply is where the whole exchange
  lives after the first response — an arm told only about `--comments` watches its
  reviewer apparently fall silent and concludes it won. The mention rules are
  asymmetric and load-bearing: an in-diff thread reply must **not** mention
  `@greptileai` (Greptile reads its own threads unpinged, and a mention there
  makes it process the reply twice), while a PR-level comment — general
  questions not tied to one inline finding — **must** mention it, or Greptile
  never sees the comment at all. The arm does not
  declare the exchange closed in its answer: termination comes from the
  reviewer's next comment, a timeout with no new comment, or the configured
  round cap.
  `retryPrompt` is what `runArm` prepends on a failed attempt,
  and `plannerPrompt(ladder, n, file)` is Greg's whole turn — it carries
  `NORTH_STAR` and the subticket-shape rules, which makes the `### [ ] N.M`
  heading it dictates a contract with `greg-tile/ladder.ts`, the module that
  parses exactly what it asks Greg to write. Change one and change the other.

- **`src/harness/github.ts`** — everything the harness does to git and GitHub *outside*
  Codex, bound per arm (`armGitHub(arm, exec)` → `ArmGitHub`) so a caller never
  passes a repo or a token around: `syncToBaseline` (fetch + `checkout -f -B`
  onto origin's default branch, then `clean -fdx -e node_modules -e LADDER.md`
  — `checkout -f` only restores *tracked* files, so without the clean a scratch
  file one arm dropped rides into the next subticket while the other arm starts
  clean, which is an input differing between the arms in an experiment built on
  holding inputs constant. `-x` takes ignored files too — build output, caches,
  coverage — because the reviewed arm does strictly more work per rung (it
  re-runs its checks after answering a review) and would otherwise start the
  next subticket with warm caches the other arm lacks. The two `-e` excludes
  protect the only things `-x` must not take: `node_modules` and the mounted
  ladder),
  `findPullRequest` (by the URL the arm
  reported, falling back to its branch), `conversation` (reviews + issue
  comments + inline review comments + reactions, merged chronologically), and
  `merge`. Comment list responses expose reaction counts, so identities are
  fetched only for comments with a nonzero count rather than making one extra
  API call per historical comment on every poll. For containerized arms these
  deterministic operations run through `docker exec` inside that arm's private
  clone; host smoke tests run them directly in the local checkout. A
  token, when present, reaches git through a one-shot credential helper so it
  never lands in a remote URL. The whole interface is injected in tests — the
  suite touches neither git nor `gh`.

- **`src/harness/land.ts`** — what happens to an arm's work *after* its session says it
  is done, and the piece that makes this an experiment rather than two agents
  writing into the void. `prepareArm` puts the checkout back on the shared
  baseline before a subticket starts; `reviewArm` finds the pull request and
  runs the review rounds (all reversible — it never touches either main), and
  `mergeArm` performs the one irreversible step, with the harness holding a
  barrier between them. Both arms take the identical path: the reviewed
  arm's extra rounds come from `arm.reviewer` being set in config, never from a
  name check here. A round waits for something new from that login, hands the
  arm a `reviewPrompt` on **its own Codex thread**, and repeats up to
  `reviewRounds` (default 5) — a **maximum**, not a count. The cap sits well
  above where most pull requests settle because the later rounds are where a
  *disagreement* plays out — the arm pushing back, Greptile holding or
  conceding — which is the experiment's subject matter. The exchange ends on
  one of four bounded conditions:
    - **The reviewer's response is nothing but thumbs-up reactions.** GitHub
      exposes that structured reaction as `+1`, and Greptile attaches one to
      each arm reply it accepts — an ACK of that comment, **not** a verdict on
      the pull request: it hands them out while still replying in other
      threads. So only a batch that is *entirely* thumbs-up is recorded
      `signedOff`; any prose beside an ACK is handed to the arm. Review bodies
      and comments are never classified by their wording, and every other
      reaction is ignored.
    - **The arm's answer leaves no trace on the pull request.** The reviewer
      only ever responds to a ping — a pushed commit or a posted comment — and
      its thumbs-up is an ACK to one. An answer that pushed nothing and posted
      nothing (a clean review gives the arm nothing to fix and nothing to say)
      gave the reviewer nothing to react to, so waiting again could only end in
      the full timeout. The round is recorded `settled` and the exchange ends
      immediately. An unreadable post-answer check fails open to waiting —
      unknown must not end the exchange early.
    - …with one standing exception to both: **a pushed commit holds the
      exchange open.** Greptile re-reviews every push, and that pass lands
      minutes after its thread replies and ACKs do — reading the fast
      responses as the end merged PR #7 with a fresh P1 root finding forty
      seconds old and unanswered. After an answer that pushed (an unreadable
      sha pair counts as pushed), neither sign-off nor settling can end the
      exchange, and bare ACKs do not even surface as a round, until the pass
      shows up — a new root inline comment or a body-bearing review; the
      empty-bodied reviews GitHub wraps around inline replies prove nothing —
      or the reviewer stays silent for the full rolling window, the backstop
      for a pass that posts nothing.
    - **The reviewer has been silent for `reviewTimeoutMs`** (default 20
      minutes), and the round times out. The window is rolling — measured from
      the reviewer's last comment as the harness observed it, or from the start
      of the wait when there has been none — so it bounds total reviewer
      silence, not each round afresh: a round that starts after a long answer
      turn inherits the silence already on the clock. At least one poll always
      happens, so activity that landed during the answer turn is still found.
    - **The maximum is reached.** At most `reviewRounds` reviewer comments are
      handed back to the arm, so a disagreement cannot create an unbounded
      comment loop.
  Every reviewer event first passes through a 30-second quiet-period debounce.
  New entries reset the window, so a review body and the inline comments that
  become visible a few seconds later produce one arm prompt rather than one
  prompt each. A lone inline reply or reaction pays only that short window.
  Reactions are recorded but never sent to the arm as work.
  The prompt tells the arm to fetch the complete conversation, identify its
  own GitHub login, and treat a root as unanswered when its thread contains no
  reply from that login. The harness deliberately does not paste comment text;
  this thread-state check is how the arm finds missed roots without being told
  their contents.
  So a pull request that settles in one exchange costs one round, and the full
  wait is only ever paid for a reviewer that never shows: a
  review that never arrives merges unreviewed after
  `reviewTimeoutMs` rather than holding the climb, and the timeout is recorded
  as the round's outcome. The review wait also watches the run's abort signal —
  the same one quitting the live view fires — and an aborted wait is recorded
  as a failed round that refuses to merge, so a quit during "waiting for
  review" tears down now instead of sitting out the rest of the timeout. Each answered round pins the branch head on **both
  sides** (`reviewedSha`, `respondedSha`). `reviewedSha` is captured before the
  arm can touch the ref: an amend or force-push makes the reviewed commits
  unreachable and GitHub marks the inline comments outdated, which would erase
  the one diff showing what the review changed — and a sha stays fetchable long
  after the ref moves. The pair also says, with no text analysis at all, whether
  the arm pushed a fix or only argued. `headSha` is the one method in
  `github.ts` that retries, and the only one with a **second source**: when the
  API keeps refusing it asks the git remote (`git ls-remote`) instead. The same
  fact is published over two protocols with two quotas, and unlike every other
  call here this one cannot be re-read tomorrow — the arm will have pushed over
  it. If both refuse, the round is still recorded, with a note naming the
  missing side: an absent field otherwise reads identically to a run made
  before these existed, and an analysis would score the gap as "the arm changed
  nothing", which is the opposite of unknown. `landingError` is the rule that a subticket's
  deliverable is a *merged pull request*: a session that opened none, or whose
  merge failed, becomes a failed arm however cheerfully it reported itself —
  which halts Greg and leaves the box unchecked.

- **`src/harness/harness.ts`** — the orchestrator, and the run is four phases:
  **prepare** (both checkouts synced to origin's default branch, sequentially,
  before either session starts — so a sync failure costs nothing already in
  flight, and every subticket begins where the last one merged), **build** (both
  arms concurrently with `Promise.all`), **review** (`reviewArm` per arm, on the
  same thread and the same event sinks, so the live view keeps watching one
  continuous arm through the review wait), and **merge** (`mergeArm`).
  The split between the last two is a **barrier**, and it is load-bearing.
  Merging is the only irreversible thing the harness does and it is per-arm, so
  without a gate one arm can permanently land a rung the other never built —
  after which the two mains differ by a subticket and neither recovery works:
  re-run and the arm that already merged re-solves a solved ticket in seconds
  and "wins" (two clean successes in the manifest, a worthless comparison), or
  check the box by hand and the failed arm never builds that feature at all, so
  every later rung sits on a codebase missing it. So nothing merges unless
  *every* arm is `ready`; otherwise the mergeable ones are recorded `blocked`,
  which `landingError` counts as failed, which halts Greg with the box
  unchecked. Losing a rung loudly beats desynchronising the experiment
  silently. A failed **build** short-circuits the review phase too, so a doomed
  rung does not spend a Greptile review. A failed **review answer** is also
  fail-closed: it records `review-failed`, blocks both merges, and halts Greg
  rather than landing findings the arm never addressed. Watchers are grouped in
  `HarnessSinks` (`onEvent`, `onArmComplete`, `onArmNote`, `onArmPhase`,
  `onLanding`) and the
  outside world in `HarnessDeps` (`runner`, `github`, `environment`, `wait`,
  `now`) — the
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
  `AbortSignal` (from quitting the live view) is checked **between attempts** as well
  as handed to the session: aborting only the attempt in flight would hand
  straight back to the retry loop, which would immediately start another one —
  the opposite of stopping. In `session.ts` that signal joins the *same*
  controller the watchdog uses, so there is one teardown path and the MCP
  client's `close()` kills the codex subprocess instead of orphaning it.

- **`src/harness/environment.ts`** — the amnesic machine boundary. For every
  `runHarness` call it provisions a fresh runtime container, nested-Docker
  volume, isolated network, clone, browser profile, and `/codex` writable layer
  per arm. It returns a runtime config carrying the generated container names,
  exports only the requested thread transcript with `docker cp`, and destroys
  all runtime resources after landing or failure. Tests inject the entire
  interface, so lifecycle and teardown are covered without Docker. Teardown
  happens after the run has settled and is diagnostic-only: a failure writes
  `cleanup-error.txt` and `manifest.cleanupError`, but cannot turn merged work
  into a failed run or replace an earlier run error. Host smoke mode is the
  explicit no-op implementation.

- **`src/harness/session.ts`** — `createArmSession` owns one stdio MCP client
  for an arm's whole subticket. The server's thread registry is in memory, so
  build retries and review rounds must reuse that client; replacing it between
  turns makes `codex-reply` reject the otherwise valid thread id.
  `runArmStreaming` is the one-shot wrapper used by Greg and other callers that
  genuinely need only one turn. This module sits
  beside `harness.ts` rather than under the view: the live view *watches* the
  events it emits, but a `--no-tui --json` run drives the identical module.
  Three things to preserve: (1) it registers a
  `codex/event` notification handler so events are observable live (this is what
  feeds both the TUI and the watchdog) rather than discarded; (2) an **activity
  watchdog** aborts an arm after `idleTimeoutMs` of event silence (default 4m),
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
  `cleanEnv` is an **allowlist**, not a copy of `process.env`, for the same
  reason: Bun loads `.env`, so the harness process holds both repo paths, both
  `<ARM>_GH_TOKEN`s, and forwarding all of it let a
  host-mode arm learn it was one of two — and reach the other arm's repository
  with the other arm's token, around its own token's scope.
  The override must be set in the **tool call**: on the `mcp-server` path
  `--disable apps` and `-c features.apps=false` on the argv are silently
  ignored (they work for `codex exec` — that is the trap). When an `exec`
  prefix is present it spawns
  `docker exec … codex mcp-server` and does **not** anchor the host spawn cwd
  (the cwd is an in-container path).

- **`src/harness/artifacts.ts`** — `RunArtifacts` owns the on-disk record under
  `results/<run-id>/`. Every write goes through `atomicWrite` (temp file +
  `rename`). The top-level `manifest.json` (`schemaVersion: 3`) is the source of
  truth for run status; manifest writes are **serialized through a promise
  chain** (`manifestWrite`) that swallows its own errors so one failed write
  can't poison later ones. In container mode the environment exporter copies
  the matching `threadId` out of the ephemeral `/codex/sessions`; host smoke
  mode still searches `config.codexHome`. `transcriptStatus` records copied /
  partial / not-found / copy-failed / no-thread-id; `transcriptError` preserves
  the exporter failure without changing the arm's result.
  `recordBaselines` writes the commit each arm started from (they should match;
  when they do not, that *is* the finding). `recordLanding` writes
  `<arm>/land.json` — pull request, every review round with what the reviewer
  said and what the arm answered, the merge — replaces the arm's final result
  (a session that opened no pull request is a failed arm), and **re-copies the
  transcript**, because the review rounds are more turns on the same thread and
  the first copy stops short of them.

- **`src/climb.ts` / `src/ticket.ts`** — the two run-mode wirings, and the only
  places the injectable seams get filled with real implementations.
  `climb.ts` (`runGregLive`) hands `runGreg` its `plan`/`harness`/`log` deps so
  the planner's *and* the builders' event streams are watchable — a silent
  multi-minute planning session is what used to look like a hang — and it seeds
  the view from `state.json` and re-reads the ladder between phases (Greg
  appends rungs as he plans and the loop checks boxes as it builds, so a plan
  read once would quietly stop showing where the climb is).
  `ticket.ts` (`runTicketLive`) is the same shape with no Greg in it. They sit
  beside `index.ts`, their only caller, rather than inside `greg-tile/` or
  `view/`: those two are layers, and neither should have to know the other
  exists. The Ink boundary is the real constraint here — `greg-tile/loop.ts`
  must stay free of React so `greg-tile-loop.test.ts` can drive a whole climb
  headlessly, which is why this wiring is a separate module at all.

- **`src/harness/state.ts`** — `results/state.json`, the durable record of the climb and
  the deliberate counterpart to `LADDER.md` (see the warning under `ladder.ts`).
  Because *nothing* downstream reads it — never mounted, never in a prompt — it
  can hold everything worth reading later: per subticket, the run id, artifact
  dir, and each arm's pull request with its review-round counts — `comments` for
  the whole conversation and `diffComments` for the inline ones, kept apart
  because only the second is a count of findings; per planning
  turn, Greg's thread id and the transcript copied out of `CODEX_HOME`. Reads
  fail open (a missing or corrupt file is an empty climb) because this is a
  record for humans and must never stop the experiment it is recording. It is
  also what makes the live view survive a restart: `climb.ts` seeds the arm tabs
  and the climb tree from it, so a climb spanning weeks and many `bun start`
  invocations shows every rung it has ever landed, not just the one in flight.

- **`src/index.ts`** — the single entrypoint. Dispatches to either the ladder
  loop (default) or a one-ticket run, owns the `results/live-<ts>/` log
  directory and the exit code, and owns no run logic of its own. Flag resolution
  lives in `config.ts` as `parseRunMode` (pure, and tested in
  `test/config.test.ts`) — combinations that could only be honoured by ignoring
  a flag the caller typed throw instead.

- **`src/view/`** — the live view. `attach.ts` is the shared sink wiring
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
  its session idle, and it belongs on the same activity trail) and `phase()`
  for the **status word**. A run spends long stretches with the session idle,
  and "working" for forty minutes did not say whether the arm was writing code
  or sitting on a review that had not arrived. So the harness *announces* what
  each arm has moved on to — `preparing`, `building`, `waiting for review`,
  `answering review`, `waiting on peer` (idle at the merge barrier — where the
  unreviewed arm spends most of a subticket, and where "building" was a lie),
  `merging`, `held back` (`ArmPhase` in `harness/arms.ts`,
  through the `onArmPhase` sink) — at the transition itself. Nothing infers a
  phase by reading the prose of a note: the notes are the experiment's
  human-facing text and get reworded, and a classifier over them would start
  lying at the next rewrite. `statusLabel` in `format.ts` is the whole display
  rule — the phase while the arm is live, the outcome once it settles;
  `model.ts` is `LiveModel`, the one view model **both** run modes render from
  (arms, a subtitle, notes, the mirrored log, the plan, and the merged pull
  requests per arm — those live on the model, not the store, because the store
  is cleared between phases and merged pull requests are exactly what should
  accumulate across them). `climb()` is where the two halves of the experiment's
  own history meet: the ladder says what was planned and which boxes are
  checked, `state.json` and the run in flight say what each arm landed on each
  rung. A landing arriving mid-run is filed under `currentSubticket`, so the
  tree fills in as the run goes rather than only in the next process. The plan
  reaches the model as four fields per rung (`PlanSubticket`) rather than as
  ladder text, which is what keeps `view/` and `greg-tile/` ignorant of each
  other. `climb.ts` beside it is the pure row builder — what the tree shows, in
  what order, and what each row says — so the shape is testable without Ink.
  The comment count on a pull-request row is **inline comments on the diff**,
  not the whole conversation: that also holds the description, every review's
  summary body and reactions, which inflated a two-finding review into "6
  comments" and made the number useless for comparing arms.
  `quit.ts` owns what closing the
  view means — quitting stops the run. `needsQuitConfirm`/`confirmQuitPrompt`
  drive the in-view `y / n` question while sessions are still working, and
  `onViewClosed` is the shared hook both modes hand to `mountLive`: it decides
  from the **model**, not the keypress, so the ordinary end-of-run unmount
  stays silent and aborts nothing, while an early quit names what it stopped
  and aborts the controller every session runs under.
  The live view and the durable artifacts come from the **same single run** —
  watching is a display choice, never a second execution path.

- **`src/view/tui/`** — the fullscreen view. It takes over the terminal via the
  alternate screen buffer (`fullscreen.ts`) and hands it back on exit, so the
  run's frames never bury the user's scrollback and the closing summary always
  prints to the normal buffer. The restore is bound to Ink's exit at **mount**
  (`restoreOnExit`), not to the caller's `await`: callers only await once the
  run is over, but `q` can end the view hours earlier, and binding it late
  stranded the terminal on the alternate screen with a hidden cursor for the
  rest of the run. `app.tsx` is the shell: header, tab strip, body,
  key handling. `tabs.ts` is the pure tab logic, keyed on **stable ids, never
  indices** — Greg swaps which sessions are live between phases, so the tab list
  changes shape mid-run, and the **climb** tab appears only once a plan exists
  (a one-ticket run has none, so the tab is absent rather than empty).
  `panes.tsx` holds the panes: `Overview` (one calm
  card per arm), `ArmDetail` (one arm in full — context meter, the pull
  requests it has merged with their GitHub links, recent activity, answer),
  `ClimbTree` (the rungs as a tree, with what each arm landed on them), and
  `Feed` (tail-following list, used by the log tab). The ladder file used to
  have a tab of its own next to the climb: the same plan with none of the
  outcomes, and the rung being built was the only thing anyone opened it for —
  which the climb tree marks anyway. The climb's own log lines survive as a
  short tail under the tree, and in full in the log tab and `ladder.log`. The pull
  request rows are budgeted *before* the answer and print the URL whole,
  truncating the title instead: those rows exist to be opened, and a truncated
  link is not a link. The activity trail is capped at ten rows however tall the
  terminal is — it is a *recent*-activity list, and the full history is in the
  arm's `progress.log`.
  Every pane is told its height and **budgets its rows explicitly**: Ink resolves
  overflow by drawing rows on top of each other rather than scrolling, so a pane
  drops a section instead of nearly fitting. `wrapLines` in `format.ts` exists
  for the same reason — a block has to know its real height before it renders,
  and so does `scroll.ts`, the pure scrollback logic behind `Feed` and the climb
  tree: it hands out
  `height - 1` content rows because the status row at the bottom is permanent,
  bounds a scroll to the buffer, and parks the view on a **row id** rather than
  a distance from the end, so arriving events cannot drag the text a human is
  reading out from under them. Which is why a row id must identify the *row* and
  never its position: the log feed numbers its lines as they arrive, but the
  climb tree is rebuilt whole on every change and rows appear above existing
  ones (a landing adds an arm row mid-list, a rung that left the ladder is
  prepended), so its rows are keyed to the rung or arm they describe. A
  positional id there re-points the anchor at different content, which is the
  exact failure the anchor exists to prevent.

- **`src/greg-tile/`** — the planner loop that sits *above* the harness.
  `ladder.ts` owns `LADDER.md`: parsing `### [ ] 1.2 Title — ENG-12` checkbox
  headings into subtickets, flipping a box to `[x]` — **and writing nothing
  else**, which is load-bearing. The ladder is bind-mounted read-only into both
  arms' containers *and* is Greg's entire prompt, so it is the one file that
  crosses every isolation boundary in the experiment. It used to also record
  each run: its id, its artifact dir, and both merged pull request URLs. Those
  URLs name both repositories and a failure line named the arms, so any arm that
  read the ladder — and the worker prompt tells it to read "predecessor logs" —
  learned it was one of two being compared, and Greg saw the pull requests he is
  documented as blind to. The box is all the loop needs to resume and all Greg
  needs to plan forward; what a run actually landed goes to `src/harness/state.ts`.
  `ladder.ts` also handles symlinking the ladder into local checkouts on the
  host-only smoke path (the local stand-in for the container bind mount).
  `planner.ts` runs the stateless planner session — a fresh one, never a
  continued thread, with `PLANNER_ATTEMPTS` retries for transient session
  failures — and checks that Greg actually appended the milestone it asked for.
  The prompt text itself lives in `src/harness/prompts.ts`. The ladder is the *only*
  context Greg gets, and that is **enforced, not just asserted**: real runs
  mount a scratch directory holding only a ladder copy into a fresh ephemeral
  container, then copy his edit back. Host-mode smoke tests use the same scratch
  directory without Docker. He used to run with
  cwd = the harness repo root, because that is where `LADDER.md` lives — and
  Codex loads `AGENTS.md` from its working directory as instructions, so *this
  document*, naming both arms and the reviewer asymmetry, was in his context on
  every planning turn automatically. That directory also holds `results/` (both
  arms' pull requests and transcripts), `.env` (both repository URLs and both
  tokens), and, on the host smoke path, both checkouts as siblings. A planner that knows one arm is
  reviewed can shape milestones toward or away from review-sensitive work,
  which is the independent variable. `loop.ts` is the todo-runner: `runGreg` builds the next unchecked
  subticket and **halts on any failure, leaving the box unchecked**, so a broken
  rung can never look built; `planAhead` is the `--plan-only` variant that plans
  without building. The live wiring is `src/climb.ts`, one directory up, so
  `greg-tile/` imports nothing from `view/` — the layers do not know each other.
  The ladder file **is** the plan, with no JSON hand-off to drift; what each
  rung *landed* is `results/state.json`, and the split between those two is the
  isolation boundary, not a convenience.

## Run statuses

`completed` (both arms succeeded) · `completed_with_failures` (an arm exhausted
its retries, **or landed nothing** — process exits 1) · `failed` (the harness
itself threw). These appear in both the CLI JSON result and `manifest.json`.

Succeeding means landing: an arm whose session ended cheerfully but opened no
pull request, or whose pull request could not be merged, is a failed arm
(`land.json` says which, as `no-pull-request` or `merge-failed`). So is an arm
that was perfectly mergeable but whose *peer* was not: it is recorded `blocked`
and left unmerged on purpose, because merging it alone would put the two
codebases permanently out of step on a rung only one arm ever built. The ladder
halts and leaves the box unchecked — a rung that did not land must not look
built.

## Resuming an interrupted climb

The ladder resumes on its own. A subticket's box is only checked **after** its
run succeeded, so a machine that dies mid-run leaves the box `[ ]` and the next
`bun start` retries it. Nothing else is checkpointed — in particular the arm's
Codex `threadId` is written into `status.json` but never read back, so the
interrupted subticket restarts from attempt 1 on a fresh thread. Subtickets are
one PR-sized step, which is what makes that affordable.

Normal failures are already clean: `runHarness` destroys both ephemeral
environments in `finally`, and the retry starts both arms from new clones. A
host crash can strand containers after the harness process is gone; they are
labelled `vivarium.ephemeral=true` so recovery can find exactly those resources:

```bash
scripts/resume-clean.sh                     # report only; changes nothing
scripts/resume-clean.sh --apply             # close visible PRs and destroy them
```

The report names each leftover arm, branch, dirty-path count, and discoverable
open PR. `--apply` closes that PR when the container is still inspectable, then
removes the container, its nested-Docker volume, and its network. It never
touches either remote default branch. Do not run `--apply` while a climb is
active: labelled containers are precisely the active run's environments too.
On a clean shutdown the command is a no-op.

## Artifact layout

```
results/<run-id>/
  manifest.json ticket.txt prompt.txt config.json baselines.json
  tuatara/land.json         # pull request, review rounds, conversation, merge
  tuatara/attempt-01/  request.json status.json response.json output.txt
                       error.txt transcript.jsonl
  komodo/land.json     ...
  komodo/attempt-01/   ...
results/live-<ts>/
  tuatara/progress.log      # one feed per arm, written by the live view
  komodo/progress.log
  greg/progress.log         # the planner session, when there is one
  ladder.log                # the climb's own lines
results/state.json          # the durable climb record, across every run
results/planner/            # Greg's raw transcripts, one per planning turn
  milestone-2-<threadId>.jsonl
```

`land.json` is the close-reading input the experiment is for: the reviewer's
findings and the arm's answers to them, in one chronological list per pull
request, beside the transcript of the session that wrote both.

`LADDER.md` sits at the repo root, outside `results/` — it is Greg's durable
state across runs (North Star, every milestone, every subticket and its
outcome), symlinked into both checkouts so the builders can see it.

## Testing notes

Tests inject a fake `AttemptRunner` into `runArm`/`runHarness` — no real Codex
process or container is spawned, so the suite runs offline. The one subprocess
integration suite, `test/mirror-sync.test.ts`, runs the real `mirror_sync.sh`
and local Git against throwaway bare repos, with `gh` stubbed; it still needs no
network. When changing the retry/threading logic in `harness.ts` or the artifact
schema in `artifacts.ts`, update `test/harness.test.ts` /
`test/artifacts.test.ts` accordingly.

**No test asserts what a prompt says.** The prompts are hand-authored and are
the experiment's independent variable, so a test pinning their phrasing fails on
every rewrite while catching nothing. `prompts.test.ts` covers only what is
mechanical: the values a prompt has to carry (the ticket, the pull request URL,
the ladder), and the one cross-module contract — the `### [ ] N.M` subticket
heading `plannerPrompt` dictates has to be the heading `greg-tile/ladder.ts`
parses back out. The same rule holds for human-facing output elsewhere: assert
the data a message carries (ids, URLs, paths, counts) and the behaviour around
it, never the prose.

The landing phase is faked the same way, one level out: `test/land.test.ts`
injects an `ArmGitHub` that answers from a script (including "the review arrives
on the third poll") plus a fake clock, and `test/harness-land.test.ts` drives a
whole `runHarness` with both fakes to check the artifacts it leaves behind.
Apart from the mirror-sync integration suite above, nothing in the suite runs
`git`; nothing invokes the real `gh` or Docker.

Greg's tests do the same one level up: `greg-tile-loop.test.ts` injects fake `plan` /
`harness` / `log` deps (`GregDeps`) and a temp ladder path, `greg-tile-ladder.test.ts`
covers the markdown parse/complete/link logic, and `greg-tile-planner.test.ts` fakes
the runner to check the "did Greg actually append milestone N" guard. Nothing
in the suite touches Docker or the real `LADDER.md`.

`view-fullscreen.test.ts` covers the terminal handoff without rendering Ink:
`restoreOnExit` is the pure lifecycle seam, so the regression it pins (the
terminal coming back when the *view* exits, not when the caller finally awaits)
is a plain promise-ordering test. `view-quit.test.ts` does the same for what
quitting means — `quitNotice` is pure, and `onViewClosed` is checked against a
real `LiveModel` with stdout spied. The matching harness-side guarantee lives
in `harness.test.ts`: an aborted arm must record one failed attempt, **not**
spend its remaining retries. `view-climb.test.ts` is the same trick for the
climb tab: `climbRows`/`climbFooter`/`climbLayout` are pure, so what the tree
shows — which rungs, which arm rows, the pull request URLs whole — is asserted
without Ink, and `LiveModel.climb()` is checked for the merge of plan and
outcome it exists to do.
