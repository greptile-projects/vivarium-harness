# Metrics

What each number in the report means, where it comes from, and what it leaves
out. A figure whose definition is not written down here is not reproducible; if
you change a definition in `vivarium.py`, change it here in the same commit.

## The join

Both arms build the same subticket at the same moment from the same commit, and
open a pull request that carries the **same number** in their own repository.
That number is the join key for every paired figure. `vivarium.py` checks it
rather than assuming it, and a mismatch is reported in the "What did not line up"
section rather than quietly averaged.

Runs that produced no pull request pair — an in-flight subticket, an arm that
landed nothing — are excluded and listed.

## Review measurements

Greptile writes one overview comment per pull request and **edits it in place**
across review rounds. The harness records `reviewRounds[].found` (the comment as
it stood at each round) as well as the final `conversation`, which is the only
reason a trajectory exists at all.

| Metric | Definition |
|---|---|
| **Confidence score** | the integer in `Confidence Score: N/5` in Greptile's overview comment. |
| **Tuatara first** | the score on the first review round — the verdict on code the agent wrote before any feedback reached it. |
| **Tuatara final** | the score on that overview comment **as it stands today**, re-read from GitHub. Greptile keeps reviewing after the merge and edits the comment in place, so this is its settled verdict on the merged state. Falls back to the last recorded round when the comment cannot be re-read. |
| **Tuatara final (recorded round)** | the last round that carried a score *before* the merge — a snapshot taken mid-exchange. Kept in `data/pull-requests.csv` as `tuatara_final_recorded_round`, and used as the fallback and under `--no-gh`. |
| **Review lift** | `final − first`, per pull request or per block. It is the review's effect *inside* one pull request. |
| **Komodo** | the score on Komodo's merged state, from the private mirror. One review, no rounds, and the Komodo agent never sees it. |

A pull request whose review produced no score is **left out of its block**, never
counted as zero. Those pull requests are listed in the report.

Blocks average whole pull requests. A trailing block shorter than `--block-size`
is drawn and labelled as partial rather than padded.

### Re-reading `final`

The recorded rounds stop when the harness merges, but Greptile does not: it
re-reviews the merged state and **edits the same overview comment in place**. The
score sitting on the pull request today is therefore a later and more settled
number than the last round `run.json` holds — and it is the same kind of
measurement the Komodo mirror already provides, since the snapshotter keeps that
side current too. Reading it puts both arms on one footing.

So `make_report.py` re-reads it by default, in one sweep of the repository's
issue-comment list:

```
gh api "repos/<slug>/issues/comments?per_page=100" --paginate
```

Roughly two seconds for 220 pull requests, against about four minutes for one
call each. The repository slug comes from the pull-request URL in `run.json`;
answers are cached in `.cache/gh-scores-<slug>.json`.

The fallback chain is **live → cache → last recorded round**, and the report says
in "What did not line up" which one it used, so a figure built offline is never
silently a different measurement. `--no-gh` forces the recorded round.

It matters: 64 of 220 pull requests settled at a different score than the harness
recorded before merging, which moves the first block from 4.55 to 4.85. Both
numbers are in `data/pull-requests.csv` (`tuatara_final_score` and
`tuatara_final_recorded_round`), with the settled comment's edit timestamp.

## Findings

| Metric | Definition |
|---|---|
| **Finding** | one severity-badged issue in a Greptile review — the `<img alt="P0..P3">` badge and the bolded title that follows it. |
| **Deduplication** | by normalised title, keeping the worst severity seen. Greptile restates a finding in the overview and again inline with small wording drift; that is one issue. |
| **Tuatara findings** | from the **first** review round only. |
| **Komodo findings** | from its single mirror review. |
| **Findings per 1k lines changed** | `sum(findings) / sum(additions + deletions) × 1000` across the block — not the mean of per-PR ratios, so a one-line pull request does not weigh as much as a thousand-line one. |

Tuatara's later rounds are deliberately excluded from every rate: comparing
reviewed code against unreviewed code and calling the difference a finding rate
would measure the review twice.

