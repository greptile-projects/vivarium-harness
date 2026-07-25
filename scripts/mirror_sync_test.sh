#!/usr/bin/env bash
#
# Offline tests for mirror_sync.sh.
#
# These exercise the pipeline's *local git logic* end-to-end — state
# enumeration, exact-tree materialization (rm + checkout), empty-diff skip,
# force-push ancestry fallback, tree-identity verification, state advance, and
# idempotent resume — against real local bare repos standing in for vivarium-komodo
# and the mirror. `gh` is replaced by a stub (see stub_gh below) that simulates
# Greptile-approve + merge, PR listing, and the state variable.
#
# What these do NOT cover (needs live GitHub + Greptile — see SETUP.md):
#   - a real Greptile review actually appearing
#   - cross-installation config parity with Tuatara
#   - real repository_dispatch delivery
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/mirror_sync.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1 (want '$3', got '$2')"; fi; }

# --- gh stub -------------------------------------------------------------
# Dispatches on argv; reads STUB_DIR (state, counters, mapping) + MIRROR_BARE.
write_stub() {
  cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
D="$STUB_DIR"; MB="$MIRROR_BARE"
endpoint=""; is_write=0; val=""; jq_expr=""
prev=""
for a in "$@"; do
  case "$a" in
    repos/*) endpoint="$a" ;;
    PATCH|POST) is_write=1 ;;
    value=*) val="${a#value=}" ;;
  esac
  # The source-PR endpoint is asked for .title and .body separately, so the
  # stub has to answer per field rather than per endpoint.
  [[ "$prev" == "-q" ]] && jq_expr="$a"
  prev="$a"
done
case "$1" in
  api)
    case "$endpoint" in
      *"/actions/variables"*)
        if [[ "$is_write" == 1 ]]; then printf '%s' "$val" > "$D/state"; else cat "$D/state" 2>/dev/null; fi ;;
      *"/reviews") printf '%s' "${STUB_REVIEW:-1}" ;;      # Greptile review present
      *"/comments") printf '0' ;;
      *"/commits/"*"/pulls") printf '%s' "${STUB_SRC_PR:-}" ;;   # source PR, if the scenario sets one
      *"/commits/"*) : ;;                                  # no author login
      *"/pulls/"*)
        case "$jq_expr" in
          .title) printf '%s' "${STUB_SRC_TITLE:-}" ;;
          .body) printf '%s' "${STUB_SRC_BODY:-}" ;;
        esac ;;
      *) : ;;
    esac ;;
  pr)
    case "$2" in
      list)
        if [[ -f "$D/open_pr" ]]; then cat "$D/open_pr"; fi ;;
      create)
        head=""; title=""; body=""
        while [[ $# -gt 0 ]]; do case "$1" in --head) head="$2"; shift;; --title) title="$2"; shift;; --body) body="$2"; shift;; esac; shift; done
        n=$(( $(cat "$D/counter" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/counter"
        echo "$n $head" >> "$D/prmap"; echo "$title" >> "$D/titles"
        printf '%s' "$body" > "$D/last_body"
        echo "https://github.com/mirror/pull/$n" ;;
      merge)
        n="$3"; br="$(awk -v n="$n" '$1==n{print $2}' "$D/prmap" | tail -1)"
        git -C "$MB" update-ref refs/heads/main "$(git -C "$MB" rev-parse "refs/heads/$br")" ;;
      edit)
        for a in "$@"; do [[ "$a" == "review-timeout" ]] && touch "$D/timeout_marker"; done ;;
    esac ;;
  label) : ;;
esac
STUB
  chmod +x "$STUB_DIR/gh"
}

# --- scenario scaffolding ------------------------------------------------
# Build a fresh source bare + mirror bare seeded with an initial commit, and a
# work clone to add commits to source.
new_scenario() {
  SC="$ROOT/$1"; mkdir -p "$SC"
  SRC_BARE="$SC/src.git"; MIRROR_BARE="$SC/mirror.git"
  STUB_DIR="$SC/stub"; mkdir -p "$STUB_DIR"
  git init -q --bare "$SRC_BARE"; git init -q --bare "$MIRROR_BARE"
  WORK="$SC/work"; git clone -q "$SRC_BARE" "$WORK"
  git -C "$WORK" config user.name komodo-agent
  git -C "$WORK" config user.email agent@armb.example
  printf 'v1\n' > "$WORK/file.txt"; git -C "$WORK" add -A
  git -C "$WORK" commit -q -m "initial commit"
  git -C "$WORK" push -q origin HEAD:main
  ROOT_SHA="$(git -C "$WORK" rev-parse HEAD)"
  # Seed mirror main from the same tree (bootstrap equivalent).
  git -C "$WORK" push -q "$MIRROR_BARE" HEAD:main
  printf '%s' "$ROOT_SHA" > "$STUB_DIR/state"
  write_stub
}

# Run the pipeline against the current scenario.
run_sync() {
  PATH="$STUB_DIR:$PATH" \
  STUB_DIR="$STUB_DIR" MIRROR_BARE="$MIRROR_BARE" STUB_REVIEW="${STUB_REVIEW:-1}" \
  STUB_SRC_PR="${STUB_SRC_PR:-}" STUB_SRC_TITLE="${STUB_SRC_TITLE:-}" \
  STUB_SRC_BODY="${STUB_SRC_BODY:-}" \
  MIRROR_PUSH_TOKEN=dummy HARNESS_ORG_TOKEN=dummy \
  SOURCE_GIT_URL="file://$SRC_BARE" MIRROR_GIT_URL="file://$MIRROR_BARE" \
  WORKDIR="$(mktemp -d "$SC/wd.XXXX")" \
  POLL_INTERVAL="${POLL_INTERVAL:-0}" POLL_TIMEOUT="${POLL_TIMEOUT:-600}" \
  bash "$SCRIPT" >"$SC/out.log" 2>&1
}

src_commit() { # <content> <msg>
  printf '%s\n' "$1" > "$WORK/file.txt"; git -C "$WORK" add -A
  git -C "$WORK" commit -q -m "$2"; git -C "$WORK" push -q origin HEAD:main
}
n_prs()      { cat "$STUB_DIR/counter" 2>/dev/null || echo 0; }
state()      { cat "$STUB_DIR/state"; }
mirror_main(){ git -C "$MIRROR_BARE" rev-parse refs/heads/main; }
# tree of mirror main vs a source sha
tree_identical() {
  local sha="$1" t
  t="$(mktemp -d)"; git clone -q "$MIRROR_BARE" "$t" >/dev/null 2>&1
  git -C "$t" fetch -q "file://$SRC_BARE" "$sha" 2>/dev/null || true
  if git -C "$t" diff --quiet "$sha" refs/heads/main -- ; then echo yes; else echo no; fi
}

# =========================================================================
echo "== Scenario 1: single merge -> single mirror PR, merged, tree-identical =="
new_scenario s1
src_commit v2 "add feature X"
HEAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
run_sync
check "PRs created" "$(n_prs)" "1"
check "state advanced to head" "$(state)" "$HEAD_SHA"
check "mirror tree identical to head" "$(tree_identical "$HEAD_SHA")" "yes"

echo "== Scenario 2: burst of 3 commits in one run -> 3 sequential PRs, in order =="
new_scenario s2
src_commit v2 "commit two"
src_commit v3 "commit three"
src_commit v4 "commit four"
HEAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
run_sync
check "3 PRs created" "$(n_prs)" "3"
check "state at head" "$(state)" "$HEAD_SHA"
check "titles in order" "$(paste -sd, "$STUB_DIR/titles")" \
  "[codex] commit two,[codex] commit three,[codex] commit four"
check "tree identical" "$(tree_identical "$HEAD_SHA")" "yes"

echo "== Scenario 3: history rewrite, identical tree -> no PR, state advances =="
new_scenario s3
# amend the commit message but keep the SAME tree (v1), producing a new SHA.
git -C "$WORK" commit -q --amend -m "reworded, same tree"
git -C "$WORK" push -q -f origin HEAD:main
HEAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
# last-synced (ROOT_SHA) is no longer an ancestor -> force-push path, but tree is
# identical to mirror main, so it must skip PR creation and just advance state.
run_sync
check "no PR created" "$(n_prs)" "0"
check "state advanced to rewritten head" "$(state)" "$HEAD_SHA"

echo "== Scenario 4: force-push to a DIFFERENT tree -> one [force-push] PR =="
new_scenario s4
# diverge: reset source main to a brand-new root with different content.
git -C "$WORK" checkout -q --orphan fp
git -C "$WORK" rm -q -rf . >/dev/null 2>&1 || true
printf 'totally different\n' > "$WORK/other.txt"; git -C "$WORK" add -A
git -C "$WORK" commit -q -m "force-push rewrite"
git -C "$WORK" push -q -f origin HEAD:main
HEAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
run_sync
check "one PR created" "$(n_prs)" "1"
check "title has [codex] then [force-push] prefix" \
  "$(grep -c '^\[codex\] \[force-push\] ' "$STUB_DIR/titles")" "1"
check "state at head" "$(state)" "$HEAD_SHA"
check "tree identical" "$(tree_identical "$HEAD_SHA")" "yes"

echo "== Scenario 5: crash mid-cycle -> next run resumes without duplicate PR =="
new_scenario s5
src_commit v2 "resumable commit"
HEAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
run_sync                              # first run completes it
first_prs="$(n_prs)"
run_sync                              # second run: nothing new to do
check "first run made 1 PR" "$first_prs" "1"
check "second run made NO new PR" "$(n_prs)" "1"
check "state stable at head" "$(state)" "$HEAD_SHA"
# Also exercise the 'already-merged advances without dup' resume branch directly:
# rewind state to root, drop the recorded merge — rerun must skip (empty diff) not re-PR.
printf '%s' "$ROOT_SHA" > "$STUB_DIR/state"; printf '0' > "$STUB_DIR/counter"
run_sync
check "resume after merge: no dup PR" "$(n_prs)" "0"
check "resume re-advances state" "$(state)" "$HEAD_SHA"

echo "== Scenario 6: review never arrives -> review-timeout label, queue proceeds =="
new_scenario s6
src_commit v2 "unreviewed commit"
HEAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
STUB_REVIEW=0 POLL_TIMEOUT=0 run_sync   # no greptile review; immediate timeout
check "PR still created" "$(n_prs)" "1"
check "review-timeout label applied" "$([[ -f "$STUB_DIR/timeout_marker" ]] && echo yes || echo no)" "yes"
check "merged + state advanced despite timeout" "$(state)" "$HEAD_SHA"
check "tree identical" "$(tree_identical "$HEAD_SHA")" "yes"

echo "== Scenario 7: source title already marked -> [codex] not doubled =="
new_scenario s7
src_commit v2 "[codex] already marked"
run_sync
check "title kept as-is" "$(tail -1 "$STUB_DIR/titles")" "[codex] already marked"

# =========================================================================
# Greptile reviews the mirror, not Komodo. If the ticket does not ride across,
# the only reviewer in the experiment judges Komodo's diff with no idea what was
# asked for, while Tuatara's reviewer sees the ticket on the PR — and the two
# arms stop being reviewed under the same conditions.
echo "== Scenario 8: the source PR's description rides across into the mirror PR =="
new_scenario s8
# A realistic ticket: the bodies Greg writes carry their own "## " headings, so
# this is also the regression test for extracting the ticket by scanning to the
# next heading — that captures the heading and nothing else.
SRC_BODY="## Original Ticket

## Objective

Give the platform a repository lifecycle.

## Deliverable

A caller can create, identify, reopen, and inspect an empty repository.

## What changed

Added the storage interface."
export STUB_SRC_PR=42 STUB_SRC_TITLE="1.1 Create and open repositories"
export STUB_SRC_BODY="$SRC_BODY"
src_commit v2 "1.1 Create and open repositories"
run_sync
body="$(cat "$STUB_DIR/last_body")"
check "ticket heading carried over" \
  "$(printf '%s' "$body" | grep -c '^## Original Ticket$')" "1"
# The part a next-heading parser would have silently dropped.
check "ticket body carried over" \
  "$(printf '%s' "$body" | grep -c 'Give the platform a repository lifecycle')" "1"
check "later ticket sections carried too" \
  "$(printf '%s' "$body" | grep -c '^## Deliverable$')" "1"
# The description is the context a reviewer needs before the diff, so it leads.
check "description leads the body" "$(printf '%s' "$body" | head -1)" "## Original Ticket"
check "provenance still present" \
  "$(printf '%s' "$body" | grep -c '^Source SHA: ')" "1"
unset STUB_SRC_PR STUB_SRC_TITLE STUB_SRC_BODY

# An empty source description must not leave a stray separator leading the body.
echo "== Scenario 9: a source PR with an empty description still syncs =="
new_scenario s9
export STUB_SRC_PR=43 STUB_SRC_TITLE="hotfix" STUB_SRC_BODY=""
src_commit v2 "hotfix"
run_sync
body="$(cat "$STUB_DIR/last_body")"
check "body leads with provenance" "$(printf '%s' "$body" | head -1)" \
  "Source PR: #43 — https://github.com/greptile-projects/vivarium-komodo/pull/43"
check "no stray separator" "$(printf '%s' "$body" | grep -c '^---$')" "0"
unset STUB_SRC_PR STUB_SRC_TITLE STUB_SRC_BODY

# =========================================================================
echo
echo "==================== $PASS passed, $FAIL failed ===================="
[[ "$FAIL" -eq 0 ]]
