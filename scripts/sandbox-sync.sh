#!/usr/bin/env bash
# Reset an isolated arm to origin's current default-branch baseline and report
# the resulting identity in one control-plane crossing.
set -euo pipefail

remote="$(git remote get-url origin)"
branch="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
branch="${branch#origin/}"
branch="${branch:-main}"

# stdout is the control-plane response consumed by the host. Keep it reserved
# for the compact JSON object below: git clean reports removed paths on stdout,
# and one such line would otherwise make a successful reset unparsable.
git fetch --prune origin "$branch" >&2
git checkout -f -B "$branch" "origin/$branch" >&2
git clean -fdx -e node_modules -e LADDER.md >&2
sha="$(git rev-parse HEAD)"

jq -cn \
  --arg remote "$remote" \
  --arg branch "$branch" \
  --arg sha "$sha" \
  '{remote: $remote, branch: $branch, sha: $sha}'
