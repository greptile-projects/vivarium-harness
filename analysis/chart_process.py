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

WINDOW = 20


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


def _rolling(values: list[tuple[int, float]]) -> list[tuple[int, float]]:
    output = []
    for index, (pr, _) in enumerate(values):
        window = [value for _, value in values[max(0, index - WINDOW + 1): index + 1]]
        output.append((pr, sum(window) / len(window)))
    return output


def agent_build_time_chart(ds: viv.Dataset) -> viz.Chart | None:
    series = {
        arm: [
            (row.pr, row.arms[arm].build_ms / 60_000)
            for row in ds.rows
            if row.arms[arm].build_ms is not None
        ]
        for arm in viv.ARMS
    }
    if any(not series[arm] for arm in viv.ARMS):
        return None
    trends = {arm: _rolling(series[arm]) for arm in viv.ARMS}
    max_pr = max(pr for values in series.values() for pr, _ in values)
    stats = {}
    for arm in viv.ARMS:
        values = [value for _, value in series[arm]]
        early_window = values[:WINDOW]
        recent_window = values[-WINDOW:]
        early = sum(early_window) / len(early_window)
        recent = sum(recent_window) / len(recent_window)
        stats[arm] = (early, recent, None if early == 0 else recent / early)

    def render(theme: viz.Theme):
        fig, (ax,) = viz.new_canvas(
            theme,
            width=10.0,
            height=6.2,
            title="Agent build time over the climb",
            subtitle=(
                f"individual pull requests and trailing {WINDOW}-PR average; "
                "review wait and merge excluded"
            ),
            right=2.05,
            legend_space=0.42,
            bottom=0.95,
        )
        viz.legend(
            fig,
            theme,
            [(viv.ARM_LABEL[arm], theme.arm(arm), arm == "komodo") for arm in viv.ARMS],
            y_from_top_inches=1.05,
        )
        viz.style_axes(ax, theme)
        for arm in viv.ARMS:
            color = theme.arm(arm)
            xs = [pr for pr, _ in series[arm]]
            ys = [value for _, value in series[arm]]
            tx = [pr for pr, _ in trends[arm]]
            ty = [value for _, value in trends[arm]]
            ax.scatter(xs, ys, s=12, color=color, alpha=0.24, linewidths=0, zorder=2)
            viz.line(ax, tx, ty, color, theme, dashed=arm == "komodo", markers=False, zorder=3)
            last_pr, last_value = series[arm][-1]
            ax.scatter(
                [last_pr],
                [last_value],
                s=58,
                color=color,
                edgecolors=theme.surface,
                linewidths=1.5,
                zorder=5,
            )
            ax.annotate(
                f"PR {last_pr}: {last_value:.1f}m",
                xy=(last_pr, last_value),
                xytext=(8, 0),
                textcoords="offset points",
                va="center",
                ha="left",
                fontsize=10.5,
                color=theme.ink,
                annotation_clip=False,
            )
        ax.set_xlim(1, max(2, max_pr))
        ax.set_ylim(bottom=0)
        ax.yaxis.set_major_formatter(lambda value, _: f"{value:.0f}m")
        ax.set_xlabel("Pull request", fontsize=11, color=theme.ink2, labelpad=10)
        viz.end_labels(
            ax,
            theme,
            [
                (trends[arm][-1][1], f"{trends[arm][-1][1]:.1f}m", f"{viv.ARM_LABEL[arm]} average")
                for arm in viv.ARMS
            ],
            x=1.0,
        )
        viz.footnote(
            fig,
            theme,
            "First 20 to latest 20 average: "
            + " · ".join(
                f"{viv.ARM_LABEL[arm]} {stats[arm][0]:.1f}m to {stats[arm][1]:.1f}m "
                f"({'n/a' if stats[arm][2] is None else f'{stats[arm][2]:.1f}x'})"
                for arm in viv.ARMS
            ),
        )
        return fig

    return viz.Chart(
        slug="agent-build-time",
        title="Agent build time over the climb",
        subtitle=f"per pull request and trailing {WINDOW}-PR average",
        note=(
            "The successful initial agent session that opened each pull request. Review activity, time waiting "
            "for the reviewer or peer, and merge time are excluded. Points are individual pull requests; lines "
            f"are trailing {WINDOW}-PR averages."
        ),
        columns=["pr", "arm", "build_minutes", f"trailing_{WINDOW}_pr_average_minutes"],
        rows=[
            [pr, arm, round(minutes, 3), round(dict(trends[arm])[pr], 3)]
            for arm in viv.ARMS
            for pr, minutes in series[arm]
        ],
        render=render,
        data={"stats": stats},
    )


CHARTS = [churn_chart, build_time_chart, agent_build_time_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
