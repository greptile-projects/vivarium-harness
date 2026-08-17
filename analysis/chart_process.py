# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""What each pull request cost: how much it changed, and how long it took.

Both arms are handed the same subticket at the same moment from the same commit,
so a difference in either measure is attributable to the one thing that differs.
These are the denominators the rest of the report divides by, which is reason
enough to plot them on their own rather than leave them implicit.

Build time is the agent session only — the attempt that produced the merged work,
excluding the review wait, which Komodo does not have and which would otherwise
make the comparison meaningless.
"""

from __future__ import annotations

import vivarium as viv
import viz


def churn_chart(ds: viv.Dataset) -> viz.Chart:
    series = {}
    counts: list[int] = []
    for arm in viv.ARMS:
        values, arm_counts = viv.block_average(
            ds.rows, ds.blocks, lambda row, arm=arm: row.arms[arm].churn
        )
        series[arm] = values
        if arm == "tuatara":
            counts = arm_counts
    labels = [block.label for block in ds.blocks]

    def render(theme: viz.Theme):
        return viz.line_over_blocks(
            theme,
            [
                (viv.ARM_LABEL[arm], theme.arm(arm), series[arm], arm == "komodo")
                for arm in viv.ARMS
            ],
            labels,
            title="How much each pull request changed",
            subtitle=f"average lines added + deleted, per {ds.block_size}-PR block",
            y_fmt=lambda value: f"{value:,.0f}",
            end_fmt=lambda value: f"{value:,.0f}",
        )

    return viz.Chart(
        slug="churn",
        title="How much each pull request changed",
        subtitle=f"average lines added + deleted, per {ds.block_size}-PR block",
        note=(
            "GitHub's own additions + deletions for each merged pull request, re-read after the merge so "
            "Tuatara's numbers include the fixes its review produced. This is the denominator the findings rate "
            "divides by; plotted here so a change in that rate can be checked against a change in churn."
        ),
        columns=["pr_block", "prs", "tuatara_avg_lines_changed", "komodo_avg_lines_changed"],
        rows=[
            [
                block.label,
                counts[index],
                None if series["tuatara"][index] is None else round(series["tuatara"][index], 1),
                None if series["komodo"][index] is None else round(series["komodo"][index], 1),
            ]
            for index, block in enumerate(ds.blocks)
        ],
        render=render,
        data={"labels": labels, **series},
    )


def build_time_chart(ds: viv.Dataset) -> viz.Chart:
    def minutes(row: viv.PullRequest, arm: str) -> float | None:
        value = row.arms[arm].build_ms
        return None if value is None else value / 60_000

    series = {}
    counts: list[int] = []
    for arm in viv.ARMS:
        values, arm_counts = viv.block_average(
            ds.rows, ds.blocks, lambda row, arm=arm: minutes(row, arm)
        )
        series[arm] = values
        if arm == "tuatara":
            counts = arm_counts
    labels = [block.label for block in ds.blocks]

    retries = {
        arm: sum(1 for row in ds.rows if row.arms[arm].attempts > 1) for arm in viv.ARMS
    }

    def render(theme: viz.Theme):
        return viz.line_over_blocks(
            theme,
            [
                (viv.ARM_LABEL[arm], theme.arm(arm), series[arm], arm == "komodo")
                for arm in viv.ARMS
            ],
            labels,
            title="How long each arm took to build a pull request",
            subtitle=f"average agent session minutes, per {ds.block_size}-PR block",
            y_fmt=lambda value: f"{value:.0f}m",
            end_fmt=lambda value: f"{value:.1f}m",
        )

    return viz.Chart(
        slug="build-time",
        title="How long each arm took to build a pull request",
        subtitle=f"average agent session minutes, per {ds.block_size}-PR block",
        note=(
            "The duration of the attempt that produced the merged work — the agent writing code, not the review "
            "wait or the merge, so the two arms are timed on the same activity. Both arms start each subticket "
            f"from the same commit at the same moment. Subtickets that needed more than one attempt: "
            f"Tuatara {retries['tuatara']}, Komodo {retries['komodo']} of {len(ds.rows)}; the per-PR attempt "
            "counts are in the table."
        ),
        columns=[
            "pr_block",
            "prs",
            "tuatara_avg_build_minutes",
            "komodo_avg_build_minutes",
            "tuatara_retried_prs",
            "komodo_retried_prs",
        ],
        rows=[
            [
                block.label,
                counts[index],
                None if series["tuatara"][index] is None else round(series["tuatara"][index], 2),
                None if series["komodo"][index] is None else round(series["komodo"][index], 2),
                sum(1 for row in ds.rows if block.start <= row.pr <= block.end and row.arms["tuatara"].attempts > 1),
                sum(1 for row in ds.rows if block.start <= row.pr <= block.end and row.arms["komodo"].attempts > 1),
            ]
            for index, block in enumerate(ds.blocks)
        ],
        render=render,
        data={"labels": labels, **series, "retries": retries},
    )


CHARTS = [churn_chart, build_time_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
