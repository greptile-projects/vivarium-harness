# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7", "pypdf==6.1.3"]
# ///
"""Build everything into one timestamped run directory.

    uv run analysis/make_report.py

Writes ``analysis/out/<UTC timestamp>/`` containing:

    report.pdf          the report — plain white pages with light-theme charts
    charts/*.svg|.png   each figure on its own, both themes, both formats
    data/*.csv          the numbers behind each figure
    data/pull-requests.csv   one row per pull request, both arms joined
    data/findings.csv        one row per finding
    manifest.json       what was read, at which commits, with which options

The directory is never overwritten and never cleaned up automatically, so an
older figure and the run that produced it stay together. ``out/latest`` points at
the most recent run.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

import chart_codebase
import chart_docs
import chart_findings
import chart_process
import chart_review
import chart_scores
import make_pdf
import vivarium as viv
import viz

MODULES = [
    chart_scores,
    chart_review,
    chart_findings,
    chart_codebase,
    chart_docs,
    chart_process,
]


def write_pull_request_csv(ds: viv.Dataset, path: Path) -> None:
    """One row per pull request, both arms joined — the raw table everything else
    is aggregated from."""
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "pr", "subticket", "milestone", "title", "run_status",
                "tuatara_first_score", "tuatara_final_score",
                "tuatara_final_recorded_round", "tuatara_final_settled_at",
                "tuatara_review_rounds",
                "tuatara_first_findings", "tuatara_all_findings", "tuatara_review_timed_out",
                "komodo_score", "komodo_findings",
                "tuatara_additions", "tuatara_deletions", "tuatara_changed_files",
                "komodo_additions", "komodo_deletions", "komodo_changed_files",
                "tuatara_attempts", "komodo_attempts",
                "tuatara_build_ms", "komodo_build_ms",
                "tuatara_land_ms", "komodo_land_ms",
            ]
        )
        for row in ds.rows:
            tuatara, komodo = row.arms["tuatara"], row.arms["komodo"]
            writer.writerow(
                [
                    row.pr, row.subticket, row.milestone, row.title, row.run_status,
                    row.t_first, row.t_final,
                    row.t_final_recorded, row.t_final_current_at,
                    row.t_rounds,
                    len(row.t_first_findings), len(row.t_all_findings), int(row.t_timed_out),
                    row.k_score, len(row.k_findings),
                    tuatara.additions, tuatara.deletions, tuatara.changed_files,
                    komodo.additions, komodo.deletions, komodo.changed_files,
                    tuatara.attempts, komodo.attempts,
                    tuatara.build_ms, komodo.build_ms,
                    tuatara.land_ms, komodo.land_ms,
                ]
            )


def write_findings_csv(ds: viv.Dataset, path: Path) -> None:
    """Every finding, one row each — the raw list behind the findings rate."""
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["pr", "arm", "scope", "severity", "title"])
        for row in ds.rows:
            for finding in row.t_first_findings:
                writer.writerow([row.pr, "tuatara", "first-review", finding.severity, finding.title])
            for finding in row.t_all_findings:
                writer.writerow([row.pr, "tuatara", "all-rounds", finding.severity, finding.title])
            for finding in row.k_findings:
                writer.writerow([row.pr, "komodo", "mirror-review", finding.severity, finding.title])


def open_file(path: Path, log) -> None:
    """Open the finished report with whatever the platform uses for PDFs."""
    opener = {"darwin": ["open"], "win32": ["cmd", "/c", "start", ""]}.get(sys.platform, ["xdg-open"])
    try:
        subprocess.run([*opener, str(path)], check=False, capture_output=True)
    except OSError as error:
        # Not a failed run: the path is already printed, and a headless machine
        # has nothing to open it with.
        log(f"(could not open {path.name}: {error})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    viv.add_dataset_args(parser)
    # Default: open the report when a human is watching, stay quiet when
    # something else is (a cron job, a pipe, CI).
    parser.add_argument(
        "--open",
        dest="open_report",
        action="store_true",
        default=None,
        help="open report.pdf when it is done (default: on when stdout is a terminal)",
    )
    parser.add_argument("--no-open", dest="open_report", action="store_false", help="never open the report")
    args = parser.parse_args()
    log = (lambda _: None) if args.quiet else print

    dataset = viv.dataset_from_args(args)
    out_dir = viv.run_directory(args)

    log("rendering figures")
    charts: dict[str, viz.Chart] = {}
    for module in MODULES:
        for build in module.CHARTS:
            chart = build(dataset)
            if chart is None:
                continue
            charts[chart.slug] = chart
            viz.save_chart(chart, out_dir)
            log(f"  {chart.slug}")

    write_pull_request_csv(dataset, out_dir / "data" / "pull-requests.csv")
    write_findings_csv(dataset, out_dir / "data" / "findings.csv")
    (out_dir / "data" / "blocks.json").write_text(
        json.dumps([asdict(block) for block in dataset.blocks], indent=2)
    )
    (out_dir / "manifest.json").write_text(
        json.dumps(
            {
                **dataset.provenance,
                "charts": sorted(charts),
                "caveats": dataset.caveats,
                "pull_requests": len(dataset.rows),
            },
            indent=2,
        )
    )

    log("building report.pdf")
    report = make_pdf.build_pdf(dataset, out_dir / "report.pdf", charts=charts, log=lambda _: None)

    # `latest` is a convenience for humans and scripts; the timestamped
    # directory is the record, and is never touched again.
    if not args.out:
        latest = viv.OUT_DIR / "latest"
        if latest.is_symlink() or latest.exists():
            latest.unlink() if latest.is_symlink() else shutil.rmtree(latest)
        latest.symlink_to(out_dir.name)

    log("")
    print(report)
    if args.open_report if args.open_report is not None else sys.stdout.isatty():
        open_file(report, log)


if __name__ == "__main__":
    main()
