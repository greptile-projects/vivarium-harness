# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7", "pypdf==6.1.3", "pillow==11.3.0"]
# ///
"""The report: a plain PDF, white pages, black text, one chart per page.

    uv run analysis/make_pdf.py          # just the PDF
    uv run analysis/make_report.py       # the PDF, plus the charts and CSVs beside it

Deliberately unstyled. Every page is white, the text is black, and the only
layout rule is "chart, then its caption" — what a Markdown page looks like when
you export it, not a second design system. The PDF uses each chart's light
rendering; the report generator writes the dark renderings as standalone files.

This module also owns the document's shape — the reading order, the headline
numbers, and the caveats — so `make_report.py` stays an orchestrator.
"""

from __future__ import annotations

import argparse
import io
import textwrap
import zlib
from dataclasses import replace
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from PIL import Image
from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

import chart_codebase
import chart_docs
import chart_findings
import chart_ladder
import chart_process
import chart_review
import chart_scores
import vivarium as viv
import viz

# US Letter, landscape: the charts are wide, and on a portrait page they end up
# scaled to two thirds with a third of the page empty underneath.
PAGE = (11.0, 8.5)
MARGIN = 0.75
FOOT = 0.6                  # kept clear at the bottom of every page
BODY = 10.5
CAPTION = 9.5
LINE = 0.17                 # baseline-to-baseline for caption text, inches
WRAP = 118                  # caption characters per line at this page width
HEADING = 13
POINTS = 72.0               # PDF user-space units per inch
IMAGE_DPI = 200             # resolution of the chart bitmaps placed on the pages

MODULES = [chart_scores, chart_review, chart_findings, chart_ladder, chart_codebase, chart_docs, chart_process]

# Reading order: the result first, then what it is made of, then the codebase it
# happened in, then the process cost. A reader who stops after the first two
# figures should still have the finding.
SECTIONS = [
    ("The result", ["scores", "score-distribution", "review-rounds"]),
    ("What the reviewer found", ["findings-per-kloc"]),
    ("What the ladder asked for", ["ladder-deliverable-length"]),
    ("The codebases", ["codebase-size", "biggest-files", "code-concentration"]),
    ("What they wrote down", ["markdown-growth", "agents-md-growth"]),
    ("What it cost", ["churn", "build-time"]),
]


def headline_stats(ds: viv.Dataset) -> list[tuple[str, str, str]]:
    """Label, value, caption — the numbers worth reading before any chart."""
    final = [row.t_final for row in ds.rows if row.t_final is not None]
    first = [row.t_first for row in ds.rows if row.t_first is not None]
    komodo = [row.k_score for row in ds.rows if row.k_score is not None]

    def mean(values):
        return sum(values) / len(values) if values else float("nan")

    def clean_share(values):
        return 100 * sum(1 for v in values if v == viv.MAX_SCORE) / len(values) if values else float("nan")

    stats = [
        ("Pull requests compared", f"{len(ds.rows)}", "same ticket, same start commit, one arm reviewed"),
        ("Average confidence, merged", f"{mean(final):.2f} vs {mean(komodo):.2f}", "Tuatara final vs Komodo, 0-5 scale"),
        ("Merged at 5/5", f"{clean_share(final):.0f}% vs {clean_share(komodo):.0f}%",
         "share of merged pull requests the reviewer signed off on"),
        ("Review lift", f"+{mean(final) - mean(first):.2f}",
         "average gain from first review to merge, within a pull request"),
    ]
    if ds.has_git:
        sizes = {arm: ds.repos[arm].snapshots[-1] for arm in viv.ARMS}
        stats.append(("Codebase size", f"{sizes['tuatara'].total / 1000:.0f}k vs {sizes['komodo'].total / 1000:.0f}k",
                      f"tracked lines at pull request {ds.max_pr}, Tuatara vs Komodo"))
        stats.append(("Largest single file", f"{sizes['tuatara'].largest_code:,} vs {sizes['komodo'].largest_code:,}",
                      "lines in the biggest source file in each codebase"))
    return stats


