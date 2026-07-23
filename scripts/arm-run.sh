#!/usr/bin/env bash
# Start one terrarium arm container with an isolated filesystem: only this arm's
# checkout is mounted (at /workspace), so it cannot see the other arm's repo, the
# harness, or the host. Codex auth is mounted read-only; the GitHub token is this
# arm's identity.
#
# The container's CODEX_HOME is /codex, so Codex writes its session transcript to
# /codex/sessions. That directory is bind-mounted back to a per-arm host dir
# ($HOME/.terrarium/<name>/sessions by default) so the harness can copy the
# transcript into the run artifacts. Each arm gets its own host dir — the arms
# never share a sessions directory, preserving isolation. Override the host dir
# with CODEX_ARM_HOME, and point the harness at the same place via
# CONTROL_CODEX_HOME / GREPTILE_CODEX_HOME.
#
# Build the image once:   docker build -t terrarium-arm .
# Start an arm:           scripts/arm-run.sh terrarium-control /abs/control-checkout <gh-token>
#
# Point the harness at it via env:
#   CONTROL_CONTAINER=terrarium-control CONTROL_REPO=/abs/control-checkout
set -euo pipefail

name="${1:?container name, e.g. terrarium-control}"
checkout="${2:?absolute path to this arm checkout}"
token="${3:-}"
image="${TERRARIUM_IMAGE:-terrarium-arm}"
arm_home="${CODEX_ARM_HOME:-$HOME/.terrarium/$name}"

# Host sink for this arm's Codex sessions; created before mounting so Docker
# doesn't materialize it as a root-owned directory.
mkdir -p "$arm_home/sessions"

# Build argv as an array so the optional token flags stay correctly split into
# separate `-e` / `KEY=value` words. Inlining `${token:+-e GH_TOKEN="$token"}`
# does not: the whole thing collapses into one argv element, so docker never
# sees a valid -e flag and the container starts without GitHub auth.
run_args=(
  -d --rm
  --name "$name"
  -v "$checkout:/workspace"
  -v "$HOME/.codex/auth.json:/codex/auth.json:ro"
  -v "$arm_home/sessions:/codex/sessions"
)
if [[ -n "$token" ]]; then
  run_args+=(-e "GH_TOKEN=$token" -e "GITHUB_TOKEN=$token")
fi

docker run "${run_args[@]}" "$image"

echo "started $name  (checkout: $checkout, sessions: $arm_home/sessions)"
