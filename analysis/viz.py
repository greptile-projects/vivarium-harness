"""Chart styling and drawing helpers — the one place the figures' look lives.

Two rules hold across every figure. **Colour follows the entity**: Tuatara is
blue and Komodo is orange in every chart, so a reader who learns the pair once
never re-reads a legend. And **a measurement state is not an entity**: "Tuatara's
first review" is the same arm at an earlier moment, so it takes a third hue only
where it appears beside both others, and is always direct-labelled as well as
legended.

The three-hue set was validated with the data-viz palette validator in both modes
on the all-pairs list (worst colour-vision-deficient ΔE 9.2 light / 9.4 dark;
worst normal-vision ΔE 24.0 light / 20.9 dark). Aqua sits below 3:1 on the light
surface, so every chart that uses it carries direct labels and a CSV table — the
documented relief. Do not re-pick these by eye.

Every chart renders twice, light and dark, from the same code. The HTML report
picks by ``prefers-color-scheme``; the files are usable on their own either way.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.figure import Figure
from matplotlib.lines import Line2D
from matplotlib.patches import PathPatch
from matplotlib.path import Path as MplPath

MODES = ("light", "dark")


@dataclass(frozen=True)
class Theme:
    mode: str
    surface: str
    ink: str
    ink2: str
    muted: str
    grid: str
    axis: str
    tuatara: str
    komodo: str
    tuatara_first: str

    def arm(self, name: str) -> str:
        return {"tuatara": self.tuatara, "komodo": self.komodo}[name]


THEMES = {
    "light": Theme(
        mode="light",
        surface="#fcfcfb",
        ink="#0b0b0b",
        ink2="#52514e",
        muted="#898781",
        grid="#e1e0d9",
        axis="#c3c2b7",
        tuatara="#2a78d6",
        komodo="#eb6834",
        tuatara_first="#1baf7a",
    ),
    "dark": Theme(
        mode="dark",
        surface="#1a1a19",
        ink="#ffffff",
        ink2="#c3c2b7",
        muted="#898781",
        grid="#2c2c2a",
        axis="#383835",
        tuatara="#3987e5",
        komodo="#d95926",
        tuatara_first="#199e70",
    ),
}

FONT_STACK = ["system-ui", "-apple-system", "Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"]

# Mark specs, fixed across every figure.
LINE_WIDTH = 2.0
MARKER_SIZE = 7.0          # points; ≥8px at the report's render size
MARKER_RING = 2.0          # surface-coloured ring so markers stay legible when they cross
BAR_MAX_FRACTION = 0.62    # of the category slot — the leftover is air, never filled
BAR_MAX_INCHES = 0.28      # ≈24px at the report's render size; bars never grow past it
BAR_GAP = 0.04             # surface gap between adjacent bars, in slot fractions
AREA_ALPHA = 0.10          # area fills are a wash, never a saturated block


@dataclass
class Chart:
    """A figure plus the numbers behind it.

    The table is not decoration. Several charts use a hue below 3:1 on the light
    surface, and the documented relief is exactly this: the values are also
    readable as text. It is also what makes a figure checkable — every number on
    screen lands in ``data/<slug>.csv`` in the same run.
    """

    slug: str
    title: str
    subtitle: str
    note: str
    columns: list[str]
    rows: list[list]
    render: Callable[[Theme], Figure]
    data: dict = field(default_factory=dict)

    def csv_text(self) -> str:
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(self.columns)
        for row in self.rows:
            writer.writerow(["" if cell is None else cell for cell in row])
        return buffer.getvalue()


# --------------------------------------------------------------------------
# canvas
# --------------------------------------------------------------------------


def new_canvas(
    theme: Theme,
    *,
    width: float = 10.0,
    height: float = 6.2,
    title: str = "",
    subtitle: str = "",
    rows: int = 1,
    height_ratios: Sequence[float] | None = None,
    row_gap: float = 0.55,
    left: float = 0.9,
    right: float = 1.9,
    bottom: float = 0.85,
    legend_space: float = 0.0,
    title_x: float = 0.9,
) -> tuple[Figure, list[plt.Axes]]:
    """A figure with the report's header band and one or more stacked axes.

    Padding is given in inches and converted to figure fractions, so a chart's
    geometry does not shift when its size changes — the same run twice produces
    the same picture.
    """
    plt.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": FONT_STACK,
            "svg.fonttype": "none",
            "figure.facecolor": theme.surface,
            "axes.facecolor": theme.surface,
            "savefig.facecolor": theme.surface,
            "text.color": theme.ink,
            "axes.edgecolor": theme.axis,
            "axes.labelcolor": theme.ink2,
            "xtick.color": theme.muted,
            "ytick.color": theme.muted,
            "path.simplify": False,
            # Fixed salt: clip-path ids in the SVG are derived from it, so two
            # runs of the same data emit the same markup.
            "svg.hashsalt": "vivarium",
        }
    )
    fig = plt.figure(figsize=(width, height))

    # The header is anchored to the page margin, never to the axes: a chart with
    # a wide category gutter must not have its title slide into the middle.
    header = 0.35
    if title:
        fig.text(title_x / width, 1 - 0.34 / height, title, fontsize=17, fontweight="bold", color=theme.ink, va="baseline")
        header = 0.62
    if subtitle:
        fig.text(title_x / width, 1 - 0.60 / height, subtitle, fontsize=11.5, color=theme.ink2, va="baseline")
        header = 0.88
    header += legend_space

    top_fraction = 1 - header / height
    bottom_fraction = bottom / height
    gs = fig.add_gridspec(
        rows,
        1,
        left=left / width,
        right=1 - right / width,
        top=top_fraction,
        bottom=bottom_fraction,
        hspace=row_gap * rows / max(1e-6, (top_fraction - bottom_fraction) * height),
        height_ratios=list(height_ratios) if height_ratios else None,
    )
    axes = [fig.add_subplot(gs[index, 0]) for index in range(rows)]
    for ax in axes:
        ax.set_facecolor(theme.surface)
    return fig, axes


def style_axes(
    ax: plt.Axes,
    theme: Theme,
    *,
    y_grid: bool = True,
    x_grid: bool = False,
    baseline: bool = True,
    left_spine: bool = False,
) -> None:
    """Hairline solid gridlines, recessive axes, no chartjunk."""
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_visible(left_spine)
    ax.spines["left"].set_color(theme.axis)
    ax.spines["bottom"].set_visible(baseline)
    ax.spines["bottom"].set_color(theme.axis)
    ax.spines["bottom"].set_linewidth(1.0)
    ax.tick_params(axis="both", length=0, labelsize=10.5, colors=theme.muted, pad=7)
    ax.set_axisbelow(True)
    if y_grid:
        ax.grid(axis="y", color=theme.grid, linewidth=1.0, linestyle="-")
    if x_grid:
        ax.grid(axis="x", color=theme.grid, linewidth=1.0, linestyle="-")


# --------------------------------------------------------------------------
# marks
# --------------------------------------------------------------------------


def line(
    ax: plt.Axes,
    x: Sequence[float],
    y: Sequence[float | None],
    color: str,
    theme: Theme,
    *,
    dashed: bool = False,
    markers: bool = True,
    label: str | None = None,
    zorder: float = 3,
) -> None:
    """A 2px line with ≥8px markers ringed in the surface colour.

    ``None`` values break the line rather than being interpolated over — a block
    with no scored pull request is a hole in the data, not a straight segment.
    """
    xs = list(x)
    ys = [float("nan") if value is None else float(value) for value in y]
    ax.plot(
        xs,
        ys,
        color=color,
        linewidth=LINE_WIDTH,
        linestyle=(0, (5, 3)) if dashed else "-",
        solid_capstyle="round",
        solid_joinstyle="round",
        dash_capstyle="round",
        label=label,
        zorder=zorder,
    )
    if markers:
        ax.plot(
            xs,
            ys,
            linestyle="none",
            marker="o",
            markersize=MARKER_SIZE,
            markerfacecolor=color,
            markeredgecolor=theme.surface,
            markeredgewidth=MARKER_RING,
            zorder=zorder + 0.1,
        )


def area_between(
    ax: plt.Axes,
    x: Sequence[float],
    upper: Sequence[float | None],
    lower: Sequence[float | None],
    color: str,
) -> None:
    xs, us, ls = [], [], []
    for index, value in enumerate(x):
        if upper[index] is None or lower[index] is None:
            continue
        xs.append(value)
        us.append(float(upper[index]))
        ls.append(float(lower[index]))
    if len(xs) > 1:
        ax.fill_between(xs, us, ls, color=color, alpha=AREA_ALPHA, linewidth=0, zorder=1)


def _rounded_bar_path(x: float, y: float, width: float, height: float, radius: float, horizontal: bool) -> MplPath:
    """A bar rounded at its data-end and square at the baseline."""
    if horizontal:
        r = max(0.0, min(radius, abs(width), abs(height) / 2))
        sign = 1 if width >= 0 else -1
        tip = x + width
        vertices = [
            (x, y),
            (tip - sign * r, y),
            (tip, y),
            (tip, y + r),
            (tip, y + height - r),
            (tip, y + height),
            (tip - sign * r, y + height),
            (x, y + height),
            (x, y),
        ]
        codes = [
            MplPath.MOVETO, MplPath.LINETO, MplPath.CURVE3, MplPath.CURVE3,
            MplPath.LINETO, MplPath.CURVE3, MplPath.CURVE3, MplPath.LINETO, MplPath.CLOSEPOLY,
        ]
    else:
        r = max(0.0, min(radius, abs(height), abs(width) / 2))
        sign = 1 if height >= 0 else -1
        tip = y + height
        vertices = [
            (x, y),
            (x, tip - sign * r),
            (x, tip),
            (x + r, tip),
            (x + width - r, tip),
            (x + width, tip),
            (x + width, tip - sign * r),
            (x + width, y),
            (x, y),
        ]
        codes = [
            MplPath.MOVETO, MplPath.LINETO, MplPath.CURVE3, MplPath.CURVE3,
            MplPath.LINETO, MplPath.CURVE3, MplPath.CURVE3, MplPath.LINETO, MplPath.CLOSEPOLY,
        ]
    return MplPath(vertices, codes)


def bars(
    ax: plt.Axes,
    centres: Sequence[float],
    values: Sequence[float | None],
    color: str,
    *,
    width: float,
    offset: float = 0.0,
    horizontal: bool = False,
    radius_fraction: float = 0.22,
    zorder: float = 3,
) -> None:
    """Grouped bars, ≤``width`` thick, rounded at the data-end.

    Adjacent bars are separated by leaving a gap in the surface, never by drawing
    a stroke around a mark.
    """
    for centre, value in zip(centres, values):
        if value is None:
            continue
        radius = radius_fraction * width
        if horizontal:
            path = _rounded_bar_path(0.0, centre + offset - width / 2, float(value), width, radius, True)
        else:
            path = _rounded_bar_path(centre + offset - width / 2, 0.0, width, float(value), radius, False)
        ax.add_patch(PathPatch(path, facecolor=color, edgecolor="none", zorder=zorder))


def category_ticks(ax: plt.Axes, labels: Sequence[str], *, min_gap_points: float = 8.0) -> None:
    """One tick per category, with labels thinned until none collide.

    Thirteen block-range labels no longer fit this page width side by side, and a
    label that touches its neighbour reads as one string of digits. Measured on
    the rendered text rather than estimated: the smallest stride at which every
    kept pair clears ``min_gap_points`` wins, and the dropped labels leave their
    ticks in place so the kept ones stay under their own blocks. Thinning, not
    rotation or a smaller font: the axis stays horizontal and legible, and every
    block's label is still in the chart's CSV.
    """
    x = list(range(len(labels)))
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    fig = ax.figure
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    widths = [text.get_window_extent(renderer).width for text in ax.get_xticklabels()]
    centres = [ax.transData.transform((value, 0))[0] for value in x]
    gap = min_gap_points * fig.dpi / 72
    stride = 1
    while stride < len(labels):
        kept = list(range(0, len(labels), stride))
        if all(
            (centres[b] - widths[b] / 2) - (centres[a] + widths[a] / 2) >= gap
            for a, b in zip(kept, kept[1:])
        ):
            break
        stride += 1
    ax.set_xticklabels([label if index % stride == 0 else "" for index, label in enumerate(labels)])


def end_labels(
    ax: plt.Axes,
    theme: Theme,
    entries: Sequence[tuple[float, str, str]],
    *,
    x: float,
    min_gap_points: float = 15.0,
) -> None:
    """Direct labels at the right edge, nudged apart only enough not to collide.

    Direct labels work because they are sparing: only the series endpoints get
    one. Everything else is carried by the axis, the legend and the CSV.
    """
    ordered = sorted(entries, key=lambda entry: -entry[0])
    span = ax.get_ylim()[1] - ax.get_ylim()[0]
    height_points = ax.get_window_extent().height * 72 / ax.figure.dpi
    min_gap = min_gap_points * span / max(1.0, height_points)
    previous = None
    for y, value, label in ordered:
        placed = y if previous is None else min(y, previous - min_gap)
        ax.annotate(
            value,
            xy=(x, placed),
            xycoords=("axes fraction", "data"),
            xytext=(8, 0),
            textcoords="offset points",
            va="center",
            ha="left",
            fontsize=12,
            fontweight="bold",
            color=theme.ink,
            annotation_clip=False,
        )
        ax.annotate(
            label,
            xy=(x, placed),
            xycoords=("axes fraction", "data"),
            xytext=(8 + 11 * len(value), 0),
            textcoords="offset points",
            va="center",
            ha="left",
            fontsize=11,
            color=theme.ink2,
            annotation_clip=False,
        )
        previous = placed


def legend(
    fig: Figure,
    theme: Theme,
    entries: Sequence[tuple[str, str, bool]],
    *,
    x_inches: float = 0.9,
    y_from_top_inches: float = 1.02,
) -> None:
    """A legend is always present for two or more series; one series gets none —
    the title already names what is plotted."""
    handles = [
        Line2D(
            [],
            [],
            color=color,
            linewidth=LINE_WIDTH,
            linestyle=(0, (5, 3)) if dashed else "-",
            marker="o",
            markersize=MARKER_SIZE,
            markerfacecolor=color,
            markeredgecolor=theme.surface,
            markeredgewidth=MARKER_RING,
            label=label,
        )
        for label, color, dashed in entries
    ]
    width, height = fig.get_size_inches()
    fig.legend(
        handles=handles,
        loc="upper left",
        bbox_to_anchor=(x_inches / width, 1 - y_from_top_inches / height),
        frameon=False,
        ncol=len(handles),
        handlelength=2.2,
        handletextpad=0.6,
        columnspacing=2.0,
        fontsize=11.5,
        labelcolor=theme.ink2,
    )


def value_labels(
    ax: plt.Axes,
    theme: Theme,
    centres: Sequence[float],
    values: Sequence[float | None],
    fmt: Callable[[float], str],
    *,
    offset: float = 0.0,
    pad_points: float = 6.0,
) -> None:
    for centre, value in zip(centres, values):
        if value is None:
            continue
        ax.annotate(
            fmt(float(value)),
            xy=(centre + offset, value),
            xytext=(0, pad_points),
            textcoords="offset points",
            ha="center",
            va="bottom",
            fontsize=11,
            fontweight="bold",
            color=theme.ink,
        )


def bar_tip_labels(
    ax: plt.Axes,
    theme: Theme,
    centres: Sequence[float],
    values: Sequence[float | None],
    fmt: Callable[[float], str],
    *,
    offset: float = 0.0,
) -> None:
    """Values at the tip of a horizontal bar, outside the mark.

    Never inside: a label that does not fit would be clipped by its own bar, and
    a clipped label is worse than no label.
    """
    for centre, value in zip(centres, values):
        if value is None:
            continue
        ax.annotate(
            fmt(float(value)),
            xy=(value, centre + offset),
            xytext=(6, 0),
            textcoords="offset points",
            ha="left",
            va="center",
            fontsize=10.5,
            color=theme.ink2,
        )


def footnote(fig: Figure, theme: Theme, text: str, *, x_inches: float = 0.9) -> None:
    width, _ = fig.get_size_inches()
    fig.text(x_inches / width, 0.012, text, fontsize=9.5, color=theme.muted, va="bottom")


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------


def save_chart(chart: Chart, out_dir: Path, *, dpi: int = 200) -> dict[str, str]:
    """Write both modes, as SVG and PNG, plus the chart's own CSV."""
    charts_dir = out_dir / "charts"
    data_dir = out_dir / "data"
    charts_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    written: dict[str, str] = {}
    for mode in MODES:
        theme = THEMES[mode]
        fig = chart.render(theme)
        for extension in ("svg", "png"):
            name = f"{chart.slug}-{mode}.{extension}"
            # `Date: None` drops the timestamp matplotlib would otherwise stamp
            # into the SVG's metadata — the one thing that would make two runs of
            # the same data produce different bytes.
            fig.savefig(
                charts_dir / name,
                format=extension,
                dpi=dpi,
                facecolor=theme.surface,
                metadata={"Date": None} if extension == "svg" else None,
            )
            written[f"{mode}_{extension}"] = f"charts/{name}"
        plt.close(fig)

    (data_dir / f"{chart.slug}.csv").write_text(chart.csv_text())
    written["csv"] = f"data/{chart.slug}.csv"
    return written