def caveat_lines(ds: viv.Dataset) -> list[str]:
    """Everything that did not line up, as plain sentences.

    Printed rather than dropped: a reader can see the edges of what was measured
    without opening the manifest.
    """
    caveats = ds.caveats
    lines: list[str] = []
    if caveats["incomplete_runs"]:
        lines.append(
            f"{len(caveats['incomplete_runs'])} run(s) in the backup produced no pull request pair and are "
            f"excluded: {', '.join(caveats['incomplete_runs'][:5])}"
        )
    if caveats["mismatched_pairs"]:
        lines.append(
            "The two arms disagree on a pull request number, so every paired figure is suspect: "
            + ", ".join(caveats["mismatched_pairs"][:5])
        )
    if caveats["missing_mirror"]:
        lines.append(
            f"{len(caveats['missing_mirror'])} pull request(s) have no mirror record, so Komodo has no review "
            f"for them: {caveats['missing_mirror'][:10]}"
        )
    source = caveats.get("final_score_source")
    if source == "cache":
        lines.append(
            "The settled Tuatara scores could not be re-read from GitHub on this run; a previous run's answers "
            "were reused, so the final line may be stale."
        )
    elif source in ("recorded", "unavailable"):
        lines.append(
            "The settled Tuatara scores were not re-read from GitHub"
            + (" (--no-gh)" if source == "recorded" else " (gh was unavailable)")
            + "; the final line is the last review round recorded before the merge, which runs lower."
        )
    if caveats.get("prs_final_from_recorded_round"):
        lines.append(
            f"{len(caveats['prs_final_from_recorded_round'])} pull request(s) had no re-readable overview comment "
            f"and fall back to their last recorded round: {caveats['prs_final_from_recorded_round'][:10]}"
        )
    if caveats.get("prs_where_settled_differs"):
        lines.append(
            f"{len(caveats['prs_where_settled_differs'])} pull request(s) ended at a different score than the "
            "harness recorded before merging, because Greptile re-reviewed after the merge. Both numbers are in "
            "data/pull-requests.csv."
        )
    for key, text in (
        ("prs_without_first_score", "no score on the first review round"),
        ("prs_without_final_score", "no score on any review round"),
        ("prs_without_komodo_score", "no score in the Komodo mirror review"),
    ):
        if caveats[key]:
            lines.append(f"{len(caveats[key])} pull request(s) with {text}: {caveats[key][:10]} - left out of their block")
    if caveats["git_skipped"]:
        lines.append(
            "Git-derived figures were skipped"
            + (f": {caveats['git_error']}" if caveats["git_error"] else " (--no-git)")
        )
    return lines or ["Nothing to report - every pull request pair joined and scored."]


def _text_line(fig, text, *, y_inches, size=BODY, weight="normal", indent=0.0):
    """One line of black text, positioned in inches from the top of the page."""
    fig.text(
        (MARGIN + indent) / PAGE[0],
        1 - y_inches / PAGE[1],
        text,
        fontsize=size,
        fontweight=weight,
        color="black",
        va="top",
        ha="left",
    )


def _blank_page():
    # The document pages use the same font as the charts, so a caption and the
    # chart above it do not read as two different documents. fonttype 42 embeds
    # the real TrueType face, so the text in the finished PDF is selectable and
    # searchable rather than drawn as outlines.
    plt.rcParams.update(
        {"font.family": "sans-serif", "font.sans-serif": viz.FONT_STACK, "pdf.fonttype": 42}
    )
    return plt.figure(figsize=PAGE, facecolor="white")


def _to_pdf_page(figure, *, facecolor: str):
    """Render one matplotlib figure to a one-page PDF and hand back that page.

    Used for the text pages, where vector type is what you want.
    """
    buffer = io.BytesIO()
    figure.savefig(buffer, format="pdf", facecolor=facecolor)
    plt.close(figure)
    buffer.seek(0)
    return PdfReader(buffer).pages[0]


