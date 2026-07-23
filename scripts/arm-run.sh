#!/usr/bin/env bash
# Start one terrarium arm container with an isolated filesystem: only this arm's
# checkout is mounted (at /workspace), so it cannot see the other arm's repo, the
# harness, or the host. Codex auth is mounted read-only; the GitHub token is this
# arm's identity.
#
# Build the image once:   docker build -t terrarium-arm .
# Start an arm:           scripts/arm-run.sh terrarium-control /abs/control-checkout <gh-token>
#
# Point the harness at it via env:
#   CONTROL_CONTAINER=terrarium-control CONTROL_REPO=/abs/control-checkout
set -euo pipefail

name="${1:?container name, e.g. terrarium-control}"
checkout="${2:?absolute path to this arm's checkout}"
token="${3:-}"
image="${TERRARIUM_IMAGE:-terrarium-arm}"

docker run -d --rm \
  --name "$name" \
  -v "$checkout:/workspace" \
  -v "$HOME/.codex/auth.json:/codex/auth.json:ro" \
  ${token:+-e GH_TOKEN="$token"} \
  ${token:+-e GITHUB_TOKEN="$token"} \
  "$image"

echo "started $name  (checkout: $checkout)"
