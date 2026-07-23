# *terrarium* harness 🪴

Runs the same Linear ticket through two Codex workers — one in a control checkout, one in a Greptile checkout — and saves a complete, arm-separated record of every run.

## Setup

```bash
bun install
cp .env.example .env
```

Set the checkout paths in `.env`:

```dotenv
CONTROL_REPO=/absolute/path/to/control-checkout
GREPTILE_REPO=/absolute/path/to/greptile-checkout
```

Requires Bun, an authenticated Codex CLI, and two checkouts of the same commit.

## Run

```bash
bun start -- --ticket "Your ticket description"
```

Each invocation creates `results/<run-id>/`. Run-level files include the
manifest, exact ticket, generated prompt, and resolved configuration. The
`control/` and `greptile/` directories each contain the exact MCP request, raw
response, output or error, status and timing metadata, and a copy of the Codex
JSONL transcript when Codex returns a thread ID. Each autonomous retry is kept
in its own `attempt-01/`, `attempt-02/`, etc. directory. The CLI prints the
artifact directory with its result.

Set `RESULTS_DIR` to change the artifact root. If Codex stores sessions outside
`~/.codex`, set `CODEX_HOME` so the harness can find and copy each transcript.
Failed arms retry up to three times by default, continuing the same Codex thread
when possible. Set `MAX_ATTEMPTS` to another positive integer. Runs that exhaust
an arm's attempts are marked `completed_with_failures`; infrastructure failures
are marked `failed`.

## Verify

```bash
bun run check
bun test
bun run build
```