def standalone_main(description: str, builders: Sequence[Callable[[object], Chart | None]]) -> None:
    """Let any ``chart_*.py`` run on its own: build the dataset, draw its own
    charts into a run directory, print what it wrote."""
    import argparse

    import vivarium

    parser = argparse.ArgumentParser(description=description)
    vivarium.add_dataset_args(parser)
    args = parser.parse_args()

    dataset = vivarium.dataset_from_args(args)
    out_dir = vivarium.run_directory(args)
    for build in builders:
        chart = build(dataset)
        if chart is None:
            continue
        written = save_chart(chart, out_dir)
        print(f"  {chart.slug:<24} {written['light_svg']}")
    print(out_dir)


def line_over_prs(
    theme: Theme,
    series: Sequence[tuple[str, str, Sequence[float], Sequence[float | None], bool]],
    *,
    title: str,
    subtitle: str,
    y_fmt: Callable[[float], str],
    end_fmt: Callable[[float], str],
    x_max: int,
    y_from_zero: bool = True,
    height: float = 5.6,
) -> Figure:
    """The report's recurring form: one value per pull request, both arms.

    Markers are off — 220 points would be a solid band of dots — so identity comes
    from the legend and the direct end-labels, which is why both are always drawn.
    """
    fig, (ax,) = new_canvas(
        theme,
        width=10.0,
        height=height,
        title=title,
        subtitle=subtitle,
        right=1.85,
        legend_space=0.42,
    )
    legend(fig, theme, [(label, color, dashed) for label, color, _, _, dashed in series], y_from_top_inches=1.05)
    style_axes(ax, theme)
    for _, color, xs, ys, dashed in series:
        line(ax, xs, ys, color, theme, dashed=dashed, markers=False)
    ax.set_xlim(1, x_max)
    if y_from_zero:
        ax.set_ylim(bottom=0)
    ax.yaxis.set_major_formatter(lambda value, _: y_fmt(value))
    ax.set_xlabel("Pull request", fontsize=11, color=theme.ink2, labelpad=10)

    ends = []
    for label, _, _, ys, _ in series:
        last = next((value for value in reversed(list(ys)) if value is not None), None)
        if last is not None:
            ends.append((float(last), end_fmt(float(last)), label))
    end_labels(ax, theme, ends, x=1.0)
    return fig


