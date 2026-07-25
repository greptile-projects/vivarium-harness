#!/usr/bin/env bash
# Start one vivarium arm's container from configuration in .env — no paths or
# secrets on the command line.
#
# Usage:  scripts/arm-run.sh <komodo|tuatara>
#         scripts/arm-run.sh <control|greptile>   # the same two arms, by internal id
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
# Then:                  scripts/arm-run.sh komodo
#                        scripts/arm-run.sh tuatara
set -euo pipefail

arm="${1:?arm to start: komodo or tuatara}"
# The internal identifiers are `control`/`greptile` (they key the env vars and
# the artifact directories); everything human-facing calls the arms Komodo and
# Tuatara. Accept either, so nobody has to remember that `control` starts a
# container named vivarium-komodo.
case "$arm" in
  komodo) arm=control ;;
  tuatara) arm=greptile ;;
  control | greptile) ;;
  *)
    echo "error: arm must be control/komodo or greptile/tuatara, got '$arm'" >&2
    exit 1
    ;;
esac

# What this arm is called in human-facing output, and the identity its commits
# carry — so `git log` in the checkout says which arm wrote a line.
case "$arm" in
  control) display=komodo ;;
  greptile) display=tuatara ;;
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

# The identity this arm's commits carry. Ask GitHub who the arm's token is and
# commit as that account, so every line on main is attributed to the arm that
# wrote it — the comparison is the whole point, and an unrecognized address
# would leave both arms anonymous in the GitHub UI. Falls back to the arm's
# display name when there is no token or no network; that still tells the arms
# apart locally, which is the part that must not depend on GitHub being up.
git_name="$display"
git_email="$display@vivarium.invalid"
if [[ -n "$token" ]]; then
  identity="$(GH_TOKEN="$token" gh api user --jq '[.login, .id] | @tsv' 2>/dev/null || true)"
  if [[ -n "$identity" ]]; then
    login="${identity%%$'\t'*}"
    user_id="${identity##*$'\t'}"
    git_name="$login"
    git_email="${user_id}+${login}@users.noreply.github.com"
  else
    echo "warning: could not resolve $token_var's GitHub account; committing as $git_email" >&2
  fi
fi

# Build argv as an array so the optional token flags stay correctly split into
# separate `-e` / `KEY=value` words.
run_args=(
  -d --rm
  --name "$container"
  -v "$repo:/workspace"
  -v "$HOME/.codex/auth.json:/codex/auth.json:ro"
  -v "$arm_home/sessions:/codex/sessions"
  # Overrides the image's fallback identity. Both author and committer, because
  # git falls back to asking for user.name if either pair is incomplete.
  -e "GIT_AUTHOR_NAME=$git_name"
  -e "GIT_AUTHOR_EMAIL=$git_email"
  -e "GIT_COMMITTER_NAME=$git_name"
  -e "GIT_COMMITTER_EMAIL=$git_email"
)
if [[ -n "$token" ]]; then
  run_args+=(-e "GH_TOKEN=$token" -e "GITHUB_TOKEN=$token")
fi

# The ladder is Greg's durable state and the arms read it from inside the
# container. `linkLadder` leaves a symlink at <repo>/LADDER.md pointing at an
# absolute *host* path, which dangles in here — so mount the real file over that
# spot instead, read-only, since only Greg ever writes it. Greg writes the
# ladder in place rather than through a temp file and a rename, so the mount
# keeps showing the current text rather than pinning the inode it started on.
#
# Dereferenced first, because Docker mounts the host path literally: a symlinked
# source would arrive in the container as a link to a path that is not there.
ladder="$root/LADDER.md"
if [[ -L "$ladder" ]]; then
  target="$(readlink "$ladder")"
  if [[ "$target" != /* ]]; then
    target="$(cd "$root" && cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
  fi
  ladder="$target"
fi
if [[ -f "$ladder" ]]; then
  # The mount target has to already exist as a plain file. A symlink would be
  # resolved rather than covered, and Docker Desktop cannot create the mount
  # point itself here — /workspace is a virtiofs bind mount, and creating a
  # file inside one fails with "mountpoint is outside of rootfs".
  if [[ -L "$repo/LADDER.md" ]]; then rm "$repo/LADDER.md"; fi
  if [[ ! -e "$repo/LADDER.md" ]]; then : > "$repo/LADDER.md"; fi
  run_args+=(-v "$ladder:/workspace/LADDER.md:ro")
fi

docker run "${run_args[@]}" "$image"

echo "started $container  ($display — repo: $repo, sessions: $arm_home/sessions)"
