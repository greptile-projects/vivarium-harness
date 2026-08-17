# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""How much prose each arm wrote, and how much of it is instructions to itself.

Two separate questions, so two charts rather than one with two y-scales.

*Markdown* is everything the arms wrote for a human or for the next agent —
`README`s, `docs/`, the running `LOG.md`, and the agent instruction files. It is
the part of the repository nothing forces them to produce.

*AGENTS.md* is narrower and more interesting: the file the next Codex session
loads as its own instructions. Every line an arm adds there is a line it is
choosing to hand its successor, so its growth is the arm writing down what it
learned. Both `AGENTS.md` files in a checkout are counted, root and `apps/web/`.
"""

from __future__ import annotations

import vivarium as viv
import viz

AGENTS_FILE = "AGENTS.md"


def _agents_lines(snapshot: viv.Snapshot) -> int:
    return sum(
        lines
        for path, lines in snapshot.md_by_file.items()
        if path == AGENTS_FILE or path.endswith(f"/{AGENTS_FILE}")
    )


def markdown_growth_chart(ds: viv.Dataset) -> viz.Chart | None:
    if not ds.has_git:
        return None
    series = {
        arm: ([s.pr for s in ds.repos[arm].snapshots], [float(s.markdown) for s in ds.repos[arm].snapshots])
        for arm in viv.ARMS
    }

    def render(theme: viz.Theme):
        return viz.line_over_prs(
            theme,
            [
                (viv.ARM_LABEL[arm], theme.arm(arm), series[arm][0], series[arm][1], arm == "komodo")
                for arm in viv.ARMS
            ],
            title="Markdown written, over the climb",
            subtitle="lines across every .md file on main",
            y_fmt=lambda value: f"{value / 1000:.0f}k",
            end_fmt=lambda value: f"{value:,.0f}",
            x_max=ds.max_pr,
        )

    return viz.Chart(
        slug="markdown-growth",
        title="Markdown written, over the climb",
        subtitle="lines across every .md file on main",
        note=(
            "Every tracked `.md`/`.mdx` file, counted the same way as code. Documentation is not a quality "
            "measure on its own — an arm can write a great deal of it badly — but it is the output nothing in the "
            "ticket forces, so the two arms' habits show up here more plainly than in the code. The CSV carries "
            "the file count alongside the line count, which separates 'wrote more docs' from 'wrote more docs files'."
        ),
        columns=["pr", "arm", "markdown_lines", "markdown_files"],
        rows=[
            [s.pr, arm, s.markdown, s.md_files]
            for arm in viv.ARMS
            for s in ds.repos[arm].snapshots
        ],
        render=render,
        data={arm: {"pr": series[arm][0], "markdown_lines": series[arm][1]} for arm in viv.ARMS},
    )


def agents_md_chart(ds: viv.Dataset) -> viz.Chart | None:
    if not ds.has_git:
        return None
    series = {
        arm: ([s.pr for s in ds.repos[arm].snapshots], [float(_agents_lines(s)) for s in ds.repos[arm].snapshots])
        for arm in viv.ARMS
    }

    def render(theme: viz.Theme):
        return viz.line_over_prs(
            theme,
            [
                (viv.ARM_LABEL[arm], theme.arm(arm), series[arm][0], series[arm][1], arm == "komodo")
                for arm in viv.ARMS
            ],
            title="AGENTS.md — what each arm tells its successor",
            subtitle="lines across every AGENTS.md in the checkout",
            y_fmt=lambda value: f"{value:,.0f}",
            end_fmt=lambda value: f"{value:,.0f}",
            x_max=ds.max_pr,
        )

    return viz.Chart(
        slug="agents-md-growth",
        title="AGENTS.md — what each arm tells its successor",
        subtitle="lines across every AGENTS.md in the checkout",
        note=(
            "The file the next Codex session reads as instructions, so its size is the running cost every later "
            "session pays in context, and its growth is the arm writing down what it learned. `CLAUDE.md` points "
            "at it and is not counted separately. The CSV also carries the count of pull requests that touched the "
            "file, which separates steady accretion from a few large rewrites."
        ),
        columns=["pr", "arm", "agents_md_lines"],
        rows=[
            [s.pr, arm, _agents_lines(s)]
            for arm in viv.ARMS
            for s in ds.repos[arm].snapshots
        ],
        render=render,
        data={arm: {"pr": series[arm][0], "agents_md_lines": series[arm][1]} for arm in viv.ARMS},
    )


CHARTS = [markdown_growth_chart, agents_md_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
