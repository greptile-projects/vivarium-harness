#!/usr/bin/env bash
# Put both arm checkouts back on a clean, *symmetric* baseline before resuming an
# interrupted climb.
#
# Usage:  scripts/resume-clean.sh [--apply] [--reconcile-linear]
#
#   (no flags)          report what an interrupted run left behind; change nothing
#   --apply             actually discard it and reset both arms to origin/main
#   --reconcile-linear  also run the ladder/Linear reconcile pass (src/greg-tile/reconcile.ts)
#
# Reads KOMODO_REPO / TUATARA_REPO (and the matching *_GH_TOKEN) from .env, the
# same file the harness and arm-run.sh read. Override with ENV_FILE.
#
# ---------------------------------------------------------------------------
# Why this exists
#
# The ladder already resumes correctly on its own: a subticket's box is only
# checked after its run succeeded, so a machine that dies mid-run leaves the box
# `[ ]` and the next `bun start` retries it. What does NOT reset is the arms'
# checkouts — a killed run leaves whatever the workers had built sitting on a
# feature branch, possibly with an open PR.
#
# That matters more than it looks, because the harness runs both arms on the
# same subticket concurrently. If the machine died after Tuatara finished and
# pushed but before Komodo did, the box is still unchecked, so the retry replays
# BOTH arms — against a checkout where Tuatara's work is already present.
# Tuatara then "solves" a ticket that is already solved, in seconds, and wins.
# The manifest records two clean successes and the rung's A/B comparison is
# quietly worthless, which is worse than losing it loudly.
#
# So the reset is deliberately symmetric: both arms go back to the same
# baseline, or neither does.
#
# What is never touched: `main`. Each arm's main is the accumulated climb —
# every rung merged so far — and the only thing done to it here is a
# fast-forward to origin/main. Work that already merged is part of the
# experiment and is reported, not discarded.
set -euo pipefail

apply=false
reconcile=false
for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --reconcile-linear) reconcile=true ;;
    -h | --help)
      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown option '$argument' (try --help)" >&2
      exit 1
      ;;
  esac
done

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

log() { printf '[resume-clean] %s\n' "$*" >&2; }

# Anything the arms left behind that a resume would trip over. A plain string
# rather than an array: macOS still ships bash 3.2, where expanding an empty
# array under `set -u` is an error.
dirty_arms=""

