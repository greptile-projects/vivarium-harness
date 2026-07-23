# terrarium harness

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

Edit `.env` and point it at two checkouts of the same commit:

```dotenv
CONTROL_REPO=/absolute/path/to/control-checkout
GREPTILE_REPO=/absolute/path/to/greptile-checkout
```

Build the arm image once, then start one container per arm (each mounts only its
own checkout at `/workspace`; the third argument is that arm's GitHub token):

```bash
docker build -t terrarium-arm .
scripts/arm-run.sh terrarium-control /absolute/path/to/control-checkout <gh-token>
scripts/arm-run.sh terrarium-greptile /absolute/path/to/greptile-checkout <gh-token>
```

`.env.example` already points the harness at these container names:

```dotenv
CONTROL_CONTAINER=terrarium-control
GREPTILE_CONTAINER=terrarium-greptile
```

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
- `CODEX_IDLE_TIMEOUT_MS` — abort an arm after this much event silence
  (default `600000`, 10m)

## Running without containers

Leaving `CONTROL_CONTAINER` / `GREPTILE_CONTAINER` unset runs both arms directly
on the host, where either arm can read the other's checkout. This has no
isolation and is only for a throwaway local smoke test — use containers for any
real run.

## Verify

```bash
bun run check
bun test
bun run build
```
