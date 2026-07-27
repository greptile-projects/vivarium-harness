#!/usr/bin/env bash
# Start one vivarium arm's container from configuration in .env — no paths or
# secrets on the command line.
#
# Usage:  scripts/arm-run.sh <komodo|tuatara>
#
# Reads these from .env (override the file with ENV_FILE=/path/to/env). <ARM> is
# KOMODO or TUATARA:
#   <ARM>_CONTAINER    base name for the per-subticket container      (required)
#   <ARM>_REPO         HTTPS GitHub URL cloned into /workspace        (required)
#   <ARM>_GH_TOKEN     GitHub token used to clone/push/open PRs          (required)
#   <ARM>_NOVNC_PORT   host port for this arm's screen, published on 127.0.0.1
#                      only. Defaults: komodo 6080, tuatara 6081 — the arms must
#                      differ here or the second container fails to start.
#
# Run-wide, and identical for both arms (they are the experiment's controlled
# environment, not per-arm configuration):
#   VIVARIUM_DOCKER    1 (default) gives the arm its own nested Docker engine,
#                      which needs --privileged. 0 skips it.
#   VIVARIUM_GUI       1 (default) starts X + a window manager + VNC/noVNC.
#   VIVARIUM_SCREEN    Xvfb geometry. Default 1440x900x24.
#
# The arm's private clone (at /workspace) is the only repo it can see; Codex
# auth is mounted read-only. Each invocation gets its own /var/lib/docker
# volume; no Codex session directory is mounted. The harness copies transcripts
# out before it destroys the container.
# The nested engine is deliberately not the host's socket: see the Dockerfile.
#
# Build the image once:  docker build -t vivarium-arm .
# The harness invokes this script with unique runtime resource names.
set -euo pipefail

arm="${1:?arm to start: komodo or tuatara}"
case "$arm" in
  komodo | tuatara) ;;
  *)
    echo "error: arm must be komodo or tuatara, got '$arm'" >&2
    exit 1
    ;;
esac

# The identity this arm's commits carry — so `git log` in the checkout says
# which arm wrote a line.
display="$arm"

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
novnc_var="${prefix}_NOVNC_PORT"

container="${VIVARIUM_CONTAINER_NAME:-${!container_var:-}}"
repo="${!repo_var:-}"
token="${!token_var:-}"
novnc_port="${!novnc_var:-}"

: "${container:?$container_var must be set in $env_file}"
: "${repo:?$repo_var must be set in $env_file}"
: "${token:?$token_var must be set in $env_file so the arm can clone, push, and open pull requests}"
case "$repo" in
  https://github.com/*/*) ;;
  *)
    echo "error: $repo_var must be an HTTPS GitHub clone URL, got '$repo'" >&2
    exit 1
    ;;
esac
case "$repo" in
  https://*@*)
    echo "error: $repo_var must not contain credentials; use $token_var" >&2
    exit 1
    ;;
esac

image="${VIVARIUM_IMAGE:-vivarium-arm}"
want_docker="${VIVARIUM_DOCKER:-1}"
want_gui="${VIVARIUM_GUI:-1}"
docker_volume="${VIVARIUM_DOCKER_VOLUME:-$container-docker}"

# One published port per arm, because two containers cannot share one. The
# default differs by arm for that reason alone — inside the container both
# screens are :99 on port 6080, so nothing the arm can observe differs.
if [[ -z "$novnc_port" ]]; then
  case "$arm" in
    komodo) novnc_port=6080 ;;
    tuatara) novnc_port=6081 ;;
  esac
fi

# Mounting a nonexistent file makes Docker create a *directory* at both ends,
# which breaks Codex auth confusingly later — fail here with a clear message.
if [[ ! -f "$HOME/.codex/auth.json" ]]; then
  echo "error: $HOME/.codex/auth.json not found — log in with codex on the host first" >&2
  exit 1
fi

# The identity this arm's commits carry. Ask GitHub who the arm's token is and
# commit as that account, so every line on main is attributed to the arm that
# wrote it — the comparison is the whole point, and an unrecognized address
# would leave both arms anonymous in the GitHub UI. Falls back to the arm's
# display name when GitHub cannot be reached; that still tells the arms apart
# locally, which is the part that must not depend on GitHub being up.
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

# Each arm gets a user-defined bridge network of its own. On Docker's default
# bridge every container can reach every other, and the GUI stack listens on
# 0.0.0.0 *inside* the container — so from the default bridge, one arm could
# find the other's noVNC port and watch (or drive) its passwordless screen,
# and mere reachability already proves another container exists. Containers on
# different user-defined bridges cannot route to each other, while outbound
# traffic (GitHub, package registries) is unaffected.
network="${VIVARIUM_NETWORK_NAME:-$container-net}"
docker network inspect "$network" >/dev/null 2>&1 ||
  docker network create "$network" >/dev/null

