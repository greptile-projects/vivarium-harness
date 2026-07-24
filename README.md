# vivarium harness

Runs the same Linear ticket through two Codex workers at once — one against a
control checkout, one against a Greptile checkout — and saves everything each
one did.

Each arm's Codex runs in its own Docker container, so neither arm can read the
other's checkout, the harness, or the host. The harness itself runs on the host
and drives both containers over MCP.

## Prerequisites

- [Bun](https://bun.sh)
- Docker
- An authenticated Codex CLI (`~/.codex/auth.json`; mounted read-only into each
  container)

## Setup

```bash
bun install
cp .env.example .env
```

`.env` is the single place all arm configuration lives — checkouts, container
names, and optional per-arm GitHub tokens. Both the harness and
`scripts/arm-run.sh` read it, so nothing is passed on the command line. Point it
at two checkouts of the same commit and give each arm a GitHub token:

```dotenv
CONTROL_REPO=/absolute/path/to/control-checkout
GREPTILE_REPO=/absolute/path/to/greptile-checkout
CONTROL_CONTAINER=vivarium-control     # already set in .env.example
GREPTILE_CONTAINER=vivarium-greptile
CONTROL_GH_TOKEN=ghp_...                # this arm's identity when opening PRs
GREPTILE_GH_TOKEN=ghp_...
```

Build the arm image once, then start a container per arm. `arm-run.sh` takes
only the arm name and reads the rest from `.env`:

```bash
docker build -t vivarium-arm .
scripts/arm-run.sh control
scripts/arm-run.sh greptile
```

Each container mounts only that arm's checkout at `/workspace`, mounts Codex auth
read-only, and bind-mounts the arm's in-container Codex sessions dir out to a
per-arm host directory (`~/.vivarium/<container>/sessions` by default) so the
harness can copy each arm's transcript into the run artifacts. The arms never
share a sessions directory. To relocate it, set `<ARM>_CODEX_HOME` in `.env` —
both `arm-run.sh` and the harness read the same value.

## Run

```bash
bun start -- --ticket "Your ticket description"
```

For a live TUI view of both arms as they run:

```bash
bun run live -- --ticket "Your ticket description"
```

Each run writes to `results/<run-id>/`: the ticket, generated prompt, and
config at the top level, then a `control/` and `greptile/` directory each
holding that arm's MCP request/response, status, timing, and a copy of the
Codex transcript. Retries get their own `attempt-01/`, `attempt-02/`, etc.
subdirectories. The CLI prints the artifact directory when it's done.

Failed arms retry up to 3 times. A run that exhausts its retries is marked
`completed_with_failures`; a run that fails for infrastructure reasons is
marked `failed`.

## Greg Tile (the planner)

The harness runs one ticket. Greg Tile climbs the whole ladder toward the North
Star (a working GitHub clone):

```bash
bun run greg
```

Same setup as the harness — `CONTROL_REPO` and `GREPTILE_REPO` — and nothing
else to configure. The ladder is two levels: **milestones** (1, 2, 3 …) are the
rungs, and each breaks into **subtickets** (1.1, 1.2, 1.3 …), one PR-sized step
each. Every turn Greg plans one milestone and its subtickets, files them in
Linear (a parent issue plus a sub-issue each), appends them to `LADDER.md`, and
the loop mechanically runs the two-arm harness on each subticket in order.

Greg is blind to the builders — amnesic on both sides. He never sees the code
the arms wrote or whether it truly worked; his only input is the ladder of plans.
A subticket is simply "done" once its harness run returns, and a milestone is
done once all its subtickets have run. Then Greg plans the next milestone.

The North Star is a direction, not a destination, so there is no natural end. To
guard against runaway, Greg pauses after 10 subtickets for you to reconfirm (the
current milestone always finishes first). Just re-run `bun run greg` to continue
— he reads the ladder, so he picks up numbering where he left off. Pass
`--unbounded` to climb without the cap:

```bash
bun run greg -- --unbounded
```

`LADDER.md` is Greg's only state — the North Star and every milestone and
subticket planned and built so far. It is symlinked into both checkouts (the
local stand-in for the docker bind mount), so both build arms can see where the
work is going. Under docker isolation, bind-mount the ladder to `LADDER.md`
inside each arm's container instead; Greg leaves any pre-existing file at that
path untouched.

The loop is deliberately mechanical: Greg (the agent) only plans, and files
Linear tickets if a Linear MCP is configured in your Codex environment. Running
the harness is not one of Greg's tool calls — the loop calls it directly. Each
milestone is a fresh Codex session; each subticket writes its own
`results/<run-id>/`.

Two optional env vars, both deployment-level:

- `CODEX_SANDBOX` — arm sandbox mode (default `workspace-write`; the disposable
  VMs use `danger-full-access`)
- `CODEX_HOME` — where to find Codex sessions, if not `~/.codex`

Everything else is fixed in code: artifacts go to `results/`, arms get 3
attempts, and the idle watchdog is 10 minutes.

## Verify

```bash
bun run check
bun test
bun run build
```
