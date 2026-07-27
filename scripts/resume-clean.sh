#!/usr/bin/env bash
# Report or remove ephemeral arm environments left behind by an interrupted
# harness process.
#
# Usage:  scripts/resume-clean.sh [--apply]
#
#   (no flags)  list leftover containers and their checkout/PR state
#   --apply     close discoverable open PRs, then remove the containers,
#               nested-Docker volumes, and isolated networks
#
# A normal run removes these resources in runHarness's finally block. Use this
# only when no climb is currently running: --apply intentionally tears down
# every container labelled as a Vivarium ephemeral arm.
set -euo pipefail

apply=false
for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    -h | --help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown option '$argument' (try --help)" >&2
      exit 1
      ;;
  esac
done

log() { printf '[resume-clean] %s\n' "$*" >&2; }

containers="$(docker ps -a \
  --filter label=vivarium.ephemeral=true \
  --format '{{.Names}}' 2>/dev/null || true)"

if [[ -z "$containers" ]]; then
  log "no leftover ephemeral arm environments"
  exit 0
fi

count=0
while IFS= read -r container; do
  [[ -n "$container" ]] || continue
  count=$((count + 1))
  arm="$(docker inspect -f '{{index .Config.Labels "vivarium.arm"}}' "$container" 2>/dev/null || echo unknown)"
  run_id="$(docker inspect -f '{{index .Config.Labels "vivarium.run"}}' "$container" 2>/dev/null || echo unknown)"
  running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)"
  volume="$container-docker"
  network="$container-net"
  open_pr=""

  log "$arm: $container (run: $run_id; running: $running)"
  if [[ "$running" == true ]] && docker exec -i "$container" test -d /workspace/.git 2>/dev/null; then
    branch="$(docker exec -i -w /workspace "$container" git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    dirty="$(docker exec -i -w /workspace "$container" git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    log "  branch: $branch; changed paths: $dirty"
    if [[ "$branch" != main && "$branch" != master && "$branch" != unknown ]]; then
      open_pr="$(docker exec -i -w /workspace "$container" gh pr list \
        --head "$branch" --state open --limit 1 --json number,title \
        --jq '.[0] | select(.) | "#\(.number) \(.title)"' 2>/dev/null || true)"
      [[ -n "$open_pr" ]] && log "  open PR: $open_pr"
    fi
  else
    log "  checkout unavailable; PR state could not be inspected"
  fi

  if [[ "$apply" != true ]]; then
    log "  would remove container, volume, and network"
    continue
  fi

  if [[ -n "${open_pr:-}" ]]; then
    pr_number="${open_pr%% *}"
    pr_number="${pr_number#\#}"
    docker exec -i -w /workspace "$container" gh pr close "$pr_number" \
      --comment "Closed by resume-clean.sh: the ephemeral Vivarium run was interrupted and this subticket will restart from a fresh clone." \
      >/dev/null 2>&1 || log "  could not close $open_pr; close it manually"
  fi

  docker rm -f -v "$container" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  log "  removed"
done <<< "$containers"

if [[ "$apply" == true ]]; then
  log "removed $count leftover ephemeral arm environment(s)"
else
  log "found $count leftover environment(s); re-run with --apply to remove them"
fi
