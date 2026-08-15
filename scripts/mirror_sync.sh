#!/usr/bin/env bash
#
# mirror_sync.sh — replay Komodo's successive main-states into the private review
# mirror, one PR at a time, in order, letting Greptile review each before merge.
#
# State-based (NOT patch/cherry-pick): each main-state SHA is materialized as an
# exact tree copy on a branch off mirror/main, opened as its own PR, reviewed,
# and merged. Strictly sequential — one open mirror PR at a time.
#
# All waiting happens here (harness side); Komodo never blocks on the mirror.
#
# Credentials (see docs/mirror-sync.md):
#   MIRROR_PUSH_TOKEN  an installation token for the `vivarium-mirror` GitHub App,
#                      minted per run by the workflow — NOT a PAT. It is what makes
#                      every mirror push/PR/merge `vivarium-mirror[bot]` rather than
#                      a human. Needs Contents:write, Pull requests:write and
#                      Workflows:write (Komodo's tree carries .github/workflows/*,
#                      and tree identity forces them into every state we push).
#   HARNESS_ORG_TOKEN  fine-grained PAT, resource owner = org: read vivarium-komodo
#                      (Contents/Metadata/Pull requests: read) + read/write the
#                      harness repo variable (Variables: read/write).
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config (overridable via env; defaults suit the real deployment)
# ---------------------------------------------------------------------------
SOURCE_REPO="${SOURCE_REPO:-greptile-projects/vivarium-komodo}"
MIRROR_REPO="${MIRROR_REPO:-makors/vivarium-komodo-mirror}"
HARNESS_REPO="${HARNESS_REPO:-greptile-projects/vivarium-harness}"
STATE_VAR="${STATE_VAR:-LAST_SYNCED_SHA}"

# Greptile app login. This is the same fixed reviewer identity as the harness,
# not a deployment variable.
GREPTILE_BOT_LOGIN="greptile-apps[bot]"

# Marker every mirror PR title carries. Greptile reads it to recognize the PR
# as agent-authored, so it is not decoration — keep the trailing space.
CODEX_TITLE_PREFIX="${CODEX_TITLE_PREFIX:-[codex] }"

API_RETRY_SLEEP="${API_RETRY_SLEEP:-2}"  # backoff between source-PR read attempts
POLL_INTERVAL="${POLL_INTERVAL:-60}"     # seconds between review checks
POLL_TIMEOUT="${POLL_TIMEOUT:-1500}"     # 25 min; matches REVIEW_TIMEOUT_MS so both arms wait equally
TIMEOUT_LABEL="${TIMEOUT_LABEL:-review-timeout}"

# Committer identity for mirror commits. In CI the workflow overrides these with
# the `vivarium-mirror[bot]` app identity; this fallback only applies to manual
# local runs. The Komodo agent stays the *author* (--author passthrough).
BOT_COMMITTER_NAME="${BOT_COMMITTER_NAME:-github-actions[bot]}"
BOT_COMMITTER_EMAIL="${BOT_COMMITTER_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

