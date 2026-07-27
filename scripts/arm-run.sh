#!/usr/bin/env bash
# Start one vivarium arm's container from configuration in .env — no paths or
# secrets on the command line.
#
# Usage:  scripts/arm-run.sh <komodo|tuatara>
#
# Reads these from .env (override the file with ENV_FILE=/path/to/env). <ARM> is
# KOMODO or TUATARA:
#   <ARM>_CONTAINER    container name to start                        (required)
#   <ARM>_REPO         host checkout, bind-mounted at /workspace      (required)
#   <ARM>_GH_TOKEN     GitHub token for this arm            (optional, no default)
#   <ARM>_CODEX_HOME   host dir whose sessions/ is mounted into the container so
#                      the harness can copy transcripts. Defaults to
#                      ~/.vivarium/<container>, matching the harness default.
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
# The arm's checkout (at /workspace) is the only repo it can see; Codex auth is
# mounted read-only. Each arm gets its own sessions dir and its own
# /var/lib/docker volume — the arms never share either, preserving isolation.
# The nested engine is deliberately not the host's socket: see the Dockerfile.
#
# Build the image once:  docker build -t vivarium-arm .
# Then:                  scripts/arm-run.sh komodo
#                        scripts/arm-run.sh tuatara
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
home_var="${prefix}_CODEX_HOME"
novnc_var="${prefix}_NOVNC_PORT"

container="${!container_var:-}"
repo="${!repo_var:-}"
token="${!token_var:-}"
arm_home="${!home_var:-}"
novnc_port="${!novnc_var:-}"

: "${container:?$container_var must be set in $env_file}"
: "${repo:?$repo_var must be set in $env_file}"

image="${VIVARIUM_IMAGE:-vivarium-arm}"
arm_home="${arm_home:-$HOME/.vivarium/$container}"
want_docker="${VIVARIUM_DOCKER:-1}"
want_gui="${VIVARIUM_GUI:-1}"

# One published port per arm, because two containers cannot share one. The
# default differs by arm for that reason alone — inside the container both
# screens are :99 on port 6080, so nothing the arm can observe differs.
if [[ -z "$novnc_port" ]]; then
  case "$arm" in
    komodo) novnc_port=6080 ;;
    tuatara) novnc_port=6081 ;;
  esac
fi

# Host sink for this arm's Codex sessions; created before mounting so Docker
# does not materialize it as a root-owned directory.
mkdir -p "$arm_home/sessions"

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

# Each arm gets a user-defined bridge network of its own. On Docker's default
# bridge every container can reach every other, and the GUI stack listens on
# 0.0.0.0 *inside* the container — so from the default bridge, one arm could
# find the other's noVNC port and watch (or drive) its passwordless screen,
# and mere reachability already proves another container exists. Containers on
# different user-defined bridges cannot route to each other, while outbound
# traffic (GitHub, package registries) is unaffected.
network="$container-net"
docker network inspect "$network" >/dev/null 2>&1 ||
  docker network create "$network" >/dev/null

# Build argv as an array so the optional token flags stay correctly split into
# separate `-e` / `KEY=value` words.
run_args=(
  -d --rm
  --name "$container"
  --network "$network"
  -v "$repo:/workspace"
  -v "$HOME/.codex/auth.json:/codex/auth.json:ro"
  -v "$arm_home/sessions:/codex/sessions"
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
  run_args+=(--privileged -v "$container-docker:/var/lib/docker")
fi

# The arm's screen, published on the host's loopback only — x11vnc runs with no
# password, and this port is a live view of a root browser session.
if [[ "$want_gui" != "0" ]]; then
  run_args+=(-p "127.0.0.1:$novnc_port:6080")
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
  echo "  docker: nested engine $(docker exec "$container" docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') on its own /var/lib/docker ($container-docker)"
fi
if [[ "$want_gui" != "0" ]]; then
  echo "  screen: http://127.0.0.1:$novnc_port/vnc.html  (chromium: \`docker exec $container browser <url>\`)"
fi