# Build argv as an array so the optional token flags stay correctly split into
# separate `-e` / `KEY=value` words.
run_args=(
  -d
  --name "$container"
  --network "$network"
  --label "vivarium.arm=$arm"
  --label "vivarium.ephemeral=true"
  -v "$HOME/.codex/auth.json:/codex/auth.json:ro"
  # Overrides the image's fallback identity. Both author and committer, because
  # git falls back to asking for user.name if either pair is incomplete.
  -e "GIT_AUTHOR_NAME=$git_name"
  -e "GIT_AUTHOR_EMAIL=$git_email"
  -e "GIT_COMMITTER_NAME=$git_name"
  -e "GIT_COMMITTER_EMAIL=$git_email"
  -e "VIVARIUM_DOCKER=$want_docker"
  -e "VIVARIUM_GUI=$want_gui"
  # Chromium's default 64MB /dev/shm is where it dies part-way through a page
  # rather than at startup, which reads as a flaky test rather than a missing
  # resource. The flags file in the image also passes --disable-dev-shm-usage;
  # this is the half that helps anything the arm launches without it.
  --shm-size=1g
)
if [[ -n "${VIVARIUM_RUN_ID:-}" ]]; then
  run_args+=(--label "vivarium.run=$VIVARIUM_RUN_ID")
fi
if [[ -n "${VIVARIUM_SCREEN:-}" ]]; then
  run_args+=(-e "VIVARIUM_SCREEN=$VIVARIUM_SCREEN")
fi
if [[ -n "$token" ]]; then
  run_args+=(-e "GH_TOKEN=$token" -e "GITHUB_TOKEN=$token")
fi

# The nested Docker engine. --privileged is what it costs; the alternative —
# mounting the host's /var/run/docker.sock — is not a cheaper version of this
# but a different thing entirely, and it would end the isolation between the
# arms (one `docker run -v /:/host` reaches the other arm's checkout, `.env`
# with both tokens, and results/). The volume is per arm and never shared: it
# is the engine's whole state, so sharing it would be a channel between them.
if [[ "$want_docker" != "0" ]]; then
  run_args+=(--privileged -v "$docker_volume:/var/lib/docker")
fi

# The arm's screen, published on the host's loopback only — x11vnc runs with no
# password, and this port is a live view of a root browser session.
if [[ "$want_gui" != "0" ]]; then
  run_args+=(-p "127.0.0.1:$novnc_port:6080")
fi

# The ladder is Greg's durable state. Mount it outside the clone, then link it
# into /workspace after cloning. Mounting it directly at /workspace/LADDER.md
# would make /workspace non-empty before `git clone` runs.
ladder="$root/LADDER.md"
if [[ -L "$ladder" ]]; then
  target="$(readlink "$ladder")"
  if [[ "$target" != /* ]]; then
    target="$(cd "$root" && cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
  fi
  ladder="$target"
fi
if [[ ! -e "$ladder" ]]; then
  # The container's mounts cannot be added later. Greg initializes this empty
  # file in place on the first `bun start`, and the read-only mount sees that
  # same inode become the real ladder.
  : > "$ladder"
fi
if [[ ! -f "$ladder" ]]; then
  echo "error: ladder path is not a file: $ladder" >&2
  exit 1
fi
run_args+=(--mount "type=bind,source=$ladder,target=/vivarium/LADDER.md,readonly")

docker run "${run_args[@]}" "$image"

echo "started $container  ($display — cloning: $repo)"

# The checkout belongs to the container: no host path is mounted at /workspace.
# Authentication comes from GH_TOKEN in the container and the image's
# `gh auth git-credential` helper, so the token never enters the remote URL.
if ! docker exec -i -w / "$container" git clone --origin origin "$repo" /workspace; then
  echo "error: $container could not clone $repo into /workspace" >&2
  exit 1
fi
docker exec -i "$container" ln -s /vivarium/LADDER.md /workspace/LADDER.md

# dockerd and the X server take a few seconds, and the harness execs a codex
# session in as soon as it is told to. An arm that starts a subticket before its
# engine is up discovers it halfway through, after the work is done — the same
# class of failure the image's git identity and PATH lines exist to head off. So
# block here, and report what is wrong rather than leaving it in a log nobody
# opens.
if [[ "$want_docker" != "0" || "$want_gui" != "0" ]]; then
  printf 'waiting for services in %s' "$container"
  ready=0
  for _ in $(seq 1 90); do
    if docker exec "$container" test -f /run/vivarium/ready 2>/dev/null; then
      ready=1
      break
    fi
    if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
      break
    fi
    printf '.'
    sleep 1
  done
  echo
  if [[ "$ready" != 1 ]]; then
    echo "error: $container came up degraded — its services did not all start" >&2
    docker exec "$container" sh -c 'tail -n 20 /var/log/vivarium/*.log' >&2 2>&1 || true
    exit 1
  fi
fi

if [[ "$want_docker" != "0" ]]; then
  echo "  docker: nested engine $(docker exec "$container" docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') on fresh /var/lib/docker ($docker_volume)"
fi
if [[ "$want_gui" != "0" ]]; then
  echo "  screen: http://127.0.0.1:$novnc_port/vnc.html  (chromium: \`docker exec $container browser <url>\`)"
fi
