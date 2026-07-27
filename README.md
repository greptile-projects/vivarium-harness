<div align="center">

<h1>vivarium harness</h1>

<img
  src="./docs/assets/vivarium-live.png"
  alt="Vivarium live view showing Tuatara first and Komodo second"
  width="900"
/>

</div>

## meet the (g)reptiles

- **tuatara** works in the checkout where greptile review feedback is available.
- **komodo** works in the matching plain checkout without it.

both start from the same commit and get the same ticket. every other input is
held constant, so a difference in their results is attributable to the review
feedback.

## how it works

`bun start` is the experiment, as a loop:

1. **greg tile plans** the next rung onto `LADDER.md` and splits it into
   PR-sized subtickets. In real runs each planning attempt gets a fresh
   container containing only a writable scratch copy of the ladder.
2. **both arms build** each subticket at once — one codex session each, in its
   own docker container, driven over MCP. a failing arm gets 3 tries.
3. **the work lands.** each arm opens a pull request. tuatara is sent back with
   the PR url and nothing else, to fetch greptile's review and answer every
   comment; then the harness merges. komodo merges straight away. that
   difference is the entire experiment.
4. **everything is saved** to `results/<run-id>/`.

a subticket isn't done when the agent says so, it's done when it's merged — no
pull request, or a merge that won't go through, fails the arm and halts the
climb with its box unchecked. a review that never arrives doesn't hold things
up: after `REVIEW_TIMEOUT_MS` the PR merges unreviewed, and the timeout is
recorded as what happened.

## setup

needs [bun](https://bun.sh), docker, and an authenticated codex CLI
(`~/.codex/auth.json`, mounted read-only into each container).

```bash
bun install
cp .env.example .env    # point KOMODO_REPO / TUATARA_REPO at two checkouts
docker build -t vivarium-arm .
scripts/arm-run.sh komodo
scripts/arm-run.sh tuatara
```

`.env` is the one place deployment config lives — checkouts, container names,
the shared image, and each arm's github token. both the harness and
`arm-run.sh` read it, so nothing goes on the command line.

each arm container brings its own **docker daemon** (nested, not the host's
socket — that would let either arm reach the other's checkout and this file)
and its own **screen**: an X display with chromium on it, so an arm can
actually look at the page it built. `arm-run.sh` prints a
`http://127.0.0.1:6080/vnc.html` link per arm if you want to watch.

## run

```bash
bun start                     # plan a rung, build its subtickets, repeat
bun start -- --unbounded      # don't pause every 2 milestones
bun start -- --plan-only      # plan rungs, build nothing
bun start -- --ticket "..."   # one ad-hoc ticket, then exit
bun start -- --no-tui --json  # machine-readable
bun start -- --help           # every option, plus the env reference
```

there's a fullscreen live view when stdout is a terminal: a tab per running
session with its context meter, what it's been doing and its answer, plus
greg's ladder and the raw log. `↹`/`←→` or `1`-`9` switch, `↑↓` scroll, `q`
quits.

`q` quits, and quitting stops the run. while sessions are still working it
asks first (`y / n`) and names what would be torn down; anything other than
`y` goes back to watching. ctrl-c stops without asking. what each arm wrote
before the stop is under `results/live-<ts>/<arm>/progress.log`.

## if a run gets interrupted

start it again — a box is only checked after its run succeeded, so the next
`bun start` picks that subticket up. clean the checkouts first, though, or the
arm that already pushed re-solves a solved ticket in seconds, "wins", and that
rung's comparison is quietly junk:

```bash
scripts/resume-clean.sh          # what did the interrupted run leave behind?
scripts/resume-clean.sh --apply  # reset both arms to origin/main
```

it never touches `main`, and already-merged work is reported rather than thrown
away, so it's safe to run every time.

## what you get

`results/<run-id>/` holds the ticket, the prompt, the config, the commit each
arm started from, and a directory per arm — every attempt's request, response
and codex transcript, plus a `land.json`: the pull request, every review round
with what the reviewer said and what the arm answered, and the merge. that file
is the close reading.

a run where both arms succeed is `completed`; one where an arm used up its
retries or landed nothing is `completed_with_failures` (exit 1); one that broke
for infrastructure reasons is `failed`.

## verify

```bash
bun run check
bun test
bun run build
```
