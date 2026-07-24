#!/usr/bin/env bash
#
# mirror_sync.sh — replay arm B's successive main-states into the private review
# mirror, one PR at a time, in order, letting Greptile review each before merge.
#
# State-based (NOT patch/cherry-pick): each main-state SHA is materialized as an
# exact tree copy on a branch off mirror/main, opened as its own PR, reviewed,
# and merged. Strictly sequential — one open mirror PR at a time.
#
# All waiting happens here (harness side); arm B never blocks on the mirror.
#
# Credentials (two fine-grained PATs — see SETUP.md):
#   MIRROR_PUSH_TOKEN  resource owner = MIRROR_OWNER (personal acct), mirror repo
#                      only: Contents:write, Pull requests:write.
#   HARNESS_ORG_TOKEN  resource owner = org: read vivarium-b (Contents/Metadata/
#                      Pull requests: read) + read/write the harness repo variable
#                      (Variables: read/write).
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config (overridable via env; defaults suit the real deployment)
# ---------------------------------------------------------------------------
SOURCE_REPO="${SOURCE_REPO:-greptile-projects/vivarium-b}"
MIRROR_REPO="${MIRROR_REPO:-makors/vivarium-b-mirror}"
HARNESS_REPO="${HARNESS_REPO:-greptile-projects/vivarium-harness}"
STATE_VAR="${STATE_VAR:-LAST_SYNCED_SHA}"

# Greptile app login — CONFIRM against a real arm A PR (see SETUP.md); the app's
# bot login is what authors its reviews/comments.
GREPTILE_BOT_LOGIN="${GREPTILE_BOT_LOGIN:-greptile-apps[bot]}"

POLL_INTERVAL="${POLL_INTERVAL:-60}"     # seconds between review checks
POLL_TIMEOUT="${POLL_TIMEOUT:-600}"      # 10 min; runner stays alive => bounds Actions minutes
TIMEOUT_LABEL="${TIMEOUT_LABEL:-review-timeout}"

BOT_COMMITTER_NAME="${BOT_COMMITTER_NAME:-vivarium-mirror-bot}"
BOT_COMMITTER_EMAIL="${BOT_COMMITTER_EMAIL:-mirror-bot@users.noreply.github.com}"

# Remote URLs — overridable so tests can point at local bare repos.
SOURCE_GIT_URL="${SOURCE_GIT_URL:-https://x-access-token:${HARNESS_ORG_TOKEN:-}@github.com/${SOURCE_REPO}.git}"
MIRROR_GIT_URL="${MIRROR_GIT_URL:-https://x-access-token:${MIRROR_PUSH_TOKEN:-}@github.com/${MIRROR_REPO}.git}"

WORKDIR="${WORKDIR:-$(mktemp -d)}"

log() { printf '[mirror-sync] %s\n' "$*" >&2; }
die() { printf '[mirror-sync] FATAL: %s\n' "$*" >&2; exit 1; }

# gh wrappers: mirror ops use the mirror PAT; source/harness ops use the org PAT.
gh_mirror() { GH_TOKEN="${MIRROR_PUSH_TOKEN:-}" gh "$@"; }
gh_org()    { GH_TOKEN="${HARNESS_ORG_TOKEN:-}" gh "$@"; }

# ---------------------------------------------------------------------------
# State: last-synced SHA lives in a harness repo variable (NOT in the mirror —
# that would break tree identity with vivarium-b).
# ---------------------------------------------------------------------------
read_state() {
  local v
  v="$(gh_org api "repos/${HARNESS_REPO}/actions/variables/${STATE_VAR}" -q '.value' 2>/dev/null || true)"
  if [[ -z "$v" ]]; then
    # Bootstrap: unset => start from arm B's root commit.
    v="$(git -C "$WORKDIR" rev-list --max-parents=0 arm-b/main | tail -1)"
    log "state unset; bootstrapping from root commit $v"
  fi
  printf '%s' "$v"
}

write_state() {
  local sha="$1"
  # PATCH updates an existing variable; POST creates it if missing.
  if ! gh_org api -X PATCH "repos/${HARNESS_REPO}/actions/variables/${STATE_VAR}" \
        -f "name=${STATE_VAR}" -f "value=${sha}" >/dev/null 2>&1; then
    gh_org api -X POST "repos/${HARNESS_REPO}/actions/variables" \
        -f "name=${STATE_VAR}" -f "value=${sha}" >/dev/null
  fi
  log "advanced ${STATE_VAR} -> ${sha}"
}

