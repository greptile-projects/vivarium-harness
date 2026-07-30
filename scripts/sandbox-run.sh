#!/usr/bin/env bash
# Start one fresh Vivarium arm microVM from .env, attach only controlled
# read-only host inputs, install its proxy-managed GitHub identity, clone into
# private VM storage, and start the headed browser service.
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
# receives the real token as an environment variable or file.
remote=(sbx exec -e GH_TOKEN=proxy-managed -e GITHUB_TOKEN=proxy-managed "$sandbox")
"${remote[@]}" sudo install -d -o agent -g agent /workspace
"${remote[@]}" git clone --origin origin "$repo" /workspace
"${remote[@]}" ln -s "$ladder_mount/LADDER.md" /workspace/LADDER.md

identity="$("${remote[@]}" gh api user --jq '[.login, .id] | @tsv')"
login="${identity%%$'\t'*}"
user_id="${identity##*$'\t'}"
"${remote[@]}" git -C /workspace config user.name "$login"
"${remote[@]}" git -C /workspace config user.email \
  "${user_id}+${login}@users.noreply.github.com"

sbx exec -d -e DISPLAY=:99 "$sandbox" vivarium-gui
for _ in $(seq 1 30); do
  sbx exec "$sandbox" test -f /run/vivarium/ready && break
  sleep 1
done
sbx exec "$sandbox" test -f /run/vivarium/ready || {
  sbx exec "$sandbox" bash -lc 'tail -n 30 /var/log/vivarium/*.log' >&2 || true
  exit 1
}
sbx exec "$sandbox" docker info >/dev/null

echo "started $sandbox ($arm — private Docker, clone, and GUI ready)"
echo "  screen: http://127.0.0.1:$host_port/vnc.html"
