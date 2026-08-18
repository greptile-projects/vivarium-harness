# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""The experiment's headline figure: Greptile confidence over the whole climb.

Three measurements of the same code at three moments. Tuatara *first* is what the
agent produced before any review reached it; Tuatara *final* is what the reviewer
thought of the code that actually merged; Komodo is the same reviewer's verdict on
the unreviewed arm's merged state, taken in the private mirror the Komodo agent
cannot see. The gap between the first two is the review's effect inside a pull
request; the gap between the first and the third is the experiment's control.

Averaged in blocks rather than plotted per pull request: a confidence score is a
0–5 integer, so a per-PR line is a staircase that hides the trend. The block size
is a flag, and a trailing short block is marked, never padded.
"""

from __future__ import annotations

import vivarium as viv
import viz


def scores_chart(ds: viv.Dataset) -> viz.Chart:
    blocks = ds.blocks
    final, final_n = viv.block_average(ds.rows, blocks, lambda row: row.t_final)
    first, _ = viv.block_average(ds.rows, blocks, lambda row: row.t_first)
    komodo, _ = viv.block_average(ds.rows, blocks, lambda row: row.k_score)
    lift = [
        None if (a is None or b is None) else a - b
        for a, b in zip(final, first)
    ]

    labels = [block.label for block in blocks]
    x = list(range(len(blocks)))
    partial = any(block.partial for block in blocks)

    def render(theme: viz.Theme):
        fig, (top, bottom) = viz.new_canvas(
            theme,
            width=10.0,
            height=7.4,
            title=f"Greptile confidence over {ds.max_pr} pull requests",
            subtitle=(
                f"average per {ds.block_size}-PR block, 0–5 scale"
                + (" (last block partial)" if partial else "")
            ),
            rows=2,
            height_ratios=[3.0, 1.15],
            row_gap=0.75,
            right=2.0,
            legend_space=0.42,
        )
        viz.legend(
            fig,
            theme,
            [
                ("Tuatara final", theme.tuatara, False),
                ("Tuatara first review", theme.tuatara_first, False),
                ("Komodo (no review)", theme.komodo, True),
            ],
            y_from_top_inches=1.05,
        )

        viz.style_axes(top, theme)
        viz.area_between(top, x, final, first, theme.tuatara)
        viz.line(top, x, first, theme.tuatara_first, theme)
        viz.line(top, x, komodo, theme.komodo, theme, dashed=True)
        viz.line(top, x, final, theme.tuatara, theme)
        top.set_ylim(0, 5.2)
        top.set_yticks([0, 1, 2, 3, 4, 5])
        top.set_xlim(-0.35, len(blocks) - 0.65)
        top.set_xticks(x)
        top.set_xticklabels([])

        ends = [
            (value[-1], f"{value[-1]:.2f}", label)
            for value, label in (
                (final, "Tuatara final"),
                (first, "Tuatara first"),
                (komodo, "Komodo"),
            )
            if value and value[-1] is not None
        ]
        viz.end_labels(top, theme, ends, x=1.0)

        viz.style_axes(bottom, theme, y_grid=False)
        viz.bars(bottom, x, lift, theme.tuatara, width=0.46)
        viz.value_labels(bottom, theme, x, lift, lambda value: f"{value:+.2f}")
        # Lift can be negative — a settled score below the first review's — so
        # the limits come from both extrema and always keep zero in view.
        highest = max((value for value in lift if value is not None), default=1.0)
        lowest = min((value for value in lift if value is not None), default=0.0)
        low = min(lowest, 0.0) * 1.34
        high = max(highest, 0.0) * 1.34
        bottom.set_ylim(low, high if high > low else low + 1.34)
        bottom.set_yticks([])
        bottom.set_xlim(-0.35, len(blocks) - 0.65)
        viz.category_ticks(bottom, labels)
        bottom.set_xlabel("Pull request block", fontsize=11, color=theme.ink2, labelpad=10)
        bottom.annotate(
            "review lift within a pull request (final − first)",
            xy=(0, 1.0),
            xycoords="axes fraction",
            xytext=(0, 14),
            textcoords="offset points",
            fontsize=11,
            fontweight="bold",
            color=theme.ink2,
        )
        return fig

    return viz.Chart(
        slug="scores",
        title=f"Greptile confidence over {ds.max_pr} pull requests",
        subtitle=f"average per {ds.block_size}-PR block, 0–5 scale",
        note=(
            "Confidence Score parsed from Greptile's pull-request overview comment. First = the score on the review "
            "round the arm was first handed. Final = that same comment as it stands today, re-read from GitHub: "
            "Greptile keeps reviewing after the merge and edits its overview in place, so this is the reviewer's "
            "settled verdict on the merged state rather than a snapshot taken mid-exchange. That is the same "
            "measurement Komodo's series carries — its private mirror is read the same way, and its agent never "
            "sees it. A pull request whose review produced no score is left out of its block rather than counted "
            "as zero."
        ),
        columns=[
            "pr_block",
            "prs_scored",
            "tuatara_first",
            "tuatara_final",
            "review_lift",
            "komodo_no_review",
        ],
        rows=[
            [
                block.label,
                final_n[index],
                None if first[index] is None else round(first[index], 3),
                None if final[index] is None else round(final[index], 3),
                None if lift[index] is None else round(lift[index], 3),
                None if komodo[index] is None else round(komodo[index], 3),
            ]
            for index, block in enumerate(blocks)
        ],
        render=render,
        data={"labels": labels, "final": final, "first": first, "komodo": komodo, "lift": lift},
    )


CHARTS = [scores_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
