# Komodo review-mirror pipeline — setup

This harness replays each successive `vivarium-komodo` **main-state** into a private
mirror (`makors/vivarium-komodo-mirror`) as its own Greptile-reviewed PR, one at a
time, in order. The mirror is a review record of Komodo's landed states; the
Komodo agent has no access to it and cannot infer that reviews exist.

The disposable validation pair is deliberately separate:
`greptile-projects/vivarium-test-komodo` dispatches
`test-komodo-main-push`, and `.github/workflows/mirror-sync-test.yml` replays it
into `makors/vivarium-test-komodo-mirror`. It has its own workflow, concurrency
group, repository variables, and `TEST_LAST_SYNCED_SHA`; testing the pipeline
there cannot advance or write the production mirror.

Pieces:

| Where | File | Role |
|-------|------|------|
| `vivarium-komodo` | `.github/workflows/main-sync.yml` | fires a `repository_dispatch` (`komodo-main-push`) on every push to `main`. Fire-and-forget; neutral naming. |
| `vivarium-harness` | `.github/workflows/mirror-sync.yml` | the sequential sync job (dispatch + daily cron + manual). |
| `vivarium-harness` | `scripts/mirror_sync.sh` | the state-based sync loop. |
| `makors/vivarium-komodo-mirror` | — | private mirror. `main` tree byte-identical to Komodo; disclosure README on `docs`; **GitHub Actions disabled**. |

## Credentials

Mirror-side operations (push, open PR, merge) run through the **`vivarium-mirror`
GitHub App** so they are attributed to `vivarium-mirror[bot]`, never a human
account. Org-side reads and the state variable use one fine-grained PAT.

### 1. `vivarium-mirror` GitHub App (mirror push / PR / merge)

Why an App and not a PAT: the pipeline runs in `vivarium-harness` but acts on the
mirror **cross-repo**, so any PAT would attribute every mirror PR to the PAT
owner (a human). `github-actions[bot]` isn't available cross-repo either — it
only exists for workflows running *inside* the target repo, and the mirror hosts
no workflows by design. A GitHub App installation token gives a real bot identity
(`vivarium-mirror[bot]`) with short-lived, least-privilege tokens.

Create it (web UI, one time):

1. **Create the App** — <https://github.com/settings/apps/new> (owner: `makors`,
   the mirror's account). Name it `vivarium-mirror`. It needs no webhook (uncheck
   Active). Repository permissions:
   - **Contents: Read and write**
   - **Pull requests: Read and write**
   - **Workflows: Read and write** — ⚠️ **mandatory**. Komodo's tree contains
     `.github/workflows/*` files (its app workflows + the `main-sync.yml` dispatch
     file); tree identity forces those into every synced mirror state, and GitHub
     **rejects any push that creates/updates a file under `.github/workflows/`
     unless the token can write workflows** (error: `refusing to allow ... to
     create or update workflow ... without workflow scope`). The whole sync fails
     at the push step without it. Safe here because the mirror has Actions
     **disabled**, so the files stay inert.
2. **Generate a private key** (App settings → Private keys → Generate) and
   download the `.pem`.
3. **Install the App** on `makors/vivarium-komodo-mirror` only (App → Install App →
   your account → Only select repositories).
   - ⚠️ The App must be installed on the **`makors` account** (mirror owner). If
     it isn't installed where the repo lives, the token has no access and pushes
     404 (not 403).
4. **Store secrets in `vivarium-harness`:**

```sh
gh secret set MIRROR_APP_ID          -R greptile-projects/vivarium-harness -b "<numeric app id>"
gh secret set MIRROR_APP_PRIVATE_KEY -R greptile-projects/vivarium-harness < path/to/app.private-key.pem
```

The workflow mints the installation token at runtime via
`actions/create-github-app-token` (scoped by the `MIRROR_OWNER` /
`MIRROR_REPO_NAME` variables) and derives the `vivarium-mirror[bot]` committer
identity automatically. The old `MIRROR_PUSH_TOKEN` PAT is no longer used and can
be deleted.

### 2. `HARNESS_ORG_TOKEN`

- **Resource owner: the org** (`greptile-projects`).
- Repository access: `greptile-projects/vivarium-komodo` **and**
  `greptile-projects/vivarium-harness`.
- Permissions:
  - on `vivarium-komodo`: **Contents: Read**, **Metadata: Read**, **Pull requests: Read**
    (read Komodo — it is private — and resolve commit → PR title/author).
  - on `vivarium-harness`: **Variables: Read and write**, **Metadata: Read**
    (read/advance `LAST_SYNCED_SHA`).

Store it (fine-grained PAT, web-UI only):

```sh
gh secret set HARNESS_ORG_TOKEN -R greptile-projects/vivarium-harness   # paste token
```

