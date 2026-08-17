# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""What the ladder asked for, over the climb.

Every other figure in the report measures what the arms *did*. This one measures
what they were *told to do* — the size of each subticket's Deliverable, the
section that says what must exist once the subticket is finished.

It belongs in the report because it is the experiment's independent variable
moving. Both arms receive the identical ticket, so a ticket that grew over the
climb changes what "a pull request" means at PR 200 versus PR 20, and that has to
be visible before any per-PR trend elsewhere is read as the arms changing.
"""

from __future__ import annotations

import math

import vivarium as viv
import viz

# How far past the last pull request to draw the curve. Enough to show where the
# fit says it is heading, not so far that it invites reading the extrapolation as
# data — the region is shaded and labelled either way.
LOOKAHEAD = 100


def deliverable_length_chart(ds: viv.Dataset) -> viz.Chart | None:
    rows = [row for row in ds.rows if row.deliverable_words]
    if len(rows) < 10:
        return None

    xs = [float(row.pr) for row in rows]
    ys = [float(row.deliverable_words) for row in rows]
    fit = viv.saturating_fit(xs, ys)
    blocks = ds.blocks
    averages = [
        (
            sum(r.deliverable_words for r in rows if b.start <= r.pr <= b.end)
            / sum(1 for r in rows if b.start <= r.pr <= b.end)
            if any(b.start <= r.pr <= b.end for r in rows)
            else None
        )
        for b in blocks
    ]
    limit = ds.max_pr + LOOKAHEAD

    def render(theme: viz.Theme):
        fig, (ax,) = viz.new_canvas(
            theme,
            width=10.0,
            height=5.8,
            title="Ladder deliverables rise toward a ceiling",
            subtitle=f"words in each subticket's Deliverable section, {len(rows)} subtickets",
            right=1.75,
            legend_space=0.42,
        )
        viz.legend(
            fig,
            theme,
            [
                ("Each subticket", theme.muted, False),
                (f"{ds.block_size}-PR average", theme.komodo, False),
                ("BLOF", theme.tuatara, False),
            ],
            y_from_top_inches=1.05,
        )
        viz.style_axes(ax, theme)

        # The unobserved region is shaded and named, so the curve leaving the
        # data cannot be mistaken for more data.
        ax.axvspan(ds.max_pr, limit, color=theme.muted, alpha=0.07, zorder=0)
        ax.annotate("no data yet", xy=((ds.max_pr + limit) / 2, 4), ha="center",
                    fontsize=10, color=theme.muted)

        # Individual subtickets are the raw material, not a series: muted and
        # translucent so the average and the fit read on top of them.
        ax.plot(xs, ys, linestyle="none", marker="o", markersize=4.2,
                markerfacecolor=theme.muted, markeredgecolor="none", alpha=0.30, zorder=2)

        if fit:
            a, b, c = fit["a"], fit["b"], fit["c"]
            curve = [1 + i * (limit - 1) / 600 for i in range(601)]
            ax.plot(curve, [a - b * math.exp(-c * x) for x in curve],
                    color=theme.tuatara, linewidth=2.4, zorder=7)
            ax.axhline(a, color=theme.tuatara, linewidth=1, linestyle=(0, (3, 3)),
                       alpha=0.55, zorder=3)
            ax.annotate(f"ceiling {a:.0f}", xy=(6, a), xytext=(0, 6),
                        textcoords="offset points", fontsize=10, color=theme.tuatara)
            ax.annotate(f"BLOF   R² = {fit['r_squared']:.2f}",
                        xy=(limit, a - b * math.exp(-c * limit)), xytext=(8, 0),
                        textcoords="offset points", fontsize=11, fontweight="bold",
                        color=theme.tuatara, va="center", annotation_clip=False)

        viz.line(ax, [(b.start + b.end) / 2 for b in blocks], averages,
                 theme.komodo, theme, markers=True, zorder=5)
        ax.set_xlim(1, limit)
        ax.set_ylim(0, max(ys) * 1.12)
        ax.set_xlabel("Pull request", fontsize=11, color=theme.ink2, labelpad=10)
        return fig

    note = (
        "Words in the `## Deliverable` section of each subticket's ticket.md — the part naming what must exist "
        "when the subticket is done. Both arms get the identical ticket, so this is an input, not an outcome. "
    )
    if fit:
        note += (
            f"The fit is y = a − b·e^(−c·PR), chosen over a polynomial because it can express a ceiling: a "
            f"quadratic scores marginally higher but turns over and predicts negative words shortly past the "
            f"data, and a log rises without bound. It puts the ceiling at {fit['a']:.0f} words, half of it "
            f"reached by PR {fit['halfway_at']:.0f} and 90% by PR {fit['ninety_pct_at']:.0f}. "
            "Coefficients are in the CSV."
        )
    return viz.Chart(
        slug="ladder-deliverable-length",
        title="Ladder deliverables rise toward a ceiling",
        subtitle="words in each subticket's Deliverable section",
        note=note,
        columns=["pr", "subticket", "deliverable_words", "whole_ticket_words", "fit_param", "fit_value"],
        rows=[
            [row.pr, row.subticket, row.deliverable_words, row.ticket_words, "", ""]
            for row in rows
        ]
        + [
            ["", "", "", "", key, round(value, 6)]
            for key, value in (fit or {}).items()
        ],
        render=render,
        data={"fit": fit, "blocks": [b.label for b in blocks], "averages": averages},
    )


CHARTS = [deliverable_length_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
