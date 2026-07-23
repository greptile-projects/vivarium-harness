# vivarium harness

Runs the same Linear ticket through two Codex workers at once — one against a
control checkout, one against a Greptile checkout — and saves everything each
one did.

## Setup

```bash
bun install
cp .env.example .env
```

Edit `.env` and point it at two checkouts of the same commit:

```dotenv
CONTROL_REPO=/absolute/path/to/control-checkout
GREPTILE_REPO=/absolute/path/to/greptile-checkout
```

Requires Bun and an authenticated Codex CLI.

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

Failed arms retry up to 3 times by default (set `MAX_ATTEMPTS` to change
that). A run that exhausts its retries is marked `completed_with_failures`;
a run that fails for infrastructure reasons is marked `failed`.

## Greg Tile (the planner)

A single ticket runs one rung. Greg Tile climbs the whole ladder. Greg is a
stateless Codex planner sitting on top of the harness: each turn he plans the
next rung toward a North Star, files a Linear ticket for it, appends it to a
shared ladder file, then mechanically runs the two-arm harness on it. Repeat.

```bash
bun run greg -- --north-star "Build a working clone of GitHub" --max-rungs 10
```

Greg himself has no memory across rungs — his only state is `LADDER.md`, which
lists the North Star and every rung planned and built so far. That file is
symlinked into both checkouts (the local stand-in for the docker bind mount the
experiment uses), so both build arms can see where the work is going.

The loop is deliberately mechanical: Greg (the agent) only plans one rung and,
if a Linear MCP is configured in your Codex environment, files a ticket for it.
Running the harness is not one of Greg's tool calls — the loop calls it directly
in code. Each rung's Codex session is fresh (no thread continuity), and each
rung's harness run writes its own `results/<run-id>/` as usual.

Greg reads two files' worth of context: the North Star and the ladder. He stops
early if he reports the North Star is reached, otherwise after `--max-rungs`.

Greg options (flags override env):

- `--north-star <text>` / `GREG_NORTH_STAR` — the eventual goal
- `--ladder <path>` / `GREG_LADDER` — canonical ladder file (default `./LADDER.md`)
- `--max-rungs <count>` / `GREG_MAX_RUNGS` — rungs before stopping (default 10)
- `GREG_SANDBOX` — Greg's own sandbox (default `read-only`; the builder arms
  keep their own `CODEX_SANDBOX`)

Under docker isolation, skip the symlink and bind-mount the canonical ladder to
`LADDER.md` inside each arm's container instead; Greg leaves any pre-existing
file at that path untouched.

Other env vars, all optional:

- `RESULTS_DIR` — where artifacts go (default `results`)
- `CODEX_HOME` — where to find Codex sessions, if not `~/.codex`

## Container isolation (optional)

By default both arms run on your host, and either one could technically read
the other's checkout. To actually isolate them, run each arm's Codex in its
own container:

```bash
docker build -t vivarium-arm .
scripts/arm-run.sh vivarium-control /abs/path/to/control-checkout <gh-token>
scripts/arm-run.sh vivarium-greptile /abs/path/to/greptile-checkout <gh-token>
```

Then point the harness at them in `.env`:

```dotenv
CONTROL_CONTAINER=vivarium-control
GREPTILE_CONTAINER=vivarium-greptile
```

## Verify

```bash
bun run check
bun test
bun run build
```
