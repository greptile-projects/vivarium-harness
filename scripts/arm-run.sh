#!/usr/bin/env bash
# Start one vivarium arm's container from configuration in .env — no paths or
# secrets on the command line.
#
# Usage:  scripts/arm-run.sh <control|greptile>
#
# Reads these from .env (override the file with ENV_FILE=/path/to/env). <ARM> is
# CONTROL or GREPTILE:
#   <ARM>_CONTAINER    container name to start                        (required)
#   <ARM>_REPO         host checkout, bind-mounted at /workspace      (required)
#   <ARM>_GH_TOKEN     GitHub token for this arm            (optional, no default)
#   <ARM>_CODEX_HOME   host dir whose sessions/ is mounted into the container so
#                      the harness can copy transcripts. Defaults to
#                      ~/.vivarium/<container>, matching the harness default.
#
# The arm's checkout (at /workspace) is the only repo it can see; Codex auth is
# mounted read-only. Each arm gets its own sessions dir — the arms never share
# one, preserving isolation.
#
# Build the image once:  docker build -t vivarium-arm .
# Then:                  scripts/arm-run.sh control
#                        scripts/arm-run.sh greptile
set -euo pipefail

arm="${1:?arm to start: control or greptile}"
case "$arm" in
  control | greptile) ;;
  *)
    echo "error: arm must be 'control' or 'greptile', got '$arm'" >&2
    exit 1
    ;;
esac

# Load the same .env the harness reads, so arm config lives in one place.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${ENV_FILE:-$root/.env}"
if [[ ! -f "$env_file" ]]; then
  echo "error: no env file at $env_file (copy .env.example to .env)" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

prefix="$(printf '%s' "$arm" | tr '[:lower:]' '[:upper:]')"
container_var="${prefix}_CONTAINER"
repo_var="${prefix}_REPO"
token_var="${prefix}_GH_TOKEN"
home_var="${prefix}_CODEX_HOME"

container="${!container_var:-}"
repo="${!repo_var:-}"
token="${!token_var:-}"
arm_home="${!home_var:-}"

: "${container:?$container_var must be set in $env_file}"
: "${repo:?$repo_var must be set in $env_file}"

image="${VIVARIUM_IMAGE:-vivarium-arm}"
arm_home="${arm_home:-$HOME/.vivarium/$container}"

# Host sink for this arm's Codex sessions; created before mounting so Docker
# does not materialize it as a root-owned directory.
mkdir -p "$arm_home/sessions"

# Build argv as an array so the optional token flags stay correctly split into
# separate `-e` / `KEY=value` words.
run_args=(
  -d --rm
  --name "$container"
  -v "$repo:/workspace"
  -v "$HOME/.codex/auth.json:/codex/auth.json:ro"
  -v "$arm_home/sessions:/codex/sessions"
)
if [[ -n "$token" ]]; then
  run_args+=(-e "GH_TOKEN=$token" -e "GITHUB_TOKEN=$token")
fi

docker run "${run_args[@]}" "$image"

echo "started $container  (repo: $repo, sessions: $arm_home/sessions)"
