# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An A/B harness that runs the **same Linear ticket through two Codex workers at
once** — a `control` arm and a `greptile` arm — and durably records everything
each one did, so the two outcomes can be compared. The only per-run input is
`--ticket`; which two checkouts run, and whether they're isolated in containers,
is deployment configuration set once in `.env`, never per ticket.

Each arm drives a real Codex session over MCP (`codex mcp-server`, stdio
transport). For real runs each arm's Codex runs inside its own Docker container
so it cannot see the other arm's checkout; the harness itself always runs on the
host and orchestrates both containers.

## Commands

```bash
bun install
bun start -- --ticket "..."   # headless run, prints artifact dir + JSON result
bun run live -- --ticket "..." # same run with a live Ink TUI (or line tee if no TTY)
bun run check                  # typecheck only (tsc --noEmit)
bun test                       # all tests
bun test test/config.test.ts   # single test file
bun test --test-name-pattern "watchdog"   # single test by name substring
bun run build                  # emit dist/ via tsconfig.build.json
```

Runtime is **Bun** (not Node) — use `bun`, not `npm`/`node`. Source is authored
in ESM TypeScript/TSX but imports use `.js` specifiers (NodeNext resolution),
so keep writing `./foo.js` in imports even though the file is `foo.ts`.

## Container setup (standard path for real runs)

All arm configuration lives in `.env` (`<ARM>_REPO`, `<ARM>_CONTAINER`,
`<ARM>_GH_TOKEN`, optionally `<ARM>_CODEX_HOME` / `<ARM>_WORKSPACE`). Both the
harness and `scripts/arm-run.sh` read it — nothing is passed on the command line.

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
  worker instruction. Both arms get the *identical* prompt; the only difference
  between arms is their checkout (and thus whether Greptile review context is
  present). Keep the prompt identical across arms — divergence there would
  confound the experiment.

- **`src/harness.ts`** — the orchestrator. `runHarness` runs both arms
  concurrently with `Promise.all`. `runArm` owns the **retry loop**
  (`maxAttempts`, default 3): on failure it re-invokes with a `retryPrompt`,
  continuing the *same Codex thread* via `codex-reply` when a `threadId` exists,
  otherwise restarting fresh with the recovery context prepended to the original
  task. In container mode it prepends `["docker","exec","-i","-w",workspace,
  container]` as the exec prefix and points Codex's cwd at the in-container
  workspace. `runner` (the arm launcher) and the two event sinks are injected —
  tests pass a fake runner instead of spawning real Codex.

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
  `rename`). The top-level `manifest.json` (`schemaVersion: 2`) is the source of
  truth for run status; manifest writes are **serialized through a promise
  chain** (`manifestWrite`) that swallows its own errors so one failed write
  can't poison later ones. After an arm finishes it locates that arm's Codex
  transcript under **that arm's** codex home (`arm.codexHome ?? config.codexHome`
  — see the container note above) `/sessions` by matching the `threadId` suffix
  and copies it in (`transcriptStatus` records copied / not-found / no-thread-id).

- **`src/live/`** — the TUI. `main.tsx` wires one `runHarness` call to a
  `LiveStore` and tees a human-readable `progress.log`; `store.ts` reduces raw
  `codex/event` messages into per-arm `ArmState`; `ui.tsx` is the Ink render.
  The live view and the durable artifacts come from the **same single run** —
  it's not a separate execution path. With no `CONTROL_REPO`/`GREPTILE_REPO`
  set, `main.tsx` falls back to a read-only demo against throwaway temp dirs so
  the feed can be exercised standalone.

## Run statuses

`completed` (both arms succeeded) · `completed_with_failures` (an arm exhausted
its retries — process exits 1) · `failed` (the harness itself threw). These
appear in both the CLI JSON result and `manifest.json`.

## Artifact layout

```
results/<run-id>/
  manifest.json ticket.txt prompt.txt config.json
  control/attempt-01/   request.json status.json response.json output.txt
                        error.txt transcript.jsonl
  greptile/attempt-01/  ...
  live-<ts>/progress.log   # written by the live view
```

## Testing notes

Tests inject a fake `AttemptRunner` into `runArm`/`runHarness` — no real Codex
process or container is spawned, so the suite runs offline. When changing the
retry/threading logic in `harness.ts` or the artifact schema in `artifacts.ts`,
update `test/harness.test.ts` / `test/artifacts.test.ts` accordingly.