def _to_image_page(figure, *, facecolor: str):
    """Render one chart to a bitmap and wrap it as a one-page PDF.

    Charts go in as **images**, not as vector art, so each one survives in the
    finished file as a single object a reader can pull back out — right-click and
    copy, or `pdfimages`, hands you the chart as a picture. Vector art looks
    identical on screen but cannot be lifted off the page that way.

    Two details make the quality real:

    * The bitmap is placed by building the image object here rather than by
      handing it to matplotlib's PDF backend, which resamples any embedded image
      down to the page's 72-dpi user space — a chart placed that way is soft no
      matter what DPI it was rendered at.
    * It is stored **Flate**, not JPEG, so it is lossless. Charts are flat colour
      and thin lines, exactly what JPEG rings around, and Pillow's own PDF writer
      reaches for JPEG on any RGB image. The cost is file size, which is why
      IMAGE_DPI is 200 rather than 300.

    The page measures exactly pixels ÷ IMAGE_DPI inches — the size the figure was
    drawn at — so the placement maths in `chart_page` is unaffected by the DPI.
    """
    buffer = io.BytesIO()
    figure.savefig(buffer, format="png", dpi=IMAGE_DPI, facecolor=facecolor)
    plt.close(figure)
    buffer.seek(0)

    image = Image.open(buffer).convert("RGB")
    width, height = image.size
    points = (width / IMAGE_DPI * POINTS, height / IMAGE_DPI * POINTS)

    writer = PdfWriter()
    page = writer.add_blank_page(width=points[0], height=points[1])

    xobject = DecodedStreamObject()
    xobject.set_data(zlib.compress(image.tobytes(), 9))
    xobject.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Image"),
            NameObject("/Width"): NumberObject(width),
            NameObject("/Height"): NumberObject(height),
            NameObject("/ColorSpace"): NameObject("/DeviceRGB"),
            NameObject("/BitsPerComponent"): NumberObject(8),
            NameObject("/Filter"): NameObject("/FlateDecode"),
        }
    )

    contents = DecodedStreamObject()
    contents.set_data(f"q {points[0]:.4f} 0 0 {points[1]:.4f} 0 0 cm /Im0 Do Q".encode())
    page[NameObject("/Contents")] = writer._add_object(contents)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/XObject"): DictionaryObject({NameObject("/Im0"): writer._add_object(xobject)})}
    )

    page_buffer = io.BytesIO()
    writer.write(page_buffer)
    page_buffer.seek(0)
    return PdfReader(page_buffer).pages[0]


def _wrap(text: str, width: int = WRAP) -> list[str]:
    return textwrap.wrap(text, width=width) or [""]


def cover_page(ds: viv.Dataset):
    fig = _blank_page()
    cursor = 1.0
    _text_line(fig, f"Vivarium: {ds.max_pr} pull requests, one variable", y_inches=cursor, size=20, weight="bold")
    cursor += 0.55

    for line in _wrap(
        "Two Codex agents build the same ticket from the same commit at the same moment. Tuatara must "
        "answer a Greptile review before its work merges. Komodo merges straight away, and is reviewed only "
        "in a private mirror it cannot see. Every other input is held constant, so a difference between them "
        "is attributable to the review."
    ):
        _text_line(fig, line, y_inches=cursor)
        cursor += 0.22
    cursor += 0.35

    for label, value, caption in headline_stats(ds):
        _text_line(fig, f"{label}: {value}", y_inches=cursor, weight="bold")
        cursor += 0.21
        _text_line(fig, caption, y_inches=cursor, size=9.5, indent=0.15)
        cursor += 0.32

    cursor += 0.2
    provenance = ds.provenance
    arms = provenance["arms"]
    for line in [
        f"Generated {provenance['generated_at']}",
        f"State backup commit {provenance['state_backup']['commit']}",
        f"Tuatara {str(arms['tuatara']['head_sha'])[:10]} · Komodo {str(arms['komodo']['head_sha'])[:10]}",
        f"Blocks of {provenance['options']['block_size']} pull requests",
        f"Final-score source: {ds.caveats.get('final_score_source')}",
    ]:
        _text_line(fig, line, y_inches=cursor, size=9.5)
        cursor += 0.19

    return _to_pdf_page(fig, facecolor="white")


