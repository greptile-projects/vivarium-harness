# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""Two views of the review itself, rather than of its effect.

The headline chart shows averages, which hide their own shape: an average of 4.1
is a different claim if it is "mostly 4s" than if it is "5s and 1s". The first
chart here is that shape. The second asks where inside a pull request the lift
actually arrives — whether the second and third rounds are still buying anything.
"""

from __future__ import annotations

import vivarium as viv
import viz


def score_distribution_chart(ds: viv.Dataset) -> viz.Chart:
    scores = list(range(viv.MAX_SCORE + 1))

    def share(pick):
        values = [value for value in (pick(row) for row in ds.rows) if value is not None]
        total = len(values)
        return total, [100 * values.count(score) / total if total else None for score in scores]

    first_n, first = share(lambda row: row.t_first)
    final_n, final = share(lambda row: row.t_final)
    komodo_n, komodo = share(lambda row: row.k_score)

    def render(theme: viz.Theme):
        return viz.grouped_columns(
            theme,
            [
                ("Tuatara final", theme.tuatara, final),
                ("Tuatara first review", theme.tuatara_first, first),
                ("Komodo (no review)", theme.komodo, komodo),
            ],
            [f"{score}/5" for score in scores],
            title="Where the verdicts land",
            subtitle="share of pull requests at each confidence score",
            y_fmt=lambda value: f"{value:.0f}%",
            x_title="Greptile confidence score",
        )

    return viz.Chart(
        slug="score-distribution",
        title="Where the verdicts land",
        subtitle="share of pull requests at each confidence score",
        note=(
            "Percentages are of each series' own scored population, so the three bars at one score do not sum to "
            f"100% (Tuatara first n={first_n}, Tuatara final n={final_n}, Komodo n={komodo_n}). Reading across a "
            "score rather than down a series is what this chart is for: it says how often each arm produced code "
            "the reviewer would sign off on, not just what it averaged."
        ),
        columns=["score", "tuatara_first_pct", "tuatara_final_pct", "komodo_pct"],
        rows=[
            [
                f"{score}/5",
                None if first[index] is None else round(first[index], 2),
                None if final[index] is None else round(final[index], 2),
                None if komodo[index] is None else round(komodo[index], 2),
            ]
            for index, score in enumerate(scores)
        ],
        render=render,
        data={"scores": scores, "first": first, "final": final, "komodo": komodo},
    )


def review_rounds_chart(ds: viv.Dataset) -> viz.Chart:
    max_rounds = max((row.t_rounds for row in ds.rows), default=0)
    rounds = list(range(1, max_rounds + 1))

    averages: list[float | None] = []
    counts: list[int] = []
    for index in range(max_rounds):
        values = [
            row.t_round_scores[index]
            for row in ds.rows
            if index < len(row.t_round_scores) and row.t_round_scores[index] is not None
        ]
        averages.append(sum(values) / len(values) if values else None)
        counts.append(len(values))

    def render(theme: viz.Theme):
        return viz.grouped_columns(
            theme,
            [("Tuatara", theme.tuatara, averages)],
            [f"round {number}" for number in rounds],
            title="What each review round is worth",
            subtitle="average Tuatara confidence at each round of the same pull request",
            y_fmt=lambda value: f"{value:.0f}",
            x_title="Review round",
            value_fmt=lambda value: f"{value:.2f}",
            plot_inches=3.6,
            height=4.6,
        )

    return viz.Chart(
        slug="review-rounds",
        title="What each review round is worth",
        subtitle="average Tuatara confidence at each round of the same pull request",
        note=(
            "One series, so no legend — every bar is Tuatara. The population shrinks with each round: a pull "
            "request the reviewer was satisfied with in round 1 has no round 2, so a later bar averages the harder "
            "pull requests that were still being argued, not the same set as the bar to its left. The counts are "
            "in the table, and the harness caps the exchange at three rounds."
        ),
        columns=["round", "pull_requests_scored", "average_confidence"],
        rows=[
            [number, counts[index], None if averages[index] is None else round(averages[index], 3)]
            for index, number in enumerate(rounds)
        ],
        render=render,
        data={"rounds": rounds, "averages": averages, "counts": counts},
    )


CHARTS = [score_distribution_chart, review_rounds_chart]

if __name__ == "__main__":
    viz.standalone_main(__doc__ or "", CHARTS)