# ---------------------------------------------------------------------------
# Git setup
# ---------------------------------------------------------------------------
setup_repo() {
  git init -q "$WORKDIR"
  git -C "$WORKDIR" config user.name "$BOT_COMMITTER_NAME"
  git -C "$WORKDIR" config user.email "$BOT_COMMITTER_EMAIL"
  git -C "$WORKDIR" remote add arm-b "$SOURCE_GIT_URL" 2>/dev/null || \
    git -C "$WORKDIR" remote set-url arm-b "$SOURCE_GIT_URL"
  git -C "$WORKDIR" remote add mirror "$MIRROR_GIT_URL" 2>/dev/null || \
    git -C "$WORKDIR" remote set-url mirror "$MIRROR_GIT_URL"
  # --force is mandatory: rewritten history must never wedge tracking refs.
  git -C "$WORKDIR" fetch --force --prune arm-b '+refs/heads/*:refs/remotes/arm-b/*'
  git -C "$WORKDIR" fetch --force --prune mirror '+refs/heads/*:refs/remotes/mirror/*'
}

g() { git -C "$WORKDIR" "$@"; }

# ---------------------------------------------------------------------------
# PR metadata resolution (best-effort; falls back to commit message)
# ---------------------------------------------------------------------------
source_pr_number() { # <sha> -> PR number that introduced it, or empty
  gh_org api "repos/${SOURCE_REPO}/commits/$1/pulls" \
    -H "Accept: application/vnd.github+json" -q '.[0].number' 2>/dev/null || true
}
source_author_login() { # <sha> -> github login, or empty
  gh_org api "repos/${SOURCE_REPO}/commits/$1" -q '.author.login' 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Greptile review detection
# ---------------------------------------------------------------------------
has_greptile_review() { # <pr-number>
  local n="$1" a b
  a="$(gh_mirror api "repos/${MIRROR_REPO}/pulls/${n}/reviews" \
        -q "[.[]|select(.user.login==\"${GREPTILE_BOT_LOGIN}\")]|length" 2>/dev/null || echo 0)"
  b="$(gh_mirror api "repos/${MIRROR_REPO}/issues/${n}/comments" \
        -q "[.[]|select(.user.login==\"${GREPTILE_BOT_LOGIN}\")]|length" 2>/dev/null || echo 0)"
  [[ "${a:-0}" -gt 0 || "${b:-0}" -gt 0 ]]
}

ensure_timeout_label() {
  gh_mirror label create "$TIMEOUT_LABEL" -R "$MIRROR_REPO" \
    --description "Greptile review did not arrive before timeout" --color BFD4F2 \
    >/dev/null 2>&1 || true
}

wait_then_merge() { # <pr-number> <source-sha>
  local n="$1" sha="$2" waited=0
  log "PR #${n}: waiting for Greptile review (login=${GREPTILE_BOT_LOGIN}, timeout=${POLL_TIMEOUT}s)"
  while true; do
    if has_greptile_review "$n"; then
      log "PR #${n}: Greptile review present"
      break
    fi
    if (( waited >= POLL_TIMEOUT )); then
      log "PR #${n}: review timed out after ${waited}s; labeling '${TIMEOUT_LABEL}' and proceeding"
      ensure_timeout_label
      gh_mirror pr edit "$n" -R "$MIRROR_REPO" --add-label "$TIMEOUT_LABEL" >/dev/null 2>&1 || true
      break
    fi
    sleep "$POLL_INTERVAL"
    waited=$(( waited + POLL_INTERVAL ))
  done
  # --merge (never squash): the authored commit must land as-is.
  gh_mirror pr merge "$n" -R "$MIRROR_REPO" --merge >/dev/null
  log "PR #${n}: merged"
  write_state "$sha"
  verify_tree_identity "$sha"
}

# ---------------------------------------------------------------------------
# Tree-identity verification (constraint 4) — fail loudly if the merged mirror
# main tree diverges from the source state.
# ---------------------------------------------------------------------------
verify_tree_identity() { # <source-sha>
  local sha="$1"
  g fetch --force mirror '+refs/heads/main:refs/remotes/mirror/main'
  if ! g diff --quiet "$sha" "refs/remotes/mirror/main" -- ; then
    g --no-pager diff --stat "$sha" "refs/remotes/mirror/main" -- >&2 || true
    die "tree identity BROKEN: mirror/main != source ${sha}"
  fi
  log "verified: mirror/main tree byte-identical to source ${sha}"
}

# ---------------------------------------------------------------------------
# Sync one source SHA into its own mirror PR (idempotent / resumable).
# ---------------------------------------------------------------------------
sync_one() { # <source-sha> <title-prefix>
  local sha="$1" prefix="${2:-}"
  local short branch existing
  short="$(g rev-parse --short=7 "$sha")"
  branch="sync/${short}"

  # Resume: if an open PR already exists for this branch, wait+merge it.
  existing="$(gh_mirror pr list -R "$MIRROR_REPO" --state open --head "$branch" \
                --json number -q '.[0].number' 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    log "resuming existing open PR #${existing} for ${branch}"
    wait_then_merge "$existing" "$sha"
    return
  fi

  # Build the exact tree on a fresh branch off mirror/main.
  g checkout -q -B "$branch" refs/remotes/mirror/main
  g rm -rq . >/dev/null 2>&1 || true          # required: checkout overlays, does not delete
  g checkout "$sha" -- .
  g add -A

  # Empty tree diff vs mirror/main => history-only rewrite (or already-merged
  # state on a resumed run): skip PR, advance state, continue.
  if g diff --cached --quiet refs/remotes/mirror/main -- ; then
    log "${short}: tree identical to mirror/main (history-only or already merged); skipping PR"
    write_state "$sha"
    return
  fi

  local author msg
  author="$(g log -1 --format='%an <%ae>' "$sha")"
  # Title: source PR title if resolvable, else first line of the commit message.
  local src_pr title body author_login src_line
  src_pr="$(source_pr_number "$sha")"
  src_line="$(g log -1 --format='%s' "$sha")"
  if [[ -n "$src_pr" ]]; then
    title="$(gh_org api "repos/${SOURCE_REPO}/pulls/${src_pr}" -q '.title' 2>/dev/null || echo "$src_line")"
  else
    title="$src_line"
  fi
  [[ -n "$prefix" ]] && title="${prefix}${title}"

  author_login="$(source_author_login "$sha")"
  local author_ref
  if [[ -n "$author_login" ]]; then
    author_ref="https://github.com/${author_login}"   # plain link, NO @-mention
  else
    author_ref="$author"
  fi
  local src_pr_line="(no associated source PR)"
  [[ -n "$src_pr" ]] && src_pr_line="#${src_pr} — https://github.com/${SOURCE_REPO}/pull/${src_pr}"

  body="$(cat <<EOF
Source PR: ${src_pr_line}
Source SHA: ${sha}
Original author: ${author_ref}

Synced state; see repo README for mechanism.
EOF
)"

  # Commit: arm B agent is the AUTHOR; the bot is only the committer.
  msg="$(printf '%s\n\nMirrored-from: %s\n' "$title" "$sha")"
  GIT_COMMITTER_NAME="$BOT_COMMITTER_NAME" GIT_COMMITTER_EMAIL="$BOT_COMMITTER_EMAIL" \
    g commit -q --author="$author" -m "$msg"

  # Push (force: a stale branch from a prior crashed run must not wedge us).
  g push -q --force mirror "HEAD:refs/heads/${branch}"

  local url num
  url="$(gh_mirror pr create -R "$MIRROR_REPO" --base main --head "$branch" \
          --title "$title" --body "$body")"
  num="$(printf '%s' "$url" | grep -oE '[0-9]+$' || true)"
  log "opened mirror PR #${num}: ${url}"
  wait_then_merge "$num" "$sha"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  : "${MIRROR_PUSH_TOKEN:?MIRROR_PUSH_TOKEN required (unless MIRROR_GIT_URL overridden)}"
  : "${HARNESS_ORG_TOKEN:?HARNESS_ORG_TOKEN required (unless overridden)}"
  setup_repo

  local last head
  last="$(read_state)"
  head="$(g rev-parse arm-b/main)"

  if [[ "$last" == "$head" ]]; then
    log "already up to date at ${head}; nothing to sync"
    return
  fi

  # Ensure the last-synced object is present locally (may be dangling after a
  # force-push); best-effort fetch by SHA.
  g fetch --force arm-b "$last" 2>/dev/null || true

  if g merge-base --is-ancestor "$last" arm-b/main 2>/dev/null; then
    # Normal path: one PR per successive main-state, first-parent, oldest first.
    local shas=() s
    while IFS= read -r s; do [[ -n "$s" ]] && shas+=("$s"); done \
      < <(g rev-list "${last}..arm-b/main" --first-parent --reverse)
    log "syncing ${#shas[@]} state(s): ${last}..${head}"
    for s in "${shas[@]}"; do
      sync_one "$s" ""
    done
  else
    # Force-push: last-synced is no longer an ancestor. One coarse PR straight to
    # current main, tagged [force-push]; normal operation resumes afterward.
    log "force-push detected: ${last} is not an ancestor of ${head}; coarse sync to ${head}"
    sync_one "$head" "[force-push] "
  fi

  log "sync complete; mirror at ${head}"
}

# Only run main when executed directly (allows sourcing for tests).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