def line_over_blocks(
    theme: Theme,
    series: Sequence[tuple[str, str, Sequence[float | None], bool]],
    labels: Sequence[str],
    *,
    title: str,
    subtitle: str,
    y_fmt: Callable[[float], str],
    end_fmt: Callable[[float], str],
    x_title: str = "Pull request block",
    height: float = 5.6,
) -> Figure:
    """One value per PR block, both arms — markers on, because there are few points."""
    fig, (ax,) = new_canvas(
        theme,
        width=10.0,
        height=height,
        title=title,
        subtitle=subtitle,
        right=1.95,
        legend_space=0.42,
    )
    legend(fig, theme, [(label, color, dashed) for label, color, _, dashed in series], y_from_top_inches=1.05)
    style_axes(ax, theme)
    x = list(range(len(labels)))
    for _, color, values, dashed in series:
        line(ax, x, values, color, theme, dashed=dashed)
    ax.set_ylim(bottom=0)
    ax.set_xlim(-0.35, len(labels) - 0.65)
    category_ticks(ax, labels)
    ax.yaxis.set_major_formatter(lambda value, _: y_fmt(value))
    ax.set_xlabel(x_title, fontsize=11, color=theme.ink2, labelpad=10)

    ends = []
    for label, _, values, _ in series:
        last = next((value for value in reversed(list(values)) if value is not None), None)
        if last is not None:
            ends.append((float(last), end_fmt(float(last)), label))
    end_labels(ax, theme, ends, x=1.0)
    return fig