def chart_page(chart: viz.Chart):
    """One chart on one white page, as a single copyable image."""
    # On paper the page is simply white, so the light theme's near-white surface
    # is swapped for it — that also whitens the rings around the markers, which
    # would otherwise show as faint haloes on a white page.
    theme = replace(viz.THEMES["light"], surface="#ffffff")
    figure = chart.render(theme)
    chart_width, chart_height = figure.get_size_inches()
    chart_pdf = _to_image_page(figure, facecolor=theme.surface)

    page = _blank_page()
    # No page heading: every chart already carries its own title, and repeating
    # it above the chart is the kind of thing a plain export does not do.
    top = 0.9

    # Fit to whichever runs out first, the column or the page. Scaling to width
    # alone would let a tall chart with a long caption run off the bottom.
    lines = _wrap(chart.note, WRAP)
    caption_height = (0.35 + LINE * len(lines)) if lines else 0.0
    scale = min(
        (PAGE[0] - 2 * MARGIN) / chart_width,
        (PAGE[1] - top - caption_height - FOOT) / chart_height,
    )
    display_height = chart_height * scale

    cursor = top + display_height + 0.35
    for line in lines:
        _text_line(page, line, y_inches=cursor, size=CAPTION)
        cursor += LINE

    # Centred when the height is what limited the scale, so a chart that could
    # not fill the column does not sit off to one side of an empty page.
    left = (PAGE[0] - chart_width * scale) / 2
    placed = _to_pdf_page(page, facecolor="white")
    placed.merge_transformed_page(
        chart_pdf,
        Transformation()
        .scale(scale)
        .translate(left * POINTS, (PAGE[1] - top - display_height) * POINTS),
    )
    return placed


def notes_page(ds: viv.Dataset):
    fig = _blank_page()
    cursor = 0.85
    _text_line(fig, "What did not line up", y_inches=cursor, size=HEADING, weight="bold")
    cursor += 0.4

    for item in caveat_lines(ds):
        for index, line in enumerate(_wrap(item)):
            _text_line(fig, ("• " if index == 0 else "  ") + line, y_inches=cursor, size=9.5)
            cursor += 0.18
        cursor += 0.1

    cursor += 0.3
    _text_line(fig, "Method", y_inches=cursor, size=HEADING, weight="bold")
    cursor += 0.4
    for line in _wrap(
        "Every metric's definition, and what it deliberately excludes, is in analysis/METRICS.md. The numbers "
        "behind every chart in this document are in the data/ directory beside it, one CSV per chart, plus one "
        "row per pull request and one row per finding.",
    ):
        _text_line(fig, line, y_inches=cursor, size=9.5)
        cursor += 0.18

    return _to_pdf_page(fig, facecolor="white")


def build_pdf(
    ds: viv.Dataset,
    path: Path,
    charts: dict[str, viz.Chart] | None = None,
    log=print,
) -> Path:
    """Write the report. ``charts`` lets a caller that already built them pass
    them in rather than paying for a second build."""
    if charts is None:
        charts = {}
        for module in MODULES:
            for build in module.CHARTS:
                chart = build(ds)
                if chart is not None:
                    charts[chart.slug] = chart

    writer = PdfWriter()
    writer.add_page(cover_page(ds))
    for _, slugs in SECTIONS:
        for slug in slugs:
            chart = charts.get(slug)
            if chart is None:
                continue
            log(f"  {slug}")
            writer.add_page(chart_page(chart))
    writer.add_page(notes_page(ds))
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    viv.add_dataset_args(parser)
    args = parser.parse_args()
    log = (lambda _: None) if args.quiet else print

    dataset = viv.dataset_from_args(args)
    out_dir = viv.run_directory(args)
    log("building PDF")
    path = build_pdf(dataset, out_dir / "report.pdf", log=log)
    print(path)


if __name__ == "__main__":
    main()