`vivarium-komodo` also needs a secret **`DISPATCH_TOKEN`** for its dispatch workflow —
a token that can send a `repository_dispatch` to `vivarium-harness` (fine-grained,
resource owner = org, `vivarium-harness` → **Contents: Read and write**, which
grants dispatch; or a classic PAT with `repo`). Store with
`gh secret set DISPATCH_TOKEN -R greptile-projects/vivarium-komodo`.

## Repository variables (in `vivarium-harness`)

Already set by bootstrap; listed here for reference:

| Variable | Value | Meaning |
|----------|-------|---------|
| `LAST_SYNCED_SHA` | `12f37c6d…` | last Komodo main-state mirrored. **State lives here, never in the mirror** (that would break tree identity). Bootstrap value = the Komodo main SHA the mirror was seeded from. |
| `SOURCE_REPO` | `greptile-projects/vivarium-komodo` | Komodo. |
| `MIRROR_REPO` | `makors/vivarium-komodo-mirror` | the mirror (`owner/name`). |
| `MIRROR_OWNER` | `makors` | mirror owner account — scopes the app installation token. |
| `MIRROR_REPO_NAME` | `vivarium-komodo-mirror` | mirror repo name — scopes the app installation token. |

The test workflow uses the corresponding `TEST_SOURCE_REPO`,
`TEST_MIRROR_REPO`, `TEST_MIRROR_OWNER`, and `TEST_MIRROR_REPO_NAME`
variables. Its state variable is `TEST_LAST_SYNCED_SHA`.

```sh
gh variable set LAST_SYNCED_SHA -R greptile-projects/vivarium-harness -b <sha>
```

## Greptile bot login parameter

The sync loop waits for a PR review **or** comment authored by the fixed
`greptile-apps[bot]` identity before merging. Greptile reviewed real mirror PRs
under this login during bring-up. If it ever changes, update the constant in
`scripts/mirror_sync.sh`; otherwise every PR hits the timeout and gets the
`review-timeout` label instead of a review. Re-confirm with
`gh api "repos/makors/vivarium-komodo-mirror/pulls/<n>/reviews" -q '.[].user.login'`.

## One-time bootstrap (already done)

1. Created `makors/vivarium-komodo-mirror` — **private, empty**.
2. Disabled GitHub Actions on it (mirrored Komodo app workflows stay inert; the
   Greptile app is a webhook, unaffected).
3. Pushed Komodo's current `main` tree as the initial mirror `main` commit — the
   Komodo agent as **author**, sync bot as **committer**, `Mirrored-from:` trailer.
4. Added the disclosure README on the `docs` branch (kept off `main` to preserve
   tree identity) and set `docs` as the default branch.
5. Set `LAST_SYNCED_SHA` to that source SHA.

To re-verify or run manually: **Actions → mirror-sync → Run workflow**
(`workflow_dispatch`). It is idempotent and safe to re-run.

## Snapshotting the reviews

The mirror PRs are the only place Komodo's counterfactual reviews exist, and
Greptile edits its PR-level overview (confidence score included) in place —
after which the earlier text survives only behind GitHub's edit-history API.
`bun run mirror-snapshot` (in the harness repo) files every mirror PR under
`results/mirror/pr-NNNN.json`: churn numbers, the provenance keys back to the
source PR, the full conversation, and an accumulating list of every comment
revision observed, under the same revision rule the harness uses for Tuatara's
live reviews. Idempotent and safe to re-run; run it on a schedule while the
experiment is live. It needs a token that can read the private mirror
(`MIRROR_SNAPSHOT_TOKEN` in `.env`) — the org PAT above deliberately cannot.

## Behavior notes

- **Sequential**: `concurrency: mirror-sync`, `cancel-in-progress: false`. One
  open mirror PR at a time.
- **Timeout**: polls every 60s, 10-min cap. On timeout → `review-timeout` label,
  proceed (sync integrity beats review completeness).
- **`[codex] ` title marker**: every mirror PR title starts with it — that is
  how Greptile recognizes the PR as agent-authored. It goes on outermost (so a
  force-push PR reads `[codex] [force-push] …`) and is not re-applied if the
  source title already carries it. Override with `CODEX_TITLE_PREFIX` only if
  the marker Greptile keys off ever changes.
- **Force-push**: if `LAST_SYNCED_SHA` is no longer an ancestor of Komodo `main`,
  one coarse `[force-push]`-prefixed PR to current main, then normal resume.
- **History-only rewrite** (identical tree): no PR, state advances.
- **Idempotent**: a crash mid-cycle resumes on the next run (open `sync/<sha>`
  PR is detected and finished; already-merged states advance without a dup PR).
- **Tree identity**: after every merge, `git diff <source-sha> mirror/main` must
  be empty or the run fails loudly.
