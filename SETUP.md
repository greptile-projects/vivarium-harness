# Arm B review-mirror pipeline — setup

This harness replays each successive `vivarium-b` **main-state** into a private
mirror (`makors/vivarium-b-mirror`) as its own Greptile-reviewed PR, one at a
time, in order. The mirror is a review record of arm B's landed states; the arm
B agent has no access to it and cannot infer that reviews exist.

Pieces:

| Where | File | Role |
|-------|------|------|
| `vivarium-b` | `.github/workflows/main-sync.yml` | fires a `repository_dispatch` (`armb-main-push`) on every push to `main`. Fire-and-forget; neutral naming. |
| `vivarium-harness` | `.github/workflows/mirror-sync.yml` | the sequential sync job (dispatch + daily cron + manual). |
| `vivarium-harness` | `scripts/mirror_sync.sh` | the state-based sync loop. |
| `makors/vivarium-b-mirror` | — | private mirror. `main` tree byte-identical to arm B; disclosure README on `docs`; **GitHub Actions disabled**. |

## Tokens (two fine-grained PATs)

GitHub fine-grained PATs must be created in the web UI
(<https://github.com/settings/personal-access-tokens>) — they cannot be minted
via API/CLI. Create both, then store them as **secrets in `vivarium-harness`**.

### 1. `MIRROR_PUSH_TOKEN`

- **Resource owner: `makors`** (the personal account that owns the mirror) — **NOT** the org.
  - ⚠️ A wrong resource owner is the classic failure here: a token owned by the
    org (or by a user without access) yields **404 Not Found** on the mirror
    repo, *not* a 403/permission error. If the pipeline logs 404s against
    `makors/vivarium-b-mirror`, the resource owner is wrong.
- Repository access: **only** `makors/vivarium-b-mirror`.
- Permissions: **Contents: Read and write**, **Pull requests: Read and write**.
  (If adding the `review-timeout` label ever 403s, also grant **Issues: Read and
  write** — label writes can route through the issues endpoint.)

### 2. `HARNESS_ORG_TOKEN`

- **Resource owner: the org** (`greptile-projects`).
- Repository access: `greptile-projects/vivarium-b` **and**
  `greptile-projects/vivarium-harness`.
- Permissions:
  - on `vivarium-b`: **Contents: Read**, **Metadata: Read**, **Pull requests: Read**
    (read arm B — it is private — and resolve commit → PR title/author).
  - on `vivarium-harness`: **Variables: Read and write**, **Metadata: Read**
    (read/advance `LAST_SYNCED_SHA`).

Store both:

```sh
gh secret set MIRROR_PUSH_TOKEN -R greptile-projects/vivarium-harness   # paste token 1
gh secret set HARNESS_ORG_TOKEN -R greptile-projects/vivarium-harness   # paste token 2
```

`vivarium-b` also needs a secret **`DISPATCH_TOKEN`** for its dispatch workflow —
a token that can send a `repository_dispatch` to `vivarium-harness` (fine-grained,
resource owner = org, `vivarium-harness` → **Contents: Read and write**, which
grants dispatch; or a classic PAT with `repo`). Store with
`gh secret set DISPATCH_TOKEN -R greptile-projects/vivarium-b`.

## Repository variables (in `vivarium-harness`)

Already set by bootstrap; listed here for reference:

| Variable | Value | Meaning |
|----------|-------|---------|
| `LAST_SYNCED_SHA` | `eab8fcf…` | last arm B main-state mirrored. **State lives here, never in the mirror** (that would break tree identity). Bootstrap value = the arm B main SHA the mirror was seeded from. |
| `SOURCE_REPO` | `greptile-projects/vivarium-b` | arm B. |
| `MIRROR_REPO` | `makors/vivarium-b-mirror` | the mirror. |
| `GREPTILE_BOT_LOGIN` | `greptile-apps[bot]` | login the sync loop polls for. **Confirm the exact string** from a real Greptile review on an arm A PR and update if different. |

```sh
gh variable set LAST_SYNCED_SHA -R greptile-projects/vivarium-harness -b <sha>
```

## Greptile bot login parameter

The sync loop waits for a PR review **or** comment authored by
`GREPTILE_BOT_LOGIN` before merging. The default `greptile-apps[bot]` is a
placeholder — at setup time arm A had no Greptile-reviewed PR to read the exact
login from. **Confirm it**: open a real Greptile review on an arm A PR, read the
author login (`gh api repos/greptile-projects/vivarium-a/pulls/<n>/reviews -q '.[].user.login'`),
and set the `GREPTILE_BOT_LOGIN` variable to match. If it is wrong, every PR will
hit the 10-minute timeout and get the `review-timeout` label instead of a review.

## One-time bootstrap (already done)

1. Created `makors/vivarium-b-mirror` — **private, empty**.
2. Disabled GitHub Actions on it (mirrored arm-B app workflows stay inert; the
   Greptile app is a webhook, unaffected).
3. Pushed arm B's current `main` tree as the initial mirror `main` commit — arm
   B agent as **author**, sync bot as **committer**, `Mirrored-from:` trailer.
4. Added the disclosure README on the `docs` branch (kept off `main` to preserve
   tree identity) and set `docs` as the default branch.
5. Set `LAST_SYNCED_SHA` to that source SHA.

To re-verify or run manually: **Actions → mirror-sync → Run workflow**
(`workflow_dispatch`). It is idempotent and safe to re-run.

## Behavior notes

- **Sequential**: `concurrency: mirror-sync`, `cancel-in-progress: false`. One
  open mirror PR at a time.
- **Timeout**: polls every 60s, 10-min cap. On timeout → `review-timeout` label,
  proceed (sync integrity beats review completeness).
- **Force-push**: if `LAST_SYNCED_SHA` is no longer an ancestor of arm B `main`,
  one coarse `[force-push]`-prefixed PR to current main, then normal resume.
- **History-only rewrite** (identical tree): no PR, state advances.
- **Idempotent**: a crash mid-cycle resumes on the next run (open `sync/<sha>`
  PR is detected and finished; already-merged states advance without a dup PR).
- **Tree identity**: after every merge, `git diff <source-sha> mirror/main` must
  be empty or the run fails loudly.
