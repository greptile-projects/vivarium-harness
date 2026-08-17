# analysis

Standalone Python that turns the experiment's artifacts into reproducible
figures. Nothing here is imported by the harness and nothing here imports the
harness: it reads finished files, writes a timestamped directory, and touches
nothing else.

```bash
uv run analysis/make_report.py
```

That is the whole thing. It prints the path to `report.pdf` when it is done — a
plain white document with each light-theme figure and its method note — with
standalone light and dark charts, the CSVs behind them, and a manifest of what
was read sitting beside it.

## What it needs

- [`uv`](https://docs.astral.sh/uv/). Each script carries its own dependency
  block (PEP 723), so `uv run` installs matplotlib (plus `pypdf` and `pillow`,
  for placing each chart into the PDF as a lossless image) into a throwaway
  environment the first time and reuses it afterwards. There is nothing to
  activate and nothing to install by hand.
- The **state backup** — a directory with `results/` in it. Looked up as
  `$VIVARIUM_STATE_BACKUP`, else `../vivarium-state-backup`.
- **`gh`**, authenticated against the arm repositories. The headline chart's
  `final` line is Greptile's overview comment re-read from GitHub, because it is
  edited in place after the merge and the recorded rounds stop before that. One
  API sweep, about two seconds. Without `gh` the run falls back to the cache and
  then to the last recorded round, and says so in the report; `--no-gh` skips it
  deliberately.
- Each arm's **git checkout**, for the repository-size figures. Looked up as
  `$VIVARIUM_TUATARA` / `$VIVARIUM_KOMODO`, else `../vivarium-tuatara` and
  `../vivarium-komodo`. Read-only, and `--no-git` skips them entirely — the
  review-side figures need only the state backup.

Both checkouts are usually stale on an analysis machine. `--fetch` updates them
first; without it the run reads whatever `origin/main` already points at, which
is what makes an offline run reproducible.

## Options

```
--block-size N   pull requests per x-axis block in blocked charts (default 20)
--max-pr N       analyse only PRs 1..N — pin it to redraw an older figure
--fetch          git fetch each arm before reading history
--no-git         skip every git-derived figure
--no-gh          do not re-read settled review scores; use the last recorded round
--refresh        ignore the snapshot cache and re-measure history
--out DIR        write here instead of out/<timestamp>/
--quiet          print only the output path
--open/--no-open open report.pdf when done (default: on at a terminal, off when piped)
```

## Output

```
out/2026-08-16T23-15-23Z/
  report.pdf            the report — plain white landscape pages; each chart a copyable image
  charts/<slug>-{light,dark}.{svg,png}
  data/<slug>.csv       the numbers behind each figure
  data/pull-requests.csv    one row per PR, both arms joined
  data/findings.csv         one row per finding
  manifest.json         inputs, commits, options, caveats
out/latest -> 2026-08-16T23-15-23Z
```

`out/` and `.cache/` are gitignored. A run **never overwrites an earlier one**,
so a figure and the manifest that explains it stay together; delete old
directories by hand when you no longer want them.

## Running one figure at a time

Every `chart_*.py` is also a script. It takes the same options and writes only
its own figures, which is the fast loop while editing one chart:

```bash
uv run analysis/chart_scores.py --out /tmp/try
uv run analysis/chart_codebase.py --max-pr 175
```

## Layout

| File | What it is |
|---|---|
| `vivarium.py` | the data layer — reads `run.json`, the review mirror, and git history into one dataset. Standard library only. |
| `viz.py` | the drawing layer — palette, mark specs, the shared chart forms, and light/dark output. |
| `chart_scores.py` | the headline confidence figure |
| `chart_review.py` | score distribution, and what each review round is worth |
| `chart_findings.py` | findings per thousand lines changed |
| `chart_ladder.py` | how large the tickets themselves got — the experiment's input |
| `chart_codebase.py` | codebase size, largest files, code concentration |
| `chart_docs.py` | markdown growth, `AGENTS.md` growth |
| `chart_process.py` | churn per pull request, build time per pull request |
| `make_pdf.py` | the report — page layout, reading order, headline numbers, caveats |
| `make_report.py` | builds the dataset once, renders every chart, writes the CSVs and the PDF |
| `METRICS.md` | what each number means, and what it deliberately excludes |

Adding a figure is one function returning a `viz.Chart`, listed in its module's
`CHARTS`, plus its slug in `make_pdf.SECTIONS` to place it in the document.

## Caching

Measuring a repository state is a `git grep` per commit; 220 states per arm takes
about ten seconds the first time. Results are cached by commit SHA in `.cache/`,
so later runs are instant. `--refresh` throws the cache away — do that if the
measurement rules in `vivarium.py` change, since the cache stores the summary,
not the tree.
