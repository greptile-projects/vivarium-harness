#!/usr/bin/env bash
# Report or remove arm/Planner sandboxes left by an interrupted harness.
#
# Usage:  scripts/resume-clean.sh [--apply]
#
#   (no flags)  list leftover sandboxes and their checkout/PR state
#   --apply     close discoverable open PRs, then remove the sandboxes
#
# A normal run removes these resources in finally blocks. Use --apply only
# when no climb is active: names matching the configured arm prefixes are the
# ownership boundary.
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

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
# shellcheck disable=SC1091
. "$root/.env"
set +a
: "${KOMODO_SANDBOX:?KOMODO_SANDBOX must be set in .env}"
: "${TUATARA_SANDBOX:?TUATARA_SANDBOX must be set in .env}"

log() { printf '[resume-clean] %s\n' "$*" >&2; }

sandboxes=""
while IFS= read -r candidate; do
  case "$candidate" in
    "$KOMODO_SANDBOX"-* | "$TUATARA_SANDBOX"-* | vivarium-greg-*)
      sandboxes+="${sandboxes:+$'\n'}$candidate"
      ;;
  esac
done < <(sbx ls -q 2>/dev/null || true)

if [[ -z "$sandboxes" ]]; then
  log "no leftover ephemeral environments"
  exit 0
fi

count=0
while IFS= read -r sandbox; do
  [[ -n "$sandbox" ]] || continue
  count=$((count + 1))
  open_pr=""
  case "$sandbox" in
    "$KOMODO_SANDBOX"-*) arm=komodo ;;
    "$TUATARA_SANDBOX"-*) arm=tuatara ;;
    vivarium-greg-*) arm=greg ;;
    *) continue ;;
  esac

  log "$arm: $sandbox"
  remote=(sbx exec -w /workspace \
    -e GH_TOKEN=proxy-managed -e GITHUB_TOKEN=proxy-managed "$sandbox")
  # Every nested sbx command must be detached from this loop's stdin. The
  # sandbox names themselves arrive there; a client that probes or forwards
  # stdin can otherwise consume the next name and make --apply clean one arm
  # per invocation.
  if [[ "$arm" != greg ]] && "${remote[@]}" test -d /workspace/.git </dev/null 2>/dev/null; then
    branch="$("${remote[@]}" git rev-parse --abbrev-ref HEAD </dev/null 2>/dev/null || echo unknown)"
    dirty="$("${remote[@]}" git status --porcelain </dev/null 2>/dev/null | wc -l | tr -d ' ')"
    log "  branch: $branch; changed paths: $dirty"
    if [[ "$branch" != main && "$branch" != master && "$branch" != unknown ]]; then
      open_pr="$("${remote[@]}" gh pr list \
        --head "$branch" --state open --limit 1 --json number,title \
        --jq '.[0] | select(.) | "#\(.number) \(.title)"' </dev/null 2>/dev/null || true)"
      [[ -n "$open_pr" ]] && log "  open PR: $open_pr"
    fi
  elif [[ "$arm" != greg ]]; then
    log "  checkout unavailable; PR state could not be inspected"
  fi

  if [[ "$apply" != true ]]; then
    log "  would remove sandbox"
    continue
  fi

  if [[ -n "$open_pr" ]]; then
    pr_number="${open_pr%% *}"
    pr_number="${pr_number#\#}"
    "${remote[@]}" gh pr close "$pr_number" \
      --comment "Closed by resume-clean.sh: the ephemeral Vivarium run was interrupted and this subticket will restart from a fresh clone." \
      </dev/null >/dev/null 2>&1 || log "  could not close $open_pr; close it manually"
  fi

  sbx secret rm "$sandbox" github --force </dev/null >/dev/null 2>&1 || true
  sbx rm --force "$sandbox" </dev/null >/dev/null 2>&1 || true
  scratch="/tmp/$sandbox-host"
  rm -rf "$scratch"
  log "  removed"
done <<< "$sandboxes"

if [[ "$apply" == true ]]; then
  log "removed $count leftover ephemeral environment(s)"
else
  log "found $count leftover environment(s); re-run with --apply to remove them"
fi
