# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""How long Greptile took to review each arm's first draft.

The same clock on both arms: from the moment the pull request became reviewable
to the reviewer's first comment on it. For Tuatara that is the landing's start —
the harness pushes the branch, opens the pull request and waits — read against
the first round's comment timestamps. For Komodo it is the mirror pull request's
creation against the mirror conversation, since Komodo's only draft is reviewed
there and nowhere else.

Averaged in blocks, like every other paired figure, because a single review's
latency is mostly queue noise; the block mean is where a trend would show.
"""

from __future__ import annotations

import vivarium as viv
import viz


def review_time_chart(ds: viv.Dataset) -> viz.Chart:
    def minutes_of(row: viv.PullRequest, arm: str) -> float | None:
        value = row.t_first_review_ms if arm == "tuatara" else row.k_review_ms
        return None if value is None else value / 60_000

    series = {}
    counts: dict[str, list[int]] = {}
    for arm in viv.ARMS:
        series[arm], counts[arm] = viv.block_average(
            ds.rows, ds.blocks, lambda row, arm=arm: minutes_of(row, arm)
        )
    labels = [block.label for block in ds.blocks]

    def render(theme: viz.Theme):
        return viz.line_over_blocks(
            theme,
            [
                (viv.ARM_LABEL[arm], theme.arm(arm), series[arm], arm == "komodo")
                for arm in viv.ARMS
            ],
            labels,
            title="How long Greptile took to review the first draft",
            subtitle=f"average minutes to the first review comment, per {ds.block_size}-PR block",
            y_fmt=lambda value: f"{value:.0f}m",
            end_fmt=lambda value: f"{value:.1f}m",
        )

    return viz.Chart(
        slug="review-time",
        title="How long Greptile took to review the first draft",
        subtitle=f"average minutes to the first review comment, per {ds.block_size}-PR block",
        note=(
            "From the moment the pull request became reviewable to Greptile's first comment on it — the review "
            "request (landing start) for Tuatara, the mirror pull request's creation for Komodo. Comment creation "
            "timestamps, not edits: Greptile edits its comments in place, so only the creation stamp says when "
            "the review arrived. Tuatara's later rounds are excluded — the first draft is the only state both "
            "arms present for review. A pull request whose review left no timestamped comment is left out of its "
            "block rather than counted as zero."
        ),
        columns=[
            "pr_block",
            "tuatara_prs",
            "komodo_prs",
            "tuatara_avg_review_minutes",
            "komodo_avg_review_minutes",
        ],
        rows=[
            [
                block.label,
                counts["tuatara"][index],
                counts["komodo"][index],
                None if series["tuatara"][index] is None else round(series["tuatara"][index], 2),
                None if series["komodo"][index] is None else round(series["komodo"][index], 2),
            ]
            for index, block in enumerate(ds.blocks)
        ],
        render=render,
        data={"labels": labels, **series},
    )


CHARTS = [review_time_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