# Remote URLs — overridable so tests can point at local bare repos.
#
# The tokens ride in the URLs (and land in the workdir's .git/config), unlike
# the harness's one-shot credential helpers. Acceptable only because this runs
# on an ephemeral CI runner with a mktemp workdir — do not copy this pattern to
# anything that runs on a persistent machine.
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
# that would break tree identity with vivarium-komodo).
# ---------------------------------------------------------------------------
read_state() {
  local v
  v="$(gh_org api "repos/${HARNESS_REPO}/actions/variables/${STATE_VAR}" -q '.value' 2>/dev/null || true)"
  if [[ -z "$v" ]]; then
    # Bootstrap: unset => start from Komodo's root commit.
    v="$(git -C "$WORKDIR" rev-list --max-parents=0 komodo/main | tail -1)"
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
  git -C "$WORKDIR" remote add komodo "$SOURCE_GIT_URL" 2>/dev/null || \
    git -C "$WORKDIR" remote set-url komodo "$SOURCE_GIT_URL"
  git -C "$WORKDIR" remote add mirror "$MIRROR_GIT_URL" 2>/dev/null || \
    git -C "$WORKDIR" remote set-url mirror "$MIRROR_GIT_URL"
  # --force is mandatory: rewritten history must never wedge tracking refs.
  git -C "$WORKDIR" fetch --force --prune komodo '+refs/heads/*:refs/remotes/komodo/*'
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
  # Verify BEFORE advancing state: if the merged tree diverged from the source,
  # dying here leaves the state variable on the last good sha, so a rerun hits
  # this state again and the failure stays visible instead of being recorded as
  # synced (the rerun's empty-diff skip path never re-verifies).
  verify_tree_identity "$sha"
  write_state "$sha"
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

# Read one field off the source pull request, retrying, and treat exhaustion as
# fatal rather than as an empty value.
#
# `|| true` here would be indistinguishable from a pull request that genuinely
# has no description — and a 503 would then open a mirror PR with no ticket and
# no context, which Greptile reviews and the pipeline merges before anyone
# notices. That is unrecoverable: the mirror PR is written once, and the review
# it exists to produce has already happened against a diff with no explanation.
#
# Dying is cheap by comparison. Nothing has advanced — `write_state` runs only
# after a merge — so the next dispatch or the daily cron resumes at exactly this
# state and retries it. A failed run is visible in Actions; a context-free
# mirror PR looks like a success.
source_pr_field() { # <pr-number> <jq-expr> <human name> -> field value
  local pr="$1" expr="$2" what="$3" attempt out
  for attempt in 1 2 3; do
    if out="$(gh_org api "repos/${SOURCE_REPO}/pulls/${pr}" -q "$expr" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
    log "could not read ${what} of ${SOURCE_REPO}#${pr} (attempt ${attempt}/3)"
    sleep "$API_RETRY_SLEEP"
  done
  die "could not read ${what} of ${SOURCE_REPO}#${pr} after 3 attempts; \
refusing to open a mirror PR without it (state unchanged, rerun to retry)"
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
  local src_pr title body author_login src_line src_body ticket
  src_pr="$(source_pr_number "$sha")"
  src_line="$(g log -1 --format='%s' "$sha")"
  if [[ -n "$src_pr" ]]; then
    title="$(source_pr_field "$src_pr" '.title' 'title')"
    [[ -n "$title" ]] || title="$src_line"
    # `// ""` because GitHub sends a null body for a pull request opened with no
    # description, and jq would print the string "null".
    src_body="$(source_pr_field "$src_pr" '.body // ""' 'description')"
  else
    title="$src_line"
    src_body=""
  fi

  # Carry the source PR's whole description across, verbatim. Greptile reviews
  # the mirror, not Komodo, so without this it is the only reviewer in the
  # experiment judging a diff with no idea what was asked for — while Tuatara's
  # reviewer sees the full description on the real PR. Whole body, not just the
  # "## Original Ticket" section: symmetry is the point, and Tuatara's reviewer
  # is not handed an extract either. It also sidesteps a trap — ticket bodies
  # carry their own "## Objective"/"## Deliverable" headings, so any parser that
  # ends the section at the next "## " silently captures nothing.
  ticket="$src_body"
  # Every mirror PR is titled "[codex] …": Greptile keys off that marker to
  # treat the PR as agent-authored. Non-negotiable, so it goes on last and
  # outermost — after any per-path prefix like [force-push].
  #
  # The source title usually carries the marker already: the worker prompt tells
  # both arms to title their pull requests "[codex] …", so that Tuatara's real
  # reviews and Komodo's mirror reviews are collected under the same marker.
  # Strip it before adding a per-path prefix, or the prefix would sit between
  # the marker and the title and the check below would add a second one
  # ("[codex] [force-push] [codex] …").
  title="${title#"$CODEX_TITLE_PREFIX"}"
  [[ -n "$prefix" ]] && title="${prefix}${title}"
  title="${CODEX_TITLE_PREFIX}${title}"

  author_login="$(source_author_login "$sha")"
  local author_ref
  if [[ -n "$author_login" ]]; then
    author_ref="https://github.com/${author_login}"   # plain link, NO @-mention
  else
    author_ref="$author"
  fi
  local src_pr_line="(no associated source PR)"
  [[ -n "$src_pr" ]] && src_pr_line="#${src_pr} — https://github.com/${SOURCE_REPO}/pull/${src_pr}"

  # The description goes first, ahead of the provenance lines: it is the context
  # a reviewer needs before the diff, and the mirror PR is what gets reviewed.
  body="$(cat <<EOF
${ticket:+${ticket}

---

}Source PR: ${src_pr_line}
Source SHA: ${sha}
Original author: ${author_ref}

Synced state; see repo README for mechanism.
EOF
)"

  # Commit: Komodo agent is the AUTHOR; the bot is only the committer.
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
  head="$(g rev-parse komodo/main)"

  if [[ "$last" == "$head" ]]; then
    log "already up to date at ${head}; nothing to sync"
    return
  fi

  # Ensure the last-synced object is present locally (may be dangling after a
  # force-push); best-effort fetch by SHA.
  g fetch --force komodo "$last" 2>/dev/null || true

  if g merge-base --is-ancestor "$last" komodo/main 2>/dev/null; then
    # Normal path: one PR per successive main-state, first-parent, oldest first.
    local shas=() s
    while IFS= read -r s; do [[ -n "$s" ]] && shas+=("$s"); done \
      < <(g rev-list "${last}..komodo/main" --first-parent --reverse)
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