Findings are **not** classified by subject. An earlier version bucketed them with
a keyword taxonomy over the title; it was removed because the instrument did not
survive inspection — 18% of titles matched no keyword and fell into `other` (not
because they were miscellaneous, but because they were phrased in the platform's
own vocabulary), and 42% matched more than one bucket, so the shape of the
distribution was mostly an artifact of the order the patterns happened to be
written in. `data/findings.csv` carries every finding's severity and title, which
is the honest raw material for classifying by hand or by a better method.

## The ladder

| Metric | Definition |
|---|---|
| **Deliverable words** | words in the `## Deliverable` section of `ticket.md` — the part naming what must exist when the subticket is done. Both arms receive the identical ticket, so this is an input to the experiment, not an outcome. |
| **Whole-ticket words** | words in the entire `ticket.md`, Objective + Deliverable + Framing question. In `data/ladder-deliverable-length.csv`. |
| **Fit** | `y = a − b·e^(−c·PR)`, least squares, gridded on `c`. Chosen over a polynomial because it can express a ceiling; a quadratic scores marginally higher R² but turns over and predicts negative words shortly past the observed range, and a log rises without bound. Coefficients and R² are appended to the chart's CSV. |

## Repository measurements

Taken with `git grep -I -c ''` at each state on main's **first-parent** timeline
— a per-file line count over a commit, with nothing checked out and no working
tree touched. `-I` drops binaries, so totals mean "lines of text".

One snapshot per pull request; when a pull request appears twice on the timeline
(a revert, a re-landed branch) the last state wins, because that is the state the
next pull request was built on.

**Excluded everywhere:** `bun.lock`, `package-lock.json`, `yarn.lock`,
`pnpm-lock.yaml`, `go.sum`. They are generated, and a 110k-line lockfile would be
the loudest thing in every size chart.

| Bucket | Extensions |
|---|---|
| code | `.go .ts .tsx .js .jsx .mjs .cjs .css .scss .html .sql .sh` |
| markdown | `.md .mdx` |
| config | `.json .yml .yaml .toml .mod`, `Dockerfile`, `.gitignore`, `.dockerignore` |
| other | everything else tracked and textual |
| test | a subset of code: `_test.go`, `.test.*`, `.spec.*`, or under `test/` `tests/` `__tests__/` |

| Metric | Definition |
|---|---|
| **Codebase size** | total lines across every bucket above. |
| **Largest files** | the ten largest files at the last analysed pull request, per arm, on a shared x-scale. Facets, not a grouped chart: the arms do not agree on which files got large, so pairing by path would invent a comparison. |
| **Code concentration** | share of all **code** lines in the ten largest source files. Markdown and config cannot move it. |
| **Markdown growth** | lines across every `.md`/`.mdx` file. |
| **AGENTS.md growth** | lines across every file named `AGENTS.md`, root and nested. `CLAUDE.md` points at it and is not counted twice. |

## Process measurements

| Metric | Definition |
|---|---|
| **Lines changed (churn)** | GitHub's own `additions + deletions` for the merged pull request, re-read after the merge so Tuatara's include its review fixes. |
| **Build time** | `durationMs` of the attempt that produced the merged work — the agent writing code. It excludes the review wait and the merge, which Komodo does not have and which would make the comparison meaningless. |
| **Attempts** | how many Codex attempts the subticket cost that arm. More than one means the arm failed and was retried; the harness caps it at three. |

## What is not measured

- **Whether a finding was correct.** Every finding count is "what the reviewer
  said", not "what was actually wrong". The two arms are read by the same
  reviewer under the same rules, which is what makes the comparison fair — it is
  not a claim about ground truth.
- **Whether the code works.** Neither test results nor runtime behaviour is read
  here. A merged pull request passed the checks its own repository ran, and
  nothing more is claimed.
- **Anything about the two codebases' feature parity.** Both arms build the same
  ladder, but "same subticket" is not "same implementation".
