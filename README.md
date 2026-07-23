# terrarium harness

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

Other env vars, all optional:

- `RESULTS_DIR` — where artifacts go (default `results`)
- `CODEX_HOME` — where to find Codex sessions, if not `~/.codex`

## Container isolation (optional)

By default both arms run on your host, and either one could technically read
the other's checkout. To actually isolate them, run each arm's Codex in its
own container:

```bash
docker build -t terrarium-arm .
scripts/arm-run.sh terrarium-control /abs/path/to/control-checkout <gh-token>
scripts/arm-run.sh terrarium-greptile /abs/path/to/greptile-checkout <gh-token>
```

Then point the harness at them in `.env`:

```dotenv
CONTROL_CONTAINER=terrarium-control
GREPTILE_CONTAINER=terrarium-greptile
```

## Verify

```bash
bun run check
bun test
bun run build
```
