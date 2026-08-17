# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""How much the reviewer found, normalised by the size of what it reviewed.

A raw finding count says as much about how much code an arm wrote as about how
good that code was, and the two arms do not write the same amount. The chart
here divides by the size of what was reviewed, so a quiet block means "fewer
problems per line", not "a slower week".

Tuatara is measured on its **first** review only. That is the one measurement
taken on code the agent wrote without help, which is the same condition Komodo's
single mirror review is taken under. Using Tuatara's later rounds would compare
reviewed code against unreviewed code and call the difference a finding rate.
"""

from __future__ import annotations

import vivarium as viv
import viz


def _churn(row: viv.PullRequest, arm: str) -> float | None:
    value = row.arms[arm].churn
    return None if value is None else float(value)


def findings_per_kloc_chart(ds: viv.Dataset) -> viz.Chart:
    tuatara, counts = viv.block_ratio(
        ds.rows,
        ds.blocks,
        lambda row: len(row.t_first_findings),
        lambda row: _churn(row, "tuatara"),
        scale=1000,
    )
    komodo, _ = viv.block_ratio(
        ds.rows,
        ds.blocks,
        lambda row: len(row.k_findings),
        lambda row: _churn(row, "komodo"),
        scale=1000,
    )
    labels = [block.label for block in ds.blocks]

    def render(theme: viz.Theme):
        return viz.line_over_blocks(
            theme,
            [
                ("Tuatara", theme.tuatara, tuatara, False),
                ("Komodo", theme.komodo, komodo, True),
            ],
            labels,
            title="Findings per thousand lines changed",
            subtitle=f"first review of each pull request, per {ds.block_size}-PR block",
            y_fmt=lambda value: f"{value:.0f}",
            end_fmt=lambda value: f"{value:.2f}",
        )

    return viz.Chart(
        slug="findings-per-kloc",
        title="Findings per thousand lines changed",
        subtitle=f"first review of each pull request, per {ds.block_size}-PR block",
        note=(
            "A finding is one severity-badged issue in a Greptile review, deduplicated by title so an issue "
            "restated inline counts once. The denominator is GitHub's own additions + deletions for that pull "
            "request, summed across the block before dividing — so one thousand-line pull request is not "
            "outweighed by one one-line pull request. Both arms are counted on the review of code written "
            "without help: Tuatara's first round, Komodo's single mirror review."
        ),
        columns=[
            "pr_block",
            "prs",
            "tuatara_findings_per_1k",
            "komodo_findings_per_1k",
            "tuatara_findings",
            "komodo_findings",
            "tuatara_lines_changed",
            "komodo_lines_changed",
        ],
        rows=[
            [
                block.label,
                counts[index],
                None if tuatara[index] is None else round(tuatara[index], 3),
                None if komodo[index] is None else round(komodo[index], 3),
                sum(len(row.t_first_findings) for row in ds.rows if block.start <= row.pr <= block.end),
                sum(len(row.k_findings) for row in ds.rows if block.start <= row.pr <= block.end),
                sum(int(_churn(row, "tuatara") or 0) for row in ds.rows if block.start <= row.pr <= block.end),
                sum(int(_churn(row, "komodo") or 0) for row in ds.rows if block.start <= row.pr <= block.end),
            ]
            for index, block in enumerate(ds.blocks)
        ],
        render=render,
        data={"labels": labels, "tuatara": tuatara, "komodo": komodo},
    )


CHARTS = [findings_per_kloc_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