# Report one arm, and with --apply reset it. Emits nothing destructive for work
# that already reached main.
inspect_arm() {
  local arm="$1"
  local prefix repo token branch merged_pr open_pr status_lines base

  prefix="$(printf '%s' "$arm" | tr '[:lower:]' '[:upper:]')"
  local repo_var="${prefix}_REPO" token_var="${prefix}_GH_TOKEN"
  repo="${!repo_var:-}"
  token="${!token_var:-}"

  if [[ -z "$repo" ]]; then
    log "$arm: $repo_var unset in $env_file — skipping"
    return 0
  fi
  if [[ ! -d "$repo/.git" ]]; then
    log "$arm: $repo is not a git checkout — skipping"
    return 0
  fi

  # A stale origin makes every question below ("is it merged?", "how far behind
  # is main?") answerable only with yesterday's answer.
  GH_TOKEN="$token" git -C "$repo" fetch --quiet origin || {
    log "$arm: could not fetch origin (offline?) — reporting against stale refs"
  }

  branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  status_lines="$(git -C "$repo" status --porcelain)"
  base="origin/main"
  git -C "$repo" rev-parse --verify --quiet "$base" >/dev/null || base="origin/master"

  log "$arm ($repo)"
  log "  branch: $branch"

  local uncommitted=0 unmerged=0
  if [[ -n "$status_lines" ]]; then
    uncommitted="$(printf '%s\n' "$status_lines" | wc -l | tr -d ' ')"
    log "  uncommitted: $uncommitted path(s)"
  fi

  # Commits on this branch that never reached main. This is the work a resume
  # would silently inherit.
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    unmerged="$(git -C "$repo" rev-list --count "${base}..HEAD" 2>/dev/null || echo 0)"
    log "  commits not on ${base}: $unmerged"

    # A PR that already merged is part of the climb — say so loudly, because the
    # right move there is the opposite of a reset.
    if command -v gh >/dev/null 2>&1; then
      merged_pr="$(cd "$repo" && GH_TOKEN="$token" gh pr list --head "$branch" \
        --state merged --limit 1 --json number,title \
        --jq '.[0] | select(.) | "#\(.number) \(.title)"' 2>/dev/null || true)"
      open_pr="$(cd "$repo" && GH_TOKEN="$token" gh pr list --head "$branch" \
        --state open --limit 1 --json number,title \
        --jq '.[0] | select(.) | "#\(.number) \(.title)"' 2>/dev/null || true)"
      [[ -n "$open_pr" ]] && log "  open PR: $open_pr"
      if [[ -n "$merged_pr" ]]; then
        log "  MERGED PR: $merged_pr"
        log "  -> this subticket's work already landed on main. Do NOT treat it as"
        log "     interrupted: check its box in LADDER.md by hand if the crash beat"
        log "     the checkbox, or the next run will build it a second time."
      fi
    else
      log "  (gh not on PATH — PR state unknown)"
    fi
  fi

  if [[ -z "$status_lines" && ( "$branch" == "main" || "$branch" == "master" ) ]]; then
    log "  clean — nothing an interrupted run left behind"
    return 0
  fi

  dirty_arms="${dirty_arms}${dirty_arms:+ }$arm"

  if [[ "$apply" != true ]]; then
    log "  would reset to $base (re-run with --apply to do it)"
    return 0
  fi

  # The reset itself. `checkout -f -B` (the same move syncToBaseline makes)
  # lands on the baseline even in a checkout that never had a local main, and
  # gets off the feature branch so it can be deleted; -D because by definition
  # its commits are unmerged, which is the whole point of discarding them.
  local main_branch="${base#origin/}"
  git -C "$repo" checkout --quiet --force -B "$main_branch" "$base"
  # Same clean as the harness's syncToBaseline (src/harness/github.ts), with the same
  # two excludes: LADDER.md is the arm's read-only view of the ladder (a
  # symlink on the host, a bind mount in the container) and is not the arm's
  # work to discard; node_modules is excluded explicitly rather than trusting
  # every arm repo to gitignore it. No -x: ignored files stay.
  git -C "$repo" clean --quiet -fd -e node_modules -e LADDER.md
  if [[ "$branch" != "$main_branch" ]]; then
    git -C "$repo" branch -D "$branch" >/dev/null 2>&1 || true
    if [[ -n "${open_pr:-}" ]] && command -v gh >/dev/null 2>&1; then
      if (cd "$repo" && GH_TOKEN="$token" gh pr close "${open_pr%% *}" \
        --comment "Closed by resume-clean.sh: the run building this subticket was interrupted; it will be rebuilt from a clean baseline." \
        >/dev/null 2>&1); then
        log "  closed $open_pr"
      else
        log "  could not close $open_pr — close it by hand"
      fi
    fi
  fi
  log "  reset to $base"
}

for arm in tuatara komodo; do
  inspect_arm "$arm"
done

if [[ -z "$dirty_arms" ]]; then
  log "both arms clean — safe to resume"
elif [[ "$apply" == true ]]; then
  log "reset: $dirty_arms — both arms now share a baseline, safe to resume"
else
  log "interrupted work found in: $dirty_arms"
  log "re-run with --apply to discard it and reset both arms to the same baseline"
fi

if [[ "$reconcile" == true ]]; then
  log "reconciling LADDER.md against Linear"
  (cd "$root" && bun src/greg-tile/reconcile.ts)
fi
