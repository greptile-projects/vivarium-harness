#!/usr/bin/env bash
# Start one fresh Vivarium arm microVM from .env, attach only controlled
# read-only host inputs, then hand all in-VM setup to the template's single
# bootstrap entrypoint.
set -euo pipefail

arm="${1:?arm to start: komodo or tuatara}"
case "$arm" in
  komodo | tuatara) ;;
  *) echo "error: arm must be komodo or tuatara, got '$arm'" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${ENV_FILE:-$root/.env}"
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

prefix="$(printf '%s' "$arm" | tr '[:lower:]' '[:upper:]')"
sandbox_var="${prefix}_SANDBOX"
repo_var="${prefix}_REPO"
token_var="${prefix}_GH_TOKEN"
sandbox="${VIVARIUM_SANDBOX_NAME:-${!sandbox_var:-}}"
repo="${!repo_var:-}"
token="${!token_var:-}"
template="vivarium-arm:latest"
scratch="${VIVARIUM_WORKSPACE_MOUNT:-/tmp/$sandbox-host}"
ladder_mount="${VIVARIUM_LADDER_MOUNT:-$scratch-ladder}"

: "${sandbox:?$sandbox_var must be set in $env_file}"
: "${repo:?$repo_var must be set in $env_file}"
: "${token:?$token_var must be set in $env_file}"
[[ "$repo" =~ ^https://github\.com/[^/]+/[^/]+(\.git)?$ ]] || {
  echo "error: $repo_var must be a plain HTTPS GitHub clone URL" >&2
  exit 1
}

mkdir -p "$scratch"
chmod 0700 "$scratch"
if [[ ! -f "$ladder_mount/LADDER.md" ]]; then
  mkdir -p "$ladder_mount"
  cp "$root/LADDER.md" "$ladder_mount/LADDER.md"
fi

case "$arm" in
  komodo) host_port=6080 ;;
  tuatara) host_port=6081 ;;
esac
init_log="/tmp/$sandbox-init.log"

printf '%s' "$token" | sbx secret set "$sandbox" github >/dev/null
sbx create \
  --no-share-skills \
  --name "$sandbox" \
  --cpus 4 \
  --memory 8g \
  --template "$template" \
  --publish "127.0.0.1:$host_port:6080/tcp4" \
  codex "$scratch" "$ladder_mount:ro"

# The proxy replaces this sentinel only on requests to GitHub. The arm never
# receives the real token as an environment variable, file, remote URL, or
# argv. vivarium-init clones, configures identity, waits for private Docker,
# and finally becomes the long-lived GUI supervisor.
nohup sbx exec -d \
  -e GH_TOKEN=proxy-managed \
  -e GITHUB_TOKEN=proxy-managed \
  -e DISPLAY=:99 \
  "$sandbox" vivarium-init "$repo" "$ladder_mount/LADDER.md" \
  >"$init_log" 2>&1 </dev/null &
init_client_pid=$!
init_client_done=false
init_client_rc=0
ready=false
for _ in $(seq 1 120); do
  if curl -fsS --max-time 1 \
    "http://127.0.0.1:$host_port/vnc.html" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if [[ "$init_client_done" == false ]] &&
    ! kill -0 "$init_client_pid" 2>/dev/null; then
    if wait "$init_client_pid"; then
      init_client_rc=0
    else
      init_client_rc=$?
    fi
    init_client_done=true
    if [[ "$init_client_rc" -ne 0 ]]; then
      break
    fi
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  kill -KILL "$init_client_pid" 2>/dev/null || true
  wait "$init_client_pid" 2>/dev/null || true
  tail -n 60 "$init_log" >&2 || true
  sbx exec "$sandbox" bash -lc 'tail -n 30 /var/log/vivarium/*.log' >&2 || true
  exit 1
fi
# sbx 0.37.1 keeps its local client attached to a healthy detached exec. Leave
# that client alive, with every host descriptor redirected, so the sandbox
# stays warm between deterministic harness commands. `sbx rm` ends it with the
# remote session during normal cleanup.
disown "$init_client_pid" 2>/dev/null || true

echo "started $sandbox ($arm — private Docker, clone, and GUI ready)"
echo "  screen: http://127.0.0.1:$host_port/vnc.html"
