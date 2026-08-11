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
translate through. There is no per-run input at all: the tickets come from the
ladder, and which two checkouts run, and whether they're isolated in
microVMs, is deployment configuration set once in `.env`, never per ticket.

Each arm drives a real Codex session over MCP (`codex mcp-server`, stdio
transport). For real runs each arm's Codex runs inside its own Docker Sandbox
Firecracker microVM so it cannot see the other arm's checkout or host. Greg's
fresh planning attempts run in separate ephemeral microVMs containing only a
scratch ladder. The harness itself always runs on the host and orchestrates
them.

**Greg Tile** is the layer above, and what `bun start` runs: a stateless
planner loop that supplies the tickets itself. Greg plans the next milestone
toward a fixed North Star, writes it into `LADDER.md` as checkbox subtickets,
then mechanically runs the same two-arm harness on each one. Greg takes no
configuration of its own — it reuses the arms from `.env`. The experiment *is*
this loop running for a long time; there is no other run mode (`--ticket`, the
old one-off escape hatch, is gone — exercising the harness directly is what
`runHarness` and the test suite's fakes are for).

## Commands

```bash
bun install
```

### Run the experiment

There is **one** run command. Bare `bun start` is the experiment itself: Greg
plans the next rung onto `LADDER.md`, both arms build its subtickets, repeat.
Everything else is an option on that loop, not a separate entrypoint.

```bash
bun start                        # climb continuously: plan a rung, build its subtickets, repeat
bun start -- --plan-only         # plan rungs onto the ladder; build nothing
bun start -- --no-tui --json     # machine-readable, for scripts
bun start -- --help              # the full option + env reference
```

- **The climb** — read `LADDER.md`, build the first unchecked
  subticket via `runHarness`, check its box, repeat; when nothing is pending,
  run a fresh planner session to append the next milestone, continuously.
  Re-running resumes from the first unchecked box — everything is resumable.
- **`--plan-only`** runs `planAhead` instead: plans milestone after milestone
  onto the ladder without ever invoking the harness, so several rungs can be
  reviewed before runs are spent on them. A later bare `bun start` builds
  everything queued this way.
- **`--tui` / `--no-tui`** force the live view (default: on when stdout is a
  TTY). The live view is fullscreen and tabbed: an **overview** of every arm, a
  tab **per arm** with its effective model/effort/tier on one line, context
  meter, recent activity and answer, the
  **climb** (every rung built, with both arms' pull requests, the rung in
  flight, and the next few), and the raw **log**. `↹`/`←→` or `1`-`9` switch tabs, `↑↓`
  scroll the list tabs. Each arm's duration excludes time spent idle at the
  merge barrier waiting only for its peer, so the two A/B timings do not
  collapse into the shared run duration. `q` quits — and quitting **stops the
  run**. The in-view confirmation offers `y` to stop immediately, `n` to keep
  watching, and, during a climb, `S` to finish the subticket in flight (or the
  milestone being planned) and stop cleanly before the next step — the merge
  barrier makes that boundary safe, and it arrives in minutes rather than the
  hours a whole rung can take; once everything has settled the view is a report and closes
  without asking. Ctrl-C stops the run without asking — it has one meaning
  everywhere else and does not acquire a second one here. An immediate stop
  closes each arm's open PR for its session-owned interrupted branch and
  deletes that remote branch before destroying its microVM, so retrying the
  unchecked subticket starts from the same external baseline too. Stopping
  live sessions exits 1.
  It runs on the alternate screen and gives the
  terminal back on exit, so the closing summary is what survives. Every mode
  writes one `progress.log` per arm either way, filed beside the record it
  describes — `results/rung-NN/run/N.M/<arm>/progress.log`.
- **`--json`** prints the machine-readable result and implies `--no-tui`.
- Exit code is **1** whenever an arm exhausts its retries or the run throws, in
  every mode — the watchable path and the scriptable path are the same path.
- A flag that cannot be honoured fails up front rather than being silently
  ignored — including the removed `--ticket`, which errors with what replaced
  it instead of quietly climbing the ladder.

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
bun run sandbox-build            # build/import the Docker Sandbox template once
scripts/mirror_sync.sh           # replay Komodo's main-states into the review mirror
bun run mirror-snapshot          # file the mirror's reviews under results/mirror/
scripts/resume-clean.sh          # report what an interrupted climb left behind
scripts/resume-clean.sh --apply  # …and destroy those leftover environments
```

`sandbox-run.sh` is the harness-internal per-arm microVM launcher (details
below); `sandbox-gui.sh` and `sandbox-browser.sh` run inside that VM, with the
latter installed as `browser`. `sandbox-build.sh` builds the Dockerfile and
imports its OCI archive into the sandbox runtime's separate template store.
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
`bun run mirror-snapshot` (`src/mirror/snapshot.ts`) is the mirror's record
keeper: the mirror PRs are where Komodo's counterfactual reviews live, nothing
in `run.json` captures them (the arm never sees them, so its landing holds
none), and Greptile edits its overview in place — history that is only cheap
to read before it happens. Run it on a schedule while the experiment is live;
each pass re-reads every mirror PR into `results/mirror/pr-NNNN.json`,
accumulating comment revisions under the same rule `land.ts` uses so the two
arms' review records read as one corpus. It needs a token that can read the
private mirror (`MIRROR_SNAPSHOT_TOKEN`, or gh's ambient login).
`resume-clean.sh` is the preflight for resuming an interrupted climb (below).

Runtime is **Bun** (not Node) — use `bun`, not `npm`/`node`. Source is authored
in ESM TypeScript/TSX but imports use `.js` specifiers (NodeNext resolution),
so keep writing `./foo.js` in imports even though the file is `foo.ts`. Bun
auto-loads `.env`, which is how arm config reaches every command above.

## Docker Sandbox setup (standard path for real runs)

All arm configuration lives in `.env` (`<ARM>_REPO`, `<ARM>_SANDBOX`,
`<ARM>_GH_TOKEN`). Both the harness and `scripts/sandbox-run.sh` read it.
Run-wide knobs live there too: `CODEX_SANDBOX` (unset gives an isolated arm
`danger-full-access`, because the microVM is the boundary, and a host arm
`workspace-write`), `CODEX_FAST_MODE`, review limits, `CODEX_HOME`, and the
watchdog. The template, VM sizing, private Docker daemon, GUI, fixed noVNC
ports, and reviewer identity are experiment constants. Legacy
`*_CONTAINER` variables fail loudly rather than silently selecting host mode.

The host needs `sbx`, KVM access, Docker login, and global OpenAI OAuth:

```bash
sbx login
sbx secret set -g openai
bun run sandbox-build
bun start
```

`sandbox-build.sh` extends Docker's `codex-docker` template with the pinned Bun
and Codex versions plus Chrome/Xvfb/noVNC. It builds through the host Docker
daemon, saves the OCI image, and imports it into the sandbox runtime's separate
template store as `vivarium-arm:latest`. The build daemon is never used for arm
execution.

Each `runHarness` call owns two fresh Firecracker microVMs.
`environment.ts` derives unique names from the configured `<ARM>_SANDBOX`
prefixes, launches both with `--no-share-skills`, applies explicit network
denies, and removes both in `finally`. `sandbox-run.sh` makes one remote
`vivarium-init` call that clones the arm's HTTPS remote into private
`/workspace`, configures its proxy-backed identity, waits for private Docker,
and starts the GUI. Its redirected host client stays attached until cleanup so
the VM cannot auto-stop between harness commands. A baked `vivarium-sync`
performs the complete baseline reset in one remote call. The launcher mounts
only an empty host scratch directory plus `LADDER.md` read-only, and publishes
noVNC on loopback ports 6080/6081.
No checkout, browser profile, Docker cache, dependency directory, or Codex
session survives the subticket. Retries and review rounds intentionally reuse
the same VM, checkout, MCP client, and thread within that subticket.

Docker Sandboxes normally exposes a shared host skills directory and permits
named sandbox/host reachability even under Balanced network policy. Both are
unavailable here: every create uses the currently hidden but supported
`--no-share-skills`, and before Codex starts the harness denies the peer name,
`host.docker.internal`, `gateway.docker.internal`, localhost and loopback for
each VM. Policy failure aborts provisioning. The arm has its own Docker Engine
inside the microVM; its privileged inner engine is separated from the host by
Firecracker and never sees `/var/run/docker.sock`, host block devices, the peer
VM, `.env`, or `results/`.

GitHub tokens are stored per runtime sandbox with `sbx secret set` through
stdin. Commands receive only `GH_TOKEN=proxy-managed`; Docker's credential
proxy substitutes the real token on matching GitHub requests, so the secret
never enters VM memory, files, remote URLs, or argv. The launcher asks GitHub
for that identity and configures commits as
`<id>+<login>@users.noreply.github.com`. Codex OAuth is likewise injected by
the sandbox runtime. Account connectors/plugins remain disabled in the MCP
tool-call config, and `--no-share-skills` removes ambient plugin files.

Xvfb runs on `:99`; fluxbox places windows; x11vnc and noVNC expose the screen.
`browser <url>` keeps one Chrome profile per subticket and prints the DevTools
endpoint on `127.0.0.1:9222`. `sandbox-run.sh` waits for both the GUI ready file
and the sandbox's private Docker daemon before declaring an arm ready.

When both arms are isolated, Greg gets a new `vivarium-greg-*` microVM per
planning attempt from the same template. Its only host workspace is the
temporary directory containing a ladder copy; it gets no GitHub identity, arm
checkout, GUI process, `.env`, or results. The harness copies its transcript
out before removing the VM. With both sandbox prefixes unset, Greg and the arms
retain the explicit host `workspace-write` smoke-test path with **no
isolation**.

Codex writes arm transcripts under `/home/agent/.codex/sessions` in the VM's
private filesystem. `environment.ts` finds the requested thread and exports it
with `sbx cp` after build and again after review. A failed export is recorded
as `copy-failed` (or `partial`) and never retries successful work or blocks a
ready pull request. Refreshes still stage and atomically rename on success, so
an incomplete copy cannot corrupt earlier evidence.

## Architecture

The pipeline is `config → prompt → harness → (per-arm streaming) → artifacts`,
with the live view tapping the same event stream.

Those three stages are three directories, and `src/` itself holds only the
entrypoint and the climb's wiring:

```
src/index.ts climb.ts             # entrypoint + the climb's live wiring
src/harness/                      # running one ticket through both arms, and landing it
src/greg-tile/                    # the planner loop above the harness
src/view/                         # the live view watching it
src/mirror/                       # the mirror-review snapshotter (its own command)
```

`harness/` is the layer the other two are defined against — `greg-tile/` calls
into it and `view/` watches what it emits, while it imports from neither. Its
own modules are siblings, so they refer to each other by bare `./name.js`; a
cross-layer import is always visible as a `../harness/` in the specifier.

- **`src/harness/config.ts`** — turns env into a validated `HarnessConfig`.
  `parseArgs` reads env (repos, microVM names, sandbox, fast mode, timeout) and
  leaves the ticket blank — the ladder loop fills it per subticket, and
  `runHarness` refuses to run on the placeholder;
  for isolated deployments `validateConfig` requires two distinct plain HTTPS
  GitHub clone URLs, while the host smoke path canonicalizes local repo paths
  with `realpath` and rejects two paths resolving to the same directory. An arm
  gains `sandboxName` when its `*_SANDBOX` var is set; its value is a stable
  name prefix and that flag flips host vs. microVM
  execution downstream — and `validateConfig` **rejects a mixed configuration**,
  because one unset variable would otherwise leave one arm on the host at
  `workspace-write` while the other runs in a microVM at
  `danger-full-access`: different sandbox, different tool reach, and the
  host-mode arm able to read the other arm's checkout and `.env` directly, all
  recorded as a perfectly normal run. The in-VM workspace is the fixed
  `/workspace`, not config: `sandbox-run.sh` clones there, so a configurable cwd
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
  worker instruction, and it tells the worker to remain on the dedicated
  branch the harness already created, push its commits, open a pull request
  with `gh`, and end with a `PR: <url>` line. It also fixes the pull
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
  A new inline root comment (no `in_reply_to_id`) must always receive an
  individual answer, whether it arrives in round one or after a later fix.
  Greptile also edits one PR-level summary in place, and that summary can carry
  substantive findings that could not attach to a changed line. Each distinct
  summary-only finding is a root too and must receive an individual PR-level
  answer; confidence text, review metadata, and a restatement of an inline
  finding are not additional roots. PR-level comments are flat, so the arm
  identifies an answered summary root by its own later PR-level response, not
  by `in_reply_to_id`. A Greptile reply inside a thread the arm already
  answered is conversational: the arm may accept it and fix the code, state a
  final disagreement and stop replying in that thread, answer a new question,
  or say nothing to a restatement. A settled thread does not close review of
  the whole pull request; fixes can introduce fresh root findings elsewhere,
  and those still require answers.
  Both rounds also name the **inline** comment API (`gh api
  repos/{owner}/{repo}/pulls/{n}/comments`), because `gh pr view --comments`
  does not print inline comments and a thread reply is where the whole exchange
  lives after the first response — an arm told only about `--comments` watches its
  reviewer apparently fall silent and concludes it won. The mention rules are
  asymmetric and load-bearing: an in-diff thread reply must **not** mention
  `@greptileai` (Greptile reads its own threads unpinged, and a mention there
  makes it process the reply twice), while a PR-level comment — general
  questions and answers to summary-only findings not tied to one inline
  finding — **must** mention it, or Greptile never sees the comment at all. The
  arm does not
  declare the exchange closed in its answer: termination comes from the
  reviewer's next comment, a timeout with no new comment, or the configured
  round cap.
  `retryPrompt` is what `runArm` prepends on a failed attempt,
  and `plannerPrompt(ladder, n, file)` is Greg's whole turn — it carries
  `NORTH_STAR`, the milestone-level ambition standard, and the subticket-shape
  rules. Ambition means a complete product capability through a public surface,
  not raw lines of code or making every enabling ticket large; the prompt
  explicitly steers Greg away from repeating an
  abstraction/persistence/hardening/proof template while allowing small
  subtickets that unlock a bold vertical slice. The `### [ ] N.M` heading it
  dictates is a contract with `greg-tile/ladder.ts`, the module that parses
  exactly what it asks Greg to write. Change one and change the other.

- **`src/harness/github.ts`** — everything the harness does to git and GitHub *outside*
  Codex, bound per arm (`armGitHub(arm, exec)` → `ArmGitHub`) so a caller never
  passes a repo or a token around: `syncToBaseline` (fetch + `checkout -f -B`
  onto origin's default branch, then `clean -fdx -e node_modules -e LADDER.md`,
  snapshot the existing refs, verify the work-branch name is absent locally
  and on origin, and create the run-unique work branch before returning
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
  reported, falling back to its branch, carrying GitHub's churn numbers —
  additions, deletions, changed files — so the record can answer
  findings-per-line without a network), `conversation` (reviews + issue
  comments + inline review comments + reactions, merged chronologically),
  `diff` (the unified diff between two commits, read from the arm's own
  checkout — the local object store still holds commits an amend or squash
  unhooked from every ref), `discardCurrentWork` (on an immediate human stop,
  use the exact run-unique work branch the harness created and recorded before
  Codex started — never a branch inferred afterward from checkout or reflog
  state. Its remote-tracking reflog supplies the last object the session itself
  pushed; cleanup deletes only under an exact `--force-with-lease` for that
  object and recognizes a PR only when its head repository and SHA match that
  push, then closes it only after the lease succeeds or the remote ref is
  already absent),
  and
  `merge`. Comment list responses expose reaction counts, so identities are
  fetched only for comments with a nonzero count rather than making one extra
  API call per historical comment on every poll. For isolated arms these
  deterministic operations run through `sbx exec` inside that arm's private
  clone; host smoke tests run them directly. Every `sbx exec` crossing pays
  Docker Sandbox's credential/template upkeep — tens of seconds when its
  refresh lock is contended — so the landing path's serial GitHub work is
  batched into single crossings: the conversation poll, the post-answer read
  (`afterAnswer` — branch head, round diff, settle-check conversation) and the
  merge tail (`finalizeMerge` — merge, state re-read, conversation capture,
  churn refresh), plus immediate-stop rollback, are each one fixed
  argument-only bash program, with each
  part's failure a named gap in the JSON rather than the whole read failing.
  The landing bundles exist only on isolated arms; `land.ts` falls back to the
  discrete calls when a bundle is absent (host mode, the test fakes) or its
  read fails, so they are an optimization, never the only path. In the VM,
  Docker's proxy supplies
  the per-arm GitHub identity from a sentinel; on the host, a token reaches git
  through a one-shot credential helper. The whole interface is injected in
  tests — the suite touches neither git nor `gh` (the bundled-script suite in
  `test/github.test.ts` executes the bash programs against stubbed `gh`/`git`
  binaries, the same trick `test/mirror-sync.test.ts` uses).

- **`src/harness/land.ts`** — what happens to an arm's work *after* its session says it
  is done, and the piece that makes this an experiment rather than two agents
  writing into the void. `prepareArm` puts the checkout on a run-unique,
  harness-created work branch from the shared baseline before a subticket
  starts; `reviewArm` finds the pull request and
  runs the review rounds (all reversible — it never touches either main), and
  `mergeArm` performs the one irreversible step, with the harness holding a
  barrier between them. Both arms take the identical path: the reviewed
  arm's extra rounds come from `arm.reviewer` being set in config, never from a
  name check here. A round waits for something new from that login, hands the
  arm a `reviewPrompt` on **its own Codex thread**, and repeats up to
  `reviewRounds` (default 3) — a **maximum**, not a count. The cap leaves room
  for the initial review and two re-review passes, where a *disagreement*
  plays out — the arm pushing back, Greptile holding or conceding — without
  letting one stubborn score dominate the climb. A score present in
  Greptile's editable summary is also a merge target: the two early completion
  paths below apply only at **5/5**. A lower score keeps the exchange moving
  until a later summary reaches 5/5 or the configured round cap is exhausted;
  if the arm leaves no push or comment to trigger that pass, the harness posts
  one bounded `@greptileai review` request itself. The exchange ends on these
  bounded conditions:
    - **The reviewer's response is nothing but thumbs-up reactions.** GitHub
      exposes that structured reaction as `+1`, and Greptile attaches one to
      each arm reply it accepts — an ACK of that comment, **not** a verdict on
      the pull request: it hands them out while still replying in other
      threads. So only a batch that is *entirely* thumbs-up is recorded
      `signedOff`; any prose beside an ACK is handed to the arm. A known
      confidence score below 5/5 overrides that fast exit and requests another
      pass. Review bodies and comments are never classified by their wording,
      and every other reaction is ignored.
      Every distinct comment revision observed during polling is retained in
      the landing record's `conversationRevisions`, in addition to the final
      `conversation` snapshot. Greptile edits its PR-level overview in place
      after re-review — including the confidence score — so without this
      history the score trajectory and earlier summaries survive only behind
      GitHub's awkward edit-history API.
    - **The arm's answer leaves no trace on the pull request.** The reviewer
      only ever responds to a ping — a pushed commit or a posted comment — and
      its thumbs-up is an ACK to one. An answer that pushed nothing and posted
      nothing (a clean review gives the arm nothing to fix and nothing to say)
      gave the reviewer nothing to react to, so waiting again could only end in
      the full timeout. At 5/5 (or when no score exists) the round is recorded
      `settled` and the exchange ends immediately. Below 5/5 the harness posts
      one review request and continues instead. An unreadable post-answer check
      fails open to waiting — unknown must not end the exchange early.
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
    - **The maximum is reached.** At most `reviewRounds` reviewer batches are
      consumed, so a disagreement or a score that never reaches 5/5 cannot
      create an unbounded comment loop. The final recorded score remains
      visible when the cap permits landing below 5/5.
  A wait also has one bounded missed-trigger recovery. After five minutes with
  no reviewer output, the harness reads GitHub's Greptile status checks. It
  posts the PR-level comment `@greptileai review` only when no Greptile check is
  running and none started, completed, or was created during that same
  five-minute window. The decision is made once per wait, so a long silence
  cannot spam the pull request; an unreadable or ambiguous status fails closed
  and posts nothing.
  Every reviewer event first passes through a 30-second quiet-period debounce.
  New entries reset the window, so a review body and the inline comments that
  become visible a few seconds later produce one arm prompt rather than one
  prompt each. Comment edits count as new revisions even though GitHub retains
  the object's stable ID — Greptile edits its original summary after a
  re-review, and treating that as already seen would pay the full timeout after
  the pass had finished. A lone inline reply or reaction pays only that short window.
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
  the arm pushed a fix or only argued. A round that did push also **archives
  the diff itself** (`rung-NN/run/N.M/<arm>/rounds/round-NN.diff`, with a
  `diffFile` pointer in the round): the sha pair alone names commits that a
  squash-merge and branch deletion eventually strand, and the checkout that
  made them is destroyed with the subticket. A diff that cannot be produced is
  recorded as `diffError` — a gap, not "no push". After a successful merge the
  pull request's churn is re-fetched so the recorded numbers include the
  review fixes. `headSha` is the one method in
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
  **prepare** (both checkouts synced to origin's default branch and moved onto
  the same run-unique branch name, sequentially, before either session starts —
  so a sync failure costs nothing already in flight, every subticket begins
  where the last one merged, and cleanup has explicit ownership), **build** (both
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
  single place host-vs-microVM execution and Codex's permission mode are decided, so
  the build attempts and the review rounds cannot drift apart. `runArm` owns the
  **retry loop**
  (`maxAttempts`, default 3): on failure it re-invokes with a `retryPrompt`,
  continuing the *same Codex thread* via `codex-reply` when a `threadId` exists,
  otherwise restarting fresh with the recovery context prepended to the original
  task. In isolated mode it prepends `["sbx","exec","-i","-w",workspace,…,
  sandboxName]` as the exec prefix and points Codex's cwd at the in-VM
  workspace. `runner` (the arm launcher) and the two event sinks are injected —
  tests pass a fake runner instead of spawning real Codex. An optional
  `AbortSignal` (from quitting the live view) is checked **between attempts** as well
  as handed to the session: aborting only the attempt in flight would hand
  straight back to the retry loop, which would immediately start another one —
  the opposite of stopping. In `session.ts` that signal joins the *same*
  controller the watchdog uses, so there is one teardown path and the MCP
  client's `close()` kills the codex subprocess instead of orphaning it. Once
  both sessions are closed, an aborted harness calls `discardCurrentWork` for
  each exact runtime arm before destroying either environment; a broad
  prefix-matched recovery scan would be unsafe while another climb is active.

- **`src/harness/environment.ts`** — the amnesic machine boundary. For every
  `runHarness` call it provisions a fresh runtime microVM, private Docker
  storage, network policy, clone, browser profile, and Codex writable layer per
  arm. It returns a runtime config carrying generated sandbox names, exports
  only the requested thread transcript with `sbx cp`, and destroys all runtime
  resources after landing or failure. Tests inject the entire
  interface, so lifecycle and teardown are covered without Docker. Teardown
  happens after the run has settled and is diagnostic-only: a failure writes
  `cleanup-error.txt` and `run.json`'s `cleanupError`, but cannot turn merged work
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
  a tested **tool-call config override** (`codexToolArguments`) that pins
  `service_tier` to `fast` or `default`, pins `features.fast_mode` to the
  matching `CODEX_FAST_MODE` value, and disables `features.apps` and
  `features.plugins` — no ambient service-tier choice or account tooling, in
  either arm or in Greg. `codex_apps` connectors (Linear, GitHub) are
  *account*-scoped and arrive with the sandbox-injected OAuth identity, so an
  arm would otherwise read the experiment's own Linear board and reach the
  account's GitHub from inside its
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
  `sbx exec … codex mcp-server` and does **not** anchor the host spawn cwd
  (the cwd is an in-VM path).

- **`src/harness/artifacts.ts`** — `RunArtifacts` owns the on-disk record of
  one run. The climb hands it a **destination** — `config.destination`, filled
  in by the loop as `results/rung-NN/run/<N.M>/` with the subticket's number,
  milestone and title — so the record is filed by ladder coordinates, and a
  run without a destination is refused: a record without an address is one
  nothing can find again. A re-run of a
  failed box builds into the **same directory** and moves what it replaces
  under `superseded/<startedAt>/`, so the top level always holds the run that
  counted and the failures stay readable underneath. Every write goes through
  `atomicWrite` (temp file + `rename`). The single `run.json`
  (`schemaVersion: 4`) is the whole record — status, the subticket
  coordinates, the redacted config, each arm's baselines, attempts and
  landing — with only the raw texts beside it (`ticket.md`, `prompt.md`, the
  per-attempt files); there is no separate manifest, baselines or landing file
  to drift from it. `run.json` writes are **serialized through a promise
  chain** (`recordWrite`) that swallows its own errors so one failed write
  can't poison later ones. In isolated mode the environment exporter copies
  the matching `threadId` out of ephemeral `/home/agent/.codex/sessions`; host smoke
  mode still searches `config.codexHome`. `transcriptStatus` records copied /
  partial / not-found / copy-failed / no-thread-id; `transcriptError` preserves
  the exporter failure without changing the arm's result.
  `recordBaselines` writes the commit each arm started from (they should match;
  when they do not, that *is* the finding), the local/remote branch refs present
  before either worker starts, and the run-unique work branch created by the
  harness. That explicit work branch — not post-hoc reflog inference — is the
  ownership boundary for interrupted cleanup. `recordLanding` writes the arm's
  landing into `run.json` — pull request, every review round with what the
  reviewer said and what the arm answered, the merge — replaces the arm's final
  result (a session that opened no pull request is a failed arm), and
  **re-copies the transcript**, because the review rounds are more turns on the
  same thread and the first copy stops short of them.

- **`src/climb.ts`** — the climb's live wiring, and the only place the
  injectable seams get filled with real implementations.
  `runGregLive` hands `runGreg` its `plan`/`harness`/`log` deps so
  the planner's *and* the builders' event streams are watchable — a silent
  multi-minute planning session is what used to look like a hang — and it seeds
  the view from the rung directories and re-reads the ladder between phases (Greg
  appends rungs as he plans and the loop checks boxes as it builds, so a plan
  read once would quietly stop showing where the climb is). It sits
  beside `index.ts`, its only caller, rather than inside `greg-tile/` or
  `view/`: those two are layers, and neither should have to know the other
  exists. The Ink boundary is the real constraint here — `greg-tile/loop.ts`
  must stay free of React so `greg-tile-loop.test.ts` can drive a whole climb
  headlessly, which is why this wiring is a separate module at all.

- **`src/harness/state.ts`** — the climb's durable record, and the deliberate
  counterpart to `LADDER.md` (see the warning under `ladder.ts`). There is no
  state file: the record **is** the artifact tree, filed by ladder coordinates
  (`rungDirectory` / `planDirectory` / `subticketRunDirectory` are the one
  place the paths are spelled — and `armLogPath` / `plannerLogPath` /
  `climbLogPath` sit beside them, so the live feeds use the same coordinates
  as the records they narrate rather than a parallel scheme), and
  `readClimbState` reassembles the climb by scanning `results/rung-*/` and
  reconciling it with the checked boxes parsed from `LADDER.md` — a completed
  `run.json` is evidence, but does not enter climb history until its box is
  durably checked. Each accepted subticket's `run.json` supplies the run id,
  artifact dir and each arm's pull request with its review-round counts
  (`comments` for the whole conversation and `diffComments` for the inline
  ones, kept apart because only the second is a count of findings), each
  rung's `plan/plan.json` for Greg's planning turns (thread id and the
  transcript copied out of `CODEX_HOME` — `recordPlannerSession` appends them,
  because a milestone that took two attempts is worth seeing as two). Because
  *nothing* downstream reads any of it — never mounted, never in a prompt — it
  can hold everything worth reading later. Reads fail open per file (a missing
  `results/` is an empty climb; one corrupt `run.json` loses one row, never
  the climb) because this is a record for humans and must never stop the
  experiment it is recording. It is also what makes the live view survive a
  restart: `climb.ts` seeds the arm tabs and the climb tree from it, so a
  climb spanning weeks and many `bun start` invocations shows every rung it
  has ever landed, not just the one in flight.

- **`src/index.ts`** — the single entrypoint. Runs the ladder loop, owns the
  exit code, and owns no run logic of its own — not even a log directory: the
  feed's destination is a property of what is being written, so the climb
  decides it per phase. Flag resolution lives in `config.ts` as `parseRunMode` (pure, and
  tested in `test/config.test.ts`) — a flag that could only be honoured by
  ignoring it throws instead, including the removed `--ticket`.

- **`src/view/`** — the live view. `attach.ts` is the shared sink wiring
  (`attachLive`): it updates the store, tees a readable line into **that arm's
  own** `progress.log` through a serialized write chain, mirrors that line to
  the TUI's log tab, and echoes to stdout when no TUI is mounted — the TUI and
  the `--no-tui` path go through the same wiring, so a change to the feed
  can't drift between them. One
  file per arm: one combined file read fine live, where the label column
  tells the arms apart, but the artifact is a *pair* of independent builds and
  reading one arm's three-hour run meant grepping the other one out of every
  line first. The interleaved view survives where it belongs — in the log tab.
  **Where** those files go is not `attach.ts`'s business — it is handed
  `LogTargets` and asks them **per line**, because the destination is a
  property of what is being written rather than of the process writing it. The
  feeds used to land in one `results/live-<ts>/` directory per `bun start`,
  which named the run by when it happened to start (saying nothing about what
  it holds) and left a parallel tree accumulating one directory per invocation
  beside the tree that actually matters. Now `src/climb.ts` re-points the
  target as the loop advances — an arm's commentary into that subticket's run
  directory beside its attempts, Greg's into that rung's `plan/` beside the
  transcript of the same turn, and the climb's own lines into a single
  `results/climb.log` that reads continuously across every invocation because
  those lines belong to no rung and no arm. Resolving per line rather than at
  attach time is what lets a feed opened before the first subticket exists
  still land correctly once one does; with no target yet, arm lines are
  discarded rather than filed somewhere provisional, so a run that dies during
  setup leaves no empty directory behind. The cost, accepted knowingly, is
  that per-invocation grouping is gone: "what did last night's run do" is now
  answered by reading timestamps, not by listing a directory.
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
  `model.ts` is `LiveModel`, the one view model everything renders from
  (arms, a subtitle, notes, the mirrored log, the plan, and the merged pull
  requests per arm — those live on the model, not the store, because the store
  is cleared between phases and merged pull requests are exactly what should
  accumulate across them). `climb()` is where the two halves of the experiment's
  own history meet: the ladder says what was planned and which boxes are
  checked, the rung directories and the run in flight say what each arm landed
  on each rung. A landing arriving mid-run is filed under `currentSubticket`, so the
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
  (before the first milestone is planned there is none, so the tab is absent
  rather than empty).
  `panes.tsx` holds the panes: `Overview` (one calm
  card per arm), `ArmDetail` (one arm in full — context meter, the pull
  requests it has merged with their GitHub links, recent activity, answer),
  `ClimbTree` (the rungs as a tree, with what each arm landed on them), and
  `Feed` (tail-following list, used by the log tab). The ladder file used to
  have a tab of its own next to the climb: the same plan with none of the
  outcomes, and the rung being built was the only thing anyone opened it for —
  which the climb tree marks anyway. The climb's own log lines survive as a
  short tail under the tree, and in full in the log tab and `results/climb.log`. The pull
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
  else**, which is load-bearing. The ladder is mounted read-only into both
  arms' microVMs *and* is Greg's entire prompt, so it is the one file that
  crosses every isolation boundary in the experiment. It used to also record
  each run: its id, its artifact dir, and both merged pull request URLs. Those
  URLs name both repositories and a failure line named the arms, so any arm that
  read the ladder — and the worker prompt tells it to read "predecessor logs" —
  learned it was one of two being compared, and Greg saw the pull requests he is
  documented as blind to. The box is all the loop needs to resume and all Greg
  needs to plan forward; what a run actually landed goes to `src/harness/state.ts`.
  `ladder.ts` also handles symlinking the ladder into local checkouts on the
  host-only smoke path (the local stand-in for the sandbox mount).
  `planner.ts` runs the stateless planner session — a fresh one, never a
  continued thread, with `PLANNER_ATTEMPTS` retries for transient session
  failures — and checks that Greg actually appended the milestone it asked for.
  The prompt text itself lives in `src/harness/prompts.ts`. The ladder is the *only*
  context Greg gets, and that is **enforced, not just asserted**: real runs
  mount a scratch directory holding only a ladder copy into a fresh ephemeral
  microVM, then copy his edit back. Host-mode smoke tests use the same scratch
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
  rung *landed* is its `results/rung-NN/` directory, and the split between
  those two is the isolation boundary, not a convenience.

## Run statuses

`completed` (both arms succeeded) · `completed_with_failures` (an arm exhausted
its retries, **or landed nothing** — process exits 1) · `failed` (the harness
itself threw). These appear in both the CLI JSON result and `run.json`.

Succeeding means landing: an arm whose session ended cheerfully but opened no
pull request, or whose pull request could not be merged, is a failed arm (the
arm's landing in `run.json` says which, as `no-pull-request` or
`merge-failed`). So is an arm
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
confirmed immediate TUI stop additionally closes any open PR on the
session-owned interrupted branch and deletes that remote branch before the VM
loses its checkout and credentials. Before either worker starts, the harness
creates the same run-unique branch name in both private checkouts and records
it with each baseline; the worker is instructed to stay on it. Cleanup targets
only that identifier, independent of the current `HEAD`, so pre-existing or
concurrently-created branches cannot qualify by imitating reflog history. Its
remote ref is removed only when the remote-tracking reflog proves what object
this session pushed and an exact force-with-lease still matches it; a
collaborator-advanced or recreated ref, and its PR, are left untouched. PR
selection also requires the recorded repository and pushed object, so a
same-named fork PR is never a cleanup target. A failed GitHub rollback is
retained in `cleanup-error.txt` and
`run.json.cleanupError` without preventing VM teardown. A host crash can strand
named sandboxes after the harness process is gone;
recovery matches the configured arm prefixes plus `vivarium-greg-*`:

```bash
scripts/resume-clean.sh                     # report only; changes nothing
scripts/resume-clean.sh --apply             # close visible PRs and destroy them
```

The report names each leftover arm, branch, dirty-path count, and discoverable
open PR. `--apply` closes that PR when the sandbox is still inspectable, then
removes the microVM and its private state. It never
touches either remote default branch. Do not run `--apply` while a climb is
active: prefix-matched sandboxes are precisely the active run's environments too.
On a clean shutdown the command is a no-op.

## Artifact layout

Everything a rung produced lives under its own directory, filed by ladder
coordinates — the path answers "what is this" without opening a file:

```
results/climb.log           # the climb's own lines, across every invocation
results/rung-01/            # one directory per rung (milestone)
  plan/
    plan.json               # Greg's planning turns for this rung, appended per attempt
    <threadId>.jsonl        # …and each turn's raw Codex transcript
    progress.log            # …and the live feed of those turns
  run/1.1/                  # one directory per subticket — this IS the run dir
    run.json                # the whole record: status, subticket, config,
                            # baselines, each arm's attempts and landing
    ticket.md prompt.md
    tuatara/attempt-01/  request.json status.json response.json output.txt
                         error.txt transcript.jsonl
    tuatara/progress.log           # the live feed, beside the attempts it narrates
    tuatara/rounds/round-01.diff   # what each answered review round pushed
    komodo/attempt-01/   ...
    komodo/progress.log
    superseded/<ts>/        # what a re-run of a failed box replaced, in full
  run/1.2/ ...
results/mirror/
  makors__vivarium-test-komodo-mirror/   # one directory per mirror repo
    pr-0026.json            # one mirror PR: Komodo's counterfactual review,
                            # conversation + every observed revision, keyed
                            # back to the source PR it mirrors
```

The feeds are filed by the same coordinates as the records, so `results/`
holds only rungs and one climb log — no parallel tree, and nothing named after
the process that happened to produce it. They are a **debugging** artifact,
not an analysis one: for a run that finished cleanly, that arm's
`transcript.jsonl` is a strict superset. What they uniquely hold is resolution
*inside* an attempt (the record has only a start and an end snapshot), the
landing phase (which emits no `codex/event` at all), and whatever a process
killed mid-attempt never got to copy out of the microVM. Analysis reads
`run.json`.

The landing inside `run.json` is the close-reading input the experiment is
for: the reviewer's findings and the arm's answers to them, in one
chronological list per pull request, beside the transcript of the session that
wrote both. There is no separate state file — `readClimbState` reassembles the
whole climb by scanning the rung directories and accepting only records whose
ladder boxes are checked, so keeping the record and ladder is keeping the tree.

`LADDER.md` sits at the repo root, outside `results/` — it is Greg's durable
state across runs (North Star, every milestone, every subticket and its
outcome), symlinked into both checkouts so the builders can see it.

## Testing notes

Tests inject a fake `AttemptRunner` into `runArm`/`runHarness` — no real Codex
process or microVM is spawned, so the suite runs offline. Script tests use
stubs; `test/mirror-sync.test.ts` runs the real `mirror_sync.sh`
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
