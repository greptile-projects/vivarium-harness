#!/usr/bin/env bash
# Complete every per-arm operation that must happen after a fresh sandbox is
# created. Keeping this inside the template turns provisioning into one remote
# call instead of making the host repeatedly cross the sbx control plane.
set -euo pipefail

repo="${1:?GitHub repository URL is required}"
ladder="${2:?mounted LADDER.md path is required}"

[[ "$repo" =~ ^https://github\.com/[^/]+/[^/]+(\.git)?$ ]] || {
  echo "vivarium-init: repository must be a plain HTTPS GitHub clone URL" >&2
  exit 1
}
[[ -f "$ladder" ]] || {
  echo "vivarium-init: ladder is not mounted at $ladder" >&2
  exit 1
}

sudo install -d -o agent -g agent /workspace
git clone --origin origin "$repo" /workspace
ln -s "$ladder" /workspace/LADDER.md

identity="$(gh api user --jq '[.login, .id] | @tsv')"
login="${identity%%$'\t'*}"
user_id="${identity##*$'\t'}"
[[ -n "$login" && -n "$user_id" && "$identity" == *$'\t'* ]] || {
  echo "vivarium-init: GitHub returned an invalid identity" >&2
  exit 1
}
git -C /workspace config user.name "$login"
git -C /workspace config user.email \
  "${user_id}+${login}@users.noreply.github.com"

for _ in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
docker info >/dev/null || {
  echo "vivarium-init: private Docker daemon did not become ready" >&2
  exit 1
}

# Keep this detached remote session alive after initialization. Docker
# Sandboxes otherwise stops the VM shortly after its last session exits.
exec vivarium-gui
