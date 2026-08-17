# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""How large each arm's codebase got, and how that size is distributed.

Total size is measured with ``git grep -c ''`` at every state that landed on
main — a per-file line count over a commit with nothing checked out. Generated
files (lockfiles, ``go.sum``) are excluded everywhere: a 110k-line lockfile would
be the loudest thing in every size chart and would say nothing about either arm.

Size alone is not quality, in either direction. The reason to plot it is that
every rate in the report is normalised by it, and that *where* the lines sit —
spread across files or piled into a few — is a property review can plausibly
affect.
"""

from __future__ import annotations

import vivarium as viv
import viz

TOP_FILES = 10
PATH_WIDTH = 42


def shorten_path(path: str, width: int = PATH_WIDTH) -> str:
    """Keep the filename and as much leading path as fits, eliding the middle.

    A y-axis label that runs off the left edge is the same failure as a bar label
    clipped by its own mark, so the eliding is done here rather than left to the
    renderer.
    """
    if len(path) <= width:
        return path
    head, _, tail = path.rpartition("/")
    if len(tail) >= width - 2:
        return "…" + tail[-(width - 1) :]
    return head[: width - len(tail) - 2] + "…/" + tail


def _pr_series(timeline: viv.Timeline, value_of) -> tuple[list[int], list[float]]:
    return [s.pr for s in timeline.snapshots], [value_of(s) for s in timeline.snapshots]


def codebase_size_chart(ds: viv.Dataset) -> viz.Chart | None:
    if not ds.has_git:
        return None
    series = {arm: _pr_series(ds.repos[arm], lambda s: s.total) for arm in viv.ARMS}

    def render(theme: viz.Theme):
        return viz.line_over_prs(
            theme,
            [
                (
                    viv.ARM_LABEL[arm],
                    theme.arm(arm),
                    series[arm][0],
                    series[arm][1],
                    arm == "komodo",
                )
                for arm in viv.ARMS
            ],
            title="Codebase size over the climb",
            subtitle="tracked lines of text on main, generated files excluded",
            y_fmt=lambda value: f"{value / 1000:.0f}k",
            end_fmt=lambda value: f"{value / 1000:.1f}k",
            x_max=ds.max_pr,
        )

    heads = {arm: ds.repos[arm].snapshots[-1] for arm in viv.ARMS}
    return viz.Chart(
        slug="codebase-size",
        title="Codebase size over the climb",
        subtitle="tracked lines of text on main, generated files excluded",
        note=(
            "One point per pull request that landed on main, first-parent. Counts every tracked text file except "
            "lockfiles and `go.sum`; binaries are dropped by `git grep -I`. The CSV breaks the same totals into "
            "code, test, markdown, config and other so a rise can be attributed rather than guessed at."
        ),
        columns=["pr", "arm", "total_lines", "code_lines", "test_lines", "markdown_lines", "config_lines", "other_lines", "files"],
        rows=[
            [s.pr, arm, s.total, s.code, s.test, s.markdown, s.config, s.other, s.files]
            for arm in viv.ARMS
            for s in ds.repos[arm].snapshots
        ],
        render=render,
        data={arm: {"pr": series[arm][0], "total": series[arm][1]} for arm in viv.ARMS},
    )


def biggest_files_chart(ds: viv.Dataset) -> viz.Chart | None:
    """The ten largest files in each arm, as small multiples on a shared scale.

    Two facets rather than one grouped chart: the arms do not agree on which
    files got large, so pairing them by path would invent a comparison that is not
    there. A shared x-limit is what makes the two panels readable together.
    """
    if not ds.has_git:
        return None

    top = {
        arm: sorted(ds.repos[arm].head_files.items(), key=lambda item: -item[1])[:TOP_FILES]
        for arm in viv.ARMS
    }
    ceiling = max(lines for arm in viv.ARMS for _, lines in top[arm])

    def render(theme: viz.Theme):
        fig, axes = viz.new_canvas(
            theme,
            width=10.0,
            height=7.6,
            title="The ten largest files in each codebase",
            subtitle=f"lines of text at pull request {ds.max_pr}",
            rows=2,
            row_gap=1.15,
            left=3.6,
            right=1.0,
            bottom=0.55,
            legend_space=0.30,
        )
        for ax, arm in zip(axes, viv.ARMS):
            entries = top[arm]
            positions = list(range(len(entries)))
            viz.style_axes(ax, theme, y_grid=False, x_grid=True, baseline=False)
            viz.bars(ax, positions, [lines for _, lines in entries], theme.arm(arm), width=0.62, horizontal=True)
            viz.bar_tip_labels(ax, theme, positions, [lines for _, lines in entries], lambda v: f"{v:,.0f}")
            ax.set_yticks(positions)
            ax.set_yticklabels([shorten_path(path) for path, _ in entries], fontsize=10)
            ax.set_ylim(-0.7, len(entries) - 0.3)
            ax.invert_yaxis()
            ax.set_xlim(0, ceiling * 1.16)
            ax.set_xticks([])
            ax.annotate(
                f"{viv.ARM_LABEL[arm]} — {viv.ARM_BLURB[arm]}",
                xy=(0, 1.0),
                xycoords="axes fraction",
                xytext=(0, 12),
                textcoords="offset points",
                fontsize=11.5,
                fontweight="bold",
                color=theme.ink2,
            )
        return fig

    heads = {arm: ds.repos[arm].snapshots[-1] for arm in viv.ARMS}
    return viz.Chart(
        slug="biggest-files",
        title="The ten largest files in each codebase",
        subtitle=f"lines of text at pull request {ds.max_pr}",
        note=(
            "Both panels share one x-scale, so a bar in the lower panel is directly comparable to one above it. "
            f"Largest single file: Tuatara {heads['tuatara'].largest_code:,} lines of code, "
            f"Komodo {heads['komodo'].largest_code:,}. Values sit outside the bar tip — a label that would not fit "
            "inside its mark is moved, never clipped."
        ),
        columns=["arm", "rank", "path", "lines"],
        rows=[
            [arm, rank + 1, path, lines]
            for arm in viv.ARMS
            for rank, (path, lines) in enumerate(top[arm])
        ],
        render=render,
        data={arm: top[arm] for arm in viv.ARMS},
    )


def concentration_chart(ds: viv.Dataset) -> viz.Chart | None:
    """How much of each codebase lives in its ten largest files.

    The counterpart to total size: two codebases of the same size are not the same
    codebase if one of them keeps a fifth of itself in ten files.
    """
    if not ds.has_git:
        return None
    series = {arm: _pr_series(ds.repos[arm], lambda s: s.top10_share * 100) for arm in viv.ARMS}

    def render(theme: viz.Theme):
        return viz.line_over_prs(
            theme,
            [
                (
                    viv.ARM_LABEL[arm],
                    theme.arm(arm),
                    series[arm][0],
                    series[arm][1],
                    arm == "komodo",
                )
                for arm in viv.ARMS
            ],
            title="How concentrated the code is",
            subtitle="share of all code lines living in the ten largest source files",
            y_fmt=lambda value: f"{value:.0f}%",
            end_fmt=lambda value: f"{value:.1f}%",
            x_max=ds.max_pr,
        )

    return viz.Chart(
        slug="code-concentration",
        title="How concentrated the code is",
        subtitle="share of all code lines living in the ten largest source files",
        note=(
            "Code files only — markdown, config and assets are excluded, so a growing docs tree cannot move this "
            "line. A rising share means new work is being added to files that were already the biggest; a falling "
            "share means it is being spread across new ones."
        ),
        columns=["pr", "arm", "top10_share_pct", "largest_code_file_lines", "code_files"],
        rows=[
            [s.pr, arm, round(s.top10_share * 100, 3), s.largest_code, s.code_files]
            for arm in viv.ARMS
            for s in ds.repos[arm].snapshots
        ],
        render=render,
        data={arm: {"pr": series[arm][0], "share_pct": series[arm][1]} for arm in viv.ARMS},
    )


CHARTS = [codebase_size_chart, biggest_files_chart, concentration_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