def grouped_columns(
    theme: Theme,
    series: Sequence[tuple[str, str, Sequence[float | None]]],
    labels: Sequence[str],
    *,
    title: str,
    subtitle: str,
    y_fmt: Callable[[float], str],
    x_title: str = "",
    height: float = 5.4,
    value_fmt: Callable[[float], str] | None = None,
    plot_inches: float | None = None,
) -> Figure:
    """Grouped columns with a surface gap between neighbours and air in every slot.

    ``plot_inches`` narrows the plotting area. A chart with three categories
    should not stretch its axes across the full page: the bar cap is fixed, so
    the only thing widening the axes adds is empty slot.
    """
    left = 0.9
    axes_inches = plot_inches if plot_inches is not None else 10.0 - left - 0.9
    fig, (ax,) = new_canvas(
        theme,
        width=10.0,
        height=height,
        title=title,
        subtitle=subtitle,
        left=left,
        right=10.0 - left - axes_inches,
        legend_space=0.42 if len(series) > 1 else 0.0,
    )
    if len(series) > 1:
        legend(fig, theme, [(label, color, False) for label, color, _ in series], y_from_top_inches=1.05)
    style_axes(ax, theme)

    x = list(range(len(labels)))
    # Cap the bar thickness in inches, not in slot fractions. A three-category
    # chart with one series would otherwise draw bars two inches wide — the slot
    # is a layout unit, and filling it is what makes a chart read as loud.
    per_slot_inches = axes_inches / max(1, len(labels))
    group = min(BAR_MAX_FRACTION, (BAR_MAX_INCHES * len(series)) / per_slot_inches)
    width = (group - BAR_GAP * (len(series) - 1)) / len(series)
    for index, (_, color, values) in enumerate(series):
        offset = -group / 2 + width / 2 + index * (width + BAR_GAP)
        bars(ax, x, values, color, width=width, offset=offset)
        if value_fmt is not None:
            value_labels(ax, theme, x, values, value_fmt, offset=offset)

    highest = max((value for _, _, values in series for value in values if value is not None), default=1.0)
    ax.set_ylim(0, highest * (1.18 if value_fmt else 1.06))
    ax.set_xlim(-0.6, len(labels) - 0.4)
    category_ticks(ax, labels)
    ax.yaxis.set_major_formatter(lambda value, _: y_fmt(value))
    if x_title:
        ax.set_xlabel(x_title, fontsize=11, color=theme.ink2, labelpad=10)
    return fig
