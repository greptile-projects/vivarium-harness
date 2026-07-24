# vivarium harness

runs the same Linear ticket through two Codex workers at once and saves
everything each one did, so you can compare them.

the two workers are called *arms*:

- **control** — a plain checkout, no Greptile.
- **greptile** — the same checkout, but its work gets Greptile reviews fed back.

both arms start from the same commit and get the exact same ticket. the only
thing that differs is whether Greptile is in the loop, so any difference in the
result is down to Greptile.

## how it works

the harness runs on your host and does four things:

1. **builds one prompt** from your ticket — the same prompt for both arms.
2. **runs both arms in parallel.** each arm is a Codex session driven over MCP.
   the harness streams Codex's live events (files touched, commands run) as they
   happen, so nothing is a black box.
3. **retries a failing arm** up to 3 times. it resumes the same Codex thread
   where it can, otherwise restarts fresh with the error as context. an arm that
   uses up its retries is marked failed; the other arm keeps going regardless.
4. **saves everything** to `results/<run-id>/` — the ticket, the prompt, and
   every request, response, status, and transcript from each arm and attempt.

each arm's Codex runs in its own Docker container, so one arm can't read the
other's checkout, the harness, or the host. the harness talks to both containers
over MCP.

## prerequisites

- [Bun](https://bun.sh)
- Docker
- an authenticated Codex CLI (`~/.codex/auth.json`, mounted read-only into each
  container)

## setup

```bash
bun install
cp .env.example .env
```

`.env` is the one place all arm config lives — checkouts, container names, and
each arm's GitHub token. both the harness and `scripts/arm-run.sh` read it, so
nothing goes on the command line. point it at two checkouts of the same commit:

```dotenv
CONTROL_REPO=/absolute/path/to/control-checkout
GREPTILE_REPO=/absolute/path/to/greptile-checkout
CONTROL_CONTAINER=vivarium-control     # already set in .env.example
GREPTILE_CONTAINER=vivarium-greptile
CONTROL_GH_TOKEN=ghp_...               # this arm's identity when it opens PRs
GREPTILE_GH_TOKEN=ghp_...
```

build the arm image once, then start one container per arm. `arm-run.sh` takes
only the arm name and reads the rest from `.env`:

```bash
docker build -t vivarium-arm .
scripts/arm-run.sh control
scripts/arm-run.sh greptile
```

each container mounts only its own arm's checkout at `/workspace`, mounts Codex
auth read-only, and writes its Codex sessions to a per-arm host directory
(`~/.vivarium/<container>/sessions` by default) so the harness can copy each
transcript into the run's artifacts. the arms never share a sessions directory.
to move it, set `<ARM>_CODEX_HOME` in `.env` — both `arm-run.sh` and the harness
read the same value.

## run

```bash
bun start -- --ticket "your ticket description"
```

for a live view of both arms as they work:

```bash
bun run live -- --ticket "your ticket description"
```

when it finishes, the CLI prints the run's artifact directory.

## what you get

every run writes to `results/<run-id>/`:

- the ticket, generated prompt, and config, at the top level.
- a `control/` and a `greptile/` directory, each holding that arm's MCP
  request and response, status, timing, and a copy of the Codex transcript.
- one `attempt-01/`, `attempt-02/`, … subdirectory per try, so retries are kept
  separately.

a run where every arm succeeds is `completed`; one where an arm used up its
retries is `completed_with_failures`; a run that breaks for infrastructure
reasons is `failed`.

## config

everything below is optional and lives in `.env`:

- `MAX_ATTEMPTS` — tries per arm, including the first (default `3`).
- `RESULTS_DIR` — where artifacts go (default `results`).
- `CODEX_HOME` — where to find Codex sessions (default `~/.codex`).
- `CODEX_IDLE_TIMEOUT_MS` — abort an arm after this much silence with no events
  (default `600000`, 10 minutes).
- `CODEX_SANDBOX` — Codex sandbox mode (default `workspace-write`).

## verify

```bash
bun run check
bun test
bun run build
```
