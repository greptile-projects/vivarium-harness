"""Vivarium experiment data layer — standard library only.

This module reads finished artifacts and turns them into one dataset. It imports
nothing from the harness and the harness imports nothing from it: the analysis is
a post-hoc reader that must run on a machine that has never held an arm token, so
its only inputs are directories that already exist on disk.

Two sources:

* ``<state-backup>/results/rung-NN/run/N.M/run.json`` — one record per subticket.
  Both arms build the same subticket at once and open pull requests carrying the
  *same number* in their own repositories. That number is the join key, and it is
  checked rather than assumed.
* ``<state-backup>/results/mirror/*/pr-NNNN.json`` — Komodo's counterfactual
  reviews. Komodo merges unreviewed, so nothing in its ``run.json`` holds a
  review; Greptile reviews its merged states in a private mirror the agent cannot
  see, and the snapshotter files them here.

Repository history comes from read-only ``git`` calls against each arm checkout.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Sequence

ARMS = ("tuatara", "komodo")
ARM_LABEL = {"tuatara": "Tuatara", "komodo": "Komodo"}
ARM_BLURB = {
    "tuatara": "Greptile reviews every pull request before it merges",
    "komodo": "no review — merges straight away",
}

MAX_SCORE = 5


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------

ANALYSIS_DIR = Path(__file__).resolve().parent
HARNESS_DIR = ANALYSIS_DIR.parent
OUT_DIR = ANALYSIS_DIR / "out"
CACHE_DIR = ANALYSIS_DIR / ".cache"


def _resolve(name: str, env_var: str, candidates: Sequence[Path]) -> Path:
    """Environment variable first, then a sibling of the harness checkout."""
    from_env = os.environ.get(env_var)
    if from_env:
        path = Path(from_env).expanduser().resolve()
        if not path.exists():
            raise SystemExit(f"{env_var} points at {path}, which does not exist")
        return path
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    listed = "\n".join(f"  {candidate}" for candidate in candidates)
    raise SystemExit(f"could not find {name}. Set {env_var}, or place it at one of:\n{listed}")


def state_backup_dir() -> Path:
    path = _resolve(
        "the results directory (a vivarium-state-backup checkout)",
        "VIVARIUM_STATE_BACKUP",
        [HARNESS_DIR.parent / "vivarium-state-backup", HARNESS_DIR],
    )
    if not (path / "results").is_dir():
        raise SystemExit(f"{path} has no results/ directory")
    return path


def arm_repo_dir(arm: str) -> Path:
    return _resolve(
        f"the {arm} checkout",
        f"VIVARIUM_{arm.upper()}",
        [HARNESS_DIR.parent / f"vivarium-{arm}"],
    )


# --------------------------------------------------------------------------
# reading Greptile out of a review body
# --------------------------------------------------------------------------

_CONFIDENCE = re.compile(r"Confidence Score:\s*(\d+)\s*/\s*5")

# Greptile prefixes each finding with a severity badge image and bolds its title.
_BADGE = re.compile(
    r"<img\s+alt=[\"'](P[0-3])[\"'][^>]*>[\s\S]{0,500}?\*\*([^*\n]{5,240})\*\*",
    re.IGNORECASE,
)

# Bolded headings inside a finding block that are structure, not a finding.
_NOT_A_FINDING = re.compile(
    r"^(files? needing attention|bug|cause|fix|artifacts|impact|why)$", re.IGNORECASE
)

SEVERITIES = ("P0", "P1", "P2", "P3")


def confidence_score(body: str | None) -> int | None:
    if not body:
        return None
    match = _CONFIDENCE.search(body)
    if not match:
        return None
    score = int(match.group(1))
    return score if 0 <= score <= MAX_SCORE else None


def score_of(notes: Iterable[dict]) -> int | None:
    """The score carried by a batch of review notes.

    Greptile posts exactly one pull-request overview comment, so "the first note
    with a score" and "the one there is" coincide; scanning rather than assuming a
    position survives the inline comments and reactions recorded alongside it.
    """
    for note in notes:
        score = confidence_score(note.get("body"))
        if score is not None:
            return score
    return None


def _strip_markup(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("\\_", "_")
    )
    return re.sub(r"\s+", " ", text).strip()


def finding_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _strip_markup(title).lower()).strip()


@dataclass
class Finding:
    severity: str
    title: str
    key: str


def extract_findings(notes: Iterable[dict]) -> list[Finding]:
    """Every distinct finding across a batch of review notes.

    Deduplicated by normalised title, keeping the worst severity seen: Greptile
    restates a finding in the overview and again as an inline comment with small
    wording drift, and that is one issue, not two.
    """
    by_key: dict[str, Finding] = {}
    for note in notes:
        body = note.get("body")
        if not body:
            continue
        for match in _BADGE.finditer(body):
            title = _strip_markup(match.group(2))
            if not title or _NOT_A_FINDING.match(title):
                continue
            key = finding_key(title)
            if not key:
                continue
            severity = match.group(1).upper()
            existing = by_key.get(key)
            if existing is None:
                by_key[key] = Finding(severity, title, key)
            elif SEVERITIES.index(severity) < SEVERITIES.index(existing.severity):
                existing.severity = severity
    return list(by_key.values())


# --------------------------------------------------------------------------
# the state backup
# --------------------------------------------------------------------------


@dataclass
class ArmRow:
    arm: str
    attempts: int = 0
    build_ms: int | None = None
    landing_status: str | None = None
    additions: int | None = None
    deletions: int | None = None
    changed_files: int | None = None
    merged_at: str | None = None
    land_ms: int | None = None

    @property
    def churn(self) -> int | None:
        if self.additions is None or self.deletions is None:
            return None
        return self.additions + self.deletions


@dataclass
class PullRequest:
    pr: int
    subticket: str
    milestone: int
    title: str
    run_status: str | None
    started_at: str | None
    arms: dict[str, ArmRow]

    # Tuatara, reviewed live on its own pull requests.
    t_first: int | None = None
    # The last round the harness recorded before it merged. Kept alongside the
    # re-read score because it is what the harness saw at the moment it decided
    # to land, and the two are not always the same number.
    t_final_recorded: int | None = None
    # Greptile's overview comment as it stands *now*, re-read from GitHub. It is
    # edited in place, so after a post-merge re-review this is the reviewer's
    # settled verdict on the merged state — the same thing the Komodo mirror
    # snapshot holds for the other arm.
    t_final_current: int | None = None
    t_final_current_at: str | None = None
    t_pr_url: str | None = None
    t_round_scores: list[int | None] = field(default_factory=list)
    t_rounds: int = 0
    t_timed_out: bool = False
    t_first_findings: list[Finding] = field(default_factory=list)
    t_all_findings: list[Finding] = field(default_factory=list)

    # What the ladder asked for. The ticket is the one input both arms share, so
    # its size is the experiment's independent variable rather than an outcome.
    deliverable_words: int | None = None
    ticket_words: int | None = None

    # Komodo, reviewed only in the mirror it cannot see.
    k_score: int | None = None
    k_findings: list[Finding] = field(default_factory=list)
    k_mirrored: bool = False

    @property
    def t_final(self) -> int | None:
        """The reviewer's settled verdict on what Tuatara merged.

        The re-read comment when there is one, the last recorded round otherwise.
        Greptile re-reviews after the merge and edits its overview in place, so
        the recorded round is a snapshot mid-exchange while this is where the
        exchange ended up — and it is the same measurement the Komodo mirror
        gives for the unreviewed arm.
        """
        return self.t_final_current if self.t_final_current is not None else self.t_final_recorded

    @property
    def lift(self) -> int | None:
        if self.t_first is None or self.t_final is None:
            return None
        return self.t_final - self.t_first


def _millis_between(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    try:
        a = datetime.fromisoformat(start.replace("Z", "+00:00"))
        b = datetime.fromisoformat(end.replace("Z", "+00:00"))
    except ValueError:
        return None
    delta = int((b - a).total_seconds() * 1000)
    return delta if delta >= 0 else None


def _numeric_key(name: str) -> tuple:
    """Sort ``rung-7`` before ``rung-12`` and ``7.2`` before ``7.10``."""
    return tuple(int(part) for part in re.findall(r"\d+", name)) or (0,)


def _arm_row(arm: str, raw: dict | None) -> ArmRow:
    raw = raw or {}
    landing = raw.get("landing") or {}
    pull_request = landing.get("pullRequest") or {}
    return ArmRow(
        arm=arm,
        attempts=len(raw.get("attempts") or []),
        build_ms=(raw.get("final") or {}).get("durationMs"),
        landing_status=landing.get("status"),
        additions=pull_request.get("additions"),
        deletions=pull_request.get("deletions"),
        changed_files=pull_request.get("changedFiles"),
        merged_at=(landing.get("merge") or {}).get("mergedAt"),
        land_ms=_millis_between(landing.get("startedAt"), landing.get("completedAt")),
    )


@dataclass
class StateSummary:
    rows: list[PullRequest]
    incomplete_runs: list[str]
    mismatched_pairs: list[str]
    missing_mirror: list[int]


def load_state(state_backup: Path) -> StateSummary:
    results = state_backup / "results"
    rows: list[PullRequest] = []
    incomplete: list[str] = []
    mismatched: list[str] = []

    rungs = sorted((p for p in results.glob("rung-*") if p.is_dir()), key=lambda p: _numeric_key(p.name))
    for rung in rungs:
        run_dir = rung / "run"
        if not run_dir.is_dir():
            continue
        for subticket_dir in sorted((p for p in run_dir.iterdir() if p.is_dir()), key=lambda p: _numeric_key(p.name)):
            record_path = subticket_dir / "run.json"
            if not record_path.is_file():
                continue
            try:
                raw = json.loads(record_path.read_text())
            except (OSError, json.JSONDecodeError):
                # One unreadable record loses one row, never the analysis.
                incomplete.append(f"{rung.name}/{subticket_dir.name} (unreadable)")
                continue

            arms_raw = raw.get("arms") or {}
            arms = {arm: _arm_row(arm, arms_raw.get(arm)) for arm in ARMS}
            numbers = {
                arm: ((arms_raw.get(arm) or {}).get("landing") or {}).get("pullRequest", {}).get("number")
                for arm in ARMS
            }
            if any(number is None for number in numbers.values()):
                incomplete.append(f"{rung.name}/{subticket_dir.name} ({raw.get('status', 'unknown')})")
                continue
            if numbers["tuatara"] != numbers["komodo"]:
                mismatched.append(
                    f"{rung.name}/{subticket_dir.name}: tuatara #{numbers['tuatara']} vs komodo #{numbers['komodo']}"
                )

            landing = (arms_raw.get("tuatara") or {}).get("landing") or {}
            rounds = landing.get("reviewRounds") or []
            round_scores = [score_of(r.get("found") or []) for r in rounds]
            # The last round that carried a score. A trailing round can arrive
            # with only inline comments — Greptile had nothing new to say about
            # the pull request as a whole — and treating that as "no score" would
            # throw away the verdict the previous round gave on the same code.
            scored = [s for s in round_scores if s is not None]

            # Every ticket carries the same three headings, so the Deliverable —
            # the part that says what must exist when the subticket is done — can
            # be measured on its own rather than through the surrounding prose.
            deliverable_words = ticket_words = None
            try:
                ticket = (subticket_dir / "ticket.md").read_text()
                ticket_words = len(ticket.split())
                section = re.search(r"^## Deliverable\s*(.*?)(?=^## |\Z)", ticket, re.S | re.M)
                if section:
                    deliverable_words = len(section.group(1).split())
            except OSError:
                pass

            subticket = raw.get("subticket") or {}
            rows.append(
                PullRequest(
                    pr=int(numbers["tuatara"]),
                    subticket=subticket.get("number") or subticket_dir.name,
                    milestone=int(subticket.get("milestone") or _numeric_key(rung.name)[0]),
                    title=subticket.get("title") or "",
                    run_status=raw.get("status"),
                    started_at=raw.get("startedAt"),
                    arms=arms,
                    deliverable_words=deliverable_words,
                    ticket_words=ticket_words,
                    t_first=scored[0] if scored else None,
                    t_final_recorded=scored[-1] if scored else None,
                    t_pr_url=(landing.get("pullRequest") or {}).get("url"),
                    t_round_scores=round_scores,
                    t_rounds=len(rounds),
                    t_timed_out=any(r.get("timedOut") for r in rounds),
                    t_first_findings=extract_findings((rounds[0].get("found") or []) if rounds else []),
                    t_all_findings=extract_findings(
                        [note for r in rounds for note in (r.get("found") or [])]
                    ),
                )
            )

    rows.sort(key=lambda row: row.pr)
    by_pr = {row.pr: row for row in rows}

    mirror_root = results / "mirror"
    if mirror_root.is_dir():
        for path in sorted(mirror_root.glob("*/pr-*.json")):
            try:
                raw = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            # The mirror PR number tracks the source PR number, but the provenance
            # field is the contract; fall back only when it is absent.
            pr = (raw.get("source") or {}).get("pullRequest") or (raw.get("pullRequest") or {}).get("number")
            row = by_pr.get(pr)
            if row is None:
                continue
            conversation = raw.get("conversation") or []
            row.k_mirrored = True
            row.k_score = score_of(conversation)
            row.k_findings = extract_findings(conversation)

    return StateSummary(
        rows=rows,
        incomplete_runs=incomplete,
        mismatched_pairs=mismatched,
        missing_mirror=[row.pr for row in rows if not row.k_mirrored],
    )


# --------------------------------------------------------------------------
# re-reading the settled review from GitHub
# --------------------------------------------------------------------------

_SLUG = re.compile(r"github\.com/([^/]+/[^/]+)/pull/\d+")

REVIEWER_LOGIN = "greptile-apps[bot]"


def repo_slug(pull_request_url: str | None) -> str | None:
    match = _SLUG.search(pull_request_url or "")
    return match.group(1) if match else None


@dataclass
class CurrentScore:
    score: int
    updated_at: str


def fetch_current_scores(
    slug: str,
    refresh: bool = False,
    log: Callable[[str], None] = lambda _: None,
) -> tuple[dict[int, CurrentScore], str]:
    """Greptile's overview comment for every pull request in a repository, now.

    Greptile edits that comment in place, including after the merge, so the
    version GitHub serves today is the reviewer's settled verdict on the merged
    state — which is the measurement the Komodo mirror snapshot already provides
    for the unreviewed arm. Reading it here puts both arms on the same footing.

    One sweep of the repository's issue-comment list rather than one call per
    pull request: 220 pull requests cost about two seconds this way and about
    four minutes the other way.

    Returns the scores and where they came from — ``live``, ``cache`` (the
    network failed and a previous run's answer was reused), or ``unavailable``.
    """
    cache_path = CACHE_DIR / f"gh-scores-{slug.replace('/', '__')}.json"

    def from_cache() -> dict[int, CurrentScore]:
        try:
            blob = json.loads(cache_path.read_text())
        except (OSError, json.JSONDecodeError):
            return {}
        return {
            int(pr): CurrentScore(entry["score"], entry["updated_at"])
            for pr, entry in (blob.get("scores") or {}).items()
        }

    if not refresh and not shutil.which("gh"):
        log(f"  {slug}: gh not on PATH — falling back")
        cached = from_cache()
        return (cached, "cache") if cached else ({}, "unavailable")

    result = subprocess.run(
        [
            "gh", "api",
            f"repos/{slug}/issues/comments?per_page=100",
            "--paginate",
            "--jq",
            f'.[] | select(.user.login=="{REVIEWER_LOGIN}")'
            " | {pr: (.issue_url|split(\"/\")|last|tonumber), updated: .updated_at, body: .body}",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        # Not fatal: the recorded rounds still describe the exchange, and the
        # report says which source each number came from.
        log(f"  {slug}: gh read failed ({result.stderr.strip().splitlines()[:1]}) — falling back")
        cached = from_cache()
        return (cached, "cache") if cached else ({}, "unavailable")

    scores: dict[int, CurrentScore] = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        try:
            comment = json.loads(line)
        except json.JSONDecodeError:
            continue
        score = confidence_score(comment.get("body"))
        if score is None:
            continue
        pr = int(comment["pr"])
        updated = comment.get("updated") or ""
        # A pull request can carry more than one comment from the reviewer; the
        # most recently edited one is the current verdict.
        existing = scores.get(pr)
        if existing is None or updated > existing.updated_at:
            scores[pr] = CurrentScore(score, updated)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(
            {
                "slug": slug,
                "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "scores": {str(pr): {"score": s.score, "updated_at": s.updated_at} for pr, s in scores.items()},
            }
        )
    )
    log(f"  {slug}: re-read {len(scores)} settled review scores")
    return scores, "live"


# --------------------------------------------------------------------------
# repository history
# --------------------------------------------------------------------------

CACHE_VERSION = 3

# Generated, not written. A 110k-line lockfile would be the loudest thing in
# every size chart and would say nothing about either arm.
_GENERATED = re.compile(r"(^|/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$")
_CODE = re.compile(r"\.(go|ts|tsx|js|jsx|mjs|cjs|css|scss|html|sql|sh)$")
_MARKDOWN = re.compile(r"\.(md|mdx)$")
_CONFIG = re.compile(r"(\.(json|ya?ml|toml|mod)$|(^|/)(Dockerfile|\.gitignore|\.dockerignore)$)")
_TEST = re.compile(r"(^|/)(tests?|__tests__)/|(_test\.go|\.(test|spec)\.(ts|tsx|js|jsx)|_test\.(ts|tsx))$")


def classify_path(path: str) -> str:
    if _GENERATED.search(path):
        return "generated"
    if _MARKDOWN.search(path):
        return "markdown"
    if _CODE.search(path):
        return "code"
    if _CONFIG.search(path):
        return "config"
    return "other"


def _git(repo: Path, args: Sequence[str], check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
    )
    if check and result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed in {repo}: {result.stderr.strip()}")
    return result.stdout


_MERGE_PR = re.compile(r"^Merge pull request #(\d+) ")
_SQUASH_PR = re.compile(r"\(#(\d+)\)\s*$")


def pull_request_of(subject: str) -> int | None:
    match = _MERGE_PR.match(subject) or _SQUASH_PR.search(subject)
    return int(match.group(1)) if match else None


def _main_ref(repo: Path) -> str:
    for ref in ("origin/main", "main", "HEAD"):
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return ref
    raise SystemExit(f"{repo} has no origin/main, main, or HEAD")


def _tree_line_counts(repo: Path, sha: str) -> dict[str, int]:
    """Per-file line counts for a whole tree, in one process.

    ``git grep -c ''`` matches every line of every file and prints
    ``rev:path:count`` — a per-file ``wc -l`` over a commit without checking
    anything out. ``-I`` drops binaries, which is what makes the totals mean
    "lines of text" rather than "bytes that happened to contain newlines".
    """
    result = subprocess.run(
        ["git", "grep", "-I", "-c", "", sha],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    # Exit 1 is git grep's "no matches": an empty or all-binary tree.
    if result.returncode not in (0, 1):
        raise SystemExit(f"git grep failed for {sha} in {repo}: {result.stderr.strip()}")
    counts: dict[str, int] = {}
    prefix = f"{sha}:"
    for line in result.stdout.splitlines():
        if not line.startswith(prefix):
            continue
        body = line[len(prefix) :]
        path, _, count = body.rpartition(":")
        if path and count.isdigit():
            counts[path] = int(count)
    return counts


@dataclass
class Snapshot:
    pr: int
    sha: str
    ts: int
    total: int
    code: int
    test: int
    markdown: int
    config: int
    other: int
    files: int
    code_files: int
    md_files: int
    md_by_file: dict[str, int]
    largest_code: int
    top10_share: float


@dataclass
class Timeline:
    arm: str
    repo: Path
    ref: str
    head_sha: str
    snapshots: list[Snapshot]
    head_files: dict[str, int]


def _summarise(sha: str, pr: int, ts: int, counts: dict[str, int]) -> Snapshot:
    totals = dict(total=0, code=0, test=0, markdown=0, config=0, other=0)
    files = code_files = md_files = 0
    md_by_file: dict[str, int] = {}
    code_sizes: list[int] = []
    for path, lines in counts.items():
        kind = classify_path(path)
        if kind == "generated":
            continue
        totals["total"] += lines
        files += 1
        if kind == "code":
            totals["code"] += lines
            code_files += 1
            code_sizes.append(lines)
            if _TEST.search(path):
                totals["test"] += lines
        elif kind == "markdown":
            totals["markdown"] += lines
            md_files += 1
            md_by_file[path] = lines
        elif kind == "config":
            totals["config"] += lines
        else:
            totals["other"] += lines
    code_sizes.sort(reverse=True)
    top_ten = sum(code_sizes[:10])
    return Snapshot(
        pr=pr,
        sha=sha,
        ts=ts,
        files=files,
        code_files=code_files,
        md_files=md_files,
        md_by_file=md_by_file,
        largest_code=code_sizes[0] if code_sizes else 0,
        top10_share=(top_ten / totals["code"]) if totals["code"] else 0.0,
        **totals,
    )


def build_timeline(
    arm: str,
    repo: Path,
    max_pr: int | None = None,
    fetch: bool = False,
    refresh: bool = False,
    log: Callable[[str], None] = lambda _: None,
) -> Timeline:
    if fetch:
        log(f"  {arm}: git fetch")
        _git(repo, ["fetch", "--quiet", "origin"])

    ref = _main_ref(repo)
    raw = _git(repo, ["log", "--first-parent", "--reverse", "--format=%H\x1f%ct\x1f%s", ref])

    # One snapshot per pull request. When a PR appears twice — a revert, a
    # re-landed branch — the last state on main wins, because that is the state
    # the next pull request was built on.
    by_pr: dict[int, tuple[str, int]] = {}
    for line in raw.splitlines():
        sha, _, rest = line.partition("\x1f")
        ts, _, subject = rest.partition("\x1f")
        pr = pull_request_of(subject)
        if pr is None or (max_pr is not None and pr > max_pr):
            continue
        by_pr[pr] = (sha, int(ts))

    cache_path = CACHE_DIR / f"repo-{arm}.json"
    cache: dict[str, dict] = {}
    if not refresh and cache_path.is_file():
        try:
            blob = json.loads(cache_path.read_text())
            if blob.get("version") == CACHE_VERSION:
                cache = blob.get("snapshots") or {}
        except (OSError, json.JSONDecodeError):
            cache = {}

    snapshots: list[Snapshot] = []
    computed = 0
    for pr in sorted(by_pr):
        sha, ts = by_pr[pr]
        stored = cache.get(sha)
        if stored is None:
            stored = _summarise(sha, pr, ts, _tree_line_counts(repo, sha)).__dict__.copy()
            stored.pop("pr")
            stored.pop("ts")
            cache[sha] = stored
            computed += 1
            if computed % 50 == 0:
                log(f"  {arm}: {computed} snapshots measured")
        snapshots.append(Snapshot(pr=pr, ts=ts, **stored))

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({"version": CACHE_VERSION, "snapshots": cache}))
    log(f"  {arm}: {len(snapshots)} snapshots ({computed} measured, {len(snapshots) - computed} cached)")

    head_sha = snapshots[-1].sha if snapshots else ""
    head_files = {
        path: lines
        for path, lines in (_tree_line_counts(repo, head_sha) if head_sha else {}).items()
        if classify_path(path) != "generated"
    }
    return Timeline(arm=arm, repo=repo, ref=ref, head_sha=head_sha, snapshots=snapshots, head_files=head_files)


# --------------------------------------------------------------------------
# blocks and aggregation
# --------------------------------------------------------------------------


@dataclass
class Block:
    index: int
    start: int
    end: int
    label: str
    partial: bool


def make_blocks(max_pr: int, size: int) -> list[Block]:
    out: list[Block] = []
    start = 1
    while start <= max_pr:
        end = min(start + size - 1, max_pr)
        out.append(
            Block(
                index=len(out),
                start=start,
                end=end,
                label=str(start) if start == end else f"{start}–{end}",
                partial=(end - start + 1) < size,
            )
        )
        start += size
    return out


def block_average(
    rows: Sequence[PullRequest],
    blocks: Sequence[Block],
    value_of: Callable[[PullRequest], float | None],
) -> tuple[list[float | None], list[int]]:
    values: list[float | None] = []
    counts: list[int] = []
    for block in blocks:
        picked = [
            v
            for row in rows
            if block.start <= row.pr <= block.end
            for v in [value_of(row)]
            if v is not None
        ]
        values.append(sum(picked) / len(picked) if picked else None)
        counts.append(len(picked))
    return values, counts


def block_ratio(
    rows: Sequence[PullRequest],
    blocks: Sequence[Block],
    numerator_of: Callable[[PullRequest], float | None],
    denominator_of: Callable[[PullRequest], float | None],
    scale: float = 1.0,
) -> tuple[list[float | None], list[int]]:
    """Sum(numerator) / sum(denominator) per block, not the mean of per-PR ratios.

    A one-line pull request with one finding would otherwise carry the same weight
    as a thousand-line pull request with ten.
    """
    values: list[float | None] = []
    counts: list[int] = []
    for block in blocks:
        top = bottom = 0.0
        count = 0
        for row in rows:
            if not (block.start <= row.pr <= block.end):
                continue
            n = numerator_of(row)
            d = denominator_of(row)
            if n is None or d is None:
                continue
            top += n
            bottom += d
            count += 1
        values.append((top / bottom) * scale if bottom > 0 else None)
        counts.append(count)
    return values, counts


def series_by_pr(snapshots: Sequence[Snapshot], value_of: Callable[[Snapshot], float]) -> tuple[list[int], list[float]]:
    return [s.pr for s in snapshots], [value_of(s) for s in snapshots]


def saturating_fit(xs: Sequence[float], ys: Sequence[float]) -> dict:
    """Least-squares fit of ``y = a - b*exp(-c*x)`` — a curve with a ceiling.

    Used instead of a polynomial because the alternatives assert things the data
    does not: a quadratic fits marginally better but turns over and predicts
    negative values just past the observed range, and a log rises without bound.
    A saturating curve is the cheapest shape that can express "rises, then levels
    off", which is what the block averages actually do.

    For a fixed ``c`` the model is linear in ``a`` and ``b``, so this grids ``c``
    and solves the 2x2 normal equations at each step — no solver dependency.
    """
    n = len(xs)
    if n < 3:
        return {}
    mean_y = sum(ys) / n
    sst = sum((y - mean_y) ** 2 for y in ys)
    best = None
    for step in range(1, 2001):
        c = step * 0.0001
        es = [math.exp(-c * x) for x in xs]
        # normal equations for y = a*1 + b*(-e)
        s11, s12, s22 = float(n), -sum(es), sum(e * e for e in es)
        t1, t2 = sum(ys), -sum(y * e for y, e in zip(ys, es))
        det = s11 * s22 - s12 * s12
        if abs(det) < 1e-12:
            continue
        a = (t1 * s22 - s12 * t2) / det
        b = (s11 * t2 - t1 * s12) / det
        ssr = sum((y - (a - b * e)) ** 2 for y, e in zip(ys, es))
        r2 = 1 - ssr / sst if sst else 0.0
        if best is None or r2 > best["r_squared"]:
            best = {"a": a, "b": b, "c": c, "r_squared": r2, "n": n}
    if best and best["c"] > 0:
        best["halfway_at"] = math.log(2) / best["c"]
        best["ninety_pct_at"] = math.log(10) / best["c"]
    return best or {}


# --------------------------------------------------------------------------
# the dataset
# --------------------------------------------------------------------------


@dataclass
class Dataset:
    rows: list[PullRequest]
    max_pr: int
    block_size: int
    blocks: list[Block]
    repos: dict[str, Timeline]
    provenance: dict
    caveats: dict

    def repo(self, arm: str) -> Timeline | None:
        return self.repos.get(arm)

    @property
    def has_git(self) -> bool:
        return bool(self.repos)


def _head_commit(path: Path) -> str | None:
    result = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=path, capture_output=True, text=True)
    return result.stdout.strip() or None if result.returncode == 0 else None


def build_dataset(
    block_size: int = 20,
    max_pr: int | None = None,
    fetch: bool = False,
    skip_git: bool = False,
    skip_gh: bool = False,
    refresh: bool = False,
    log: Callable[[str], None] = print,
) -> Dataset:
    state_backup = state_backup_dir()
    log(f"reading {state_backup}/results")
    state = load_state(state_backup)

    highest = max((row.pr for row in state.rows), default=0)
    limit = min(max_pr, highest) if max_pr is not None else highest
    rows = [row for row in state.rows if row.pr <= limit]
    log(f"  {len(rows)} pull request pairs (PR 1–{limit})")

    # The settled Tuatara verdict, re-read from GitHub. On by default: Greptile
    # keeps reviewing after the merge and edits its overview in place, so the
    # recorded round is a snapshot taken mid-exchange while this is where the
    # exchange ended up.
    tuatara_slug = next((repo_slug(row.t_pr_url) for row in rows if repo_slug(row.t_pr_url)), None)
    score_source = "recorded"
    if not skip_gh and tuatara_slug:
        log("re-reading settled review scores")
        current, score_source = fetch_current_scores(tuatara_slug, refresh=refresh, log=log)
        for row in rows:
            settled = current.get(row.pr)
            if settled is not None:
                row.t_final_current = settled.score
                row.t_final_current_at = settled.updated_at

    repos: dict[str, Timeline] = {}
    git_error: str | None = None
    if not skip_git:
        try:
            log("measuring repository history")
            for arm in ARMS:
                repos[arm] = build_timeline(
                    arm, arm_repo_dir(arm), max_pr=limit, fetch=fetch, refresh=refresh, log=log
                )
        except SystemExit as error:
            # A missing checkout costs the git-derived figures, not the run: the
            # review charts are the primary result and need only the state backup.
            git_error = str(error)
            repos = {}
            log(f"  skipping git-derived charts: {git_error}")

    provenance = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "harness": {"path": str(HARNESS_DIR), "commit": _head_commit(HARNESS_DIR)},
        "state_backup": {"path": str(state_backup), "commit": _head_commit(state_backup)},
        "arms": {
            arm: {
                "path": str(repos[arm].repo) if arm in repos else str(HARNESS_DIR.parent / f"vivarium-{arm}"),
                "ref": repos[arm].ref if arm in repos else None,
                "head_sha": repos[arm].head_sha if arm in repos else None,
            }
            for arm in ARMS
        },
        "tuatara_review_source": {
            "slug": tuatara_slug,
            "mode": score_source,
            "re_read": sum(1 for row in rows if row.t_final_current is not None),
        },
        "options": {
            "block_size": block_size,
            "max_pr": limit,
            "fetch": fetch,
            "skip_git": skip_git,
            "skip_gh": skip_gh,
        },
    }

    caveats = {
        "incomplete_runs": state.incomplete_runs,
        "mismatched_pairs": state.mismatched_pairs,
        "missing_mirror": [pr for pr in state.missing_mirror if pr <= limit],
        "prs_without_first_score": [row.pr for row in rows if row.t_first is None],
        "prs_without_final_score": [row.pr for row in rows if row.t_final is None],
        "prs_without_komodo_score": [row.pr for row in rows if row.k_score is None],
        "final_score_source": score_source,
        # Only interesting when a re-read was actually attempted: under --no-gh
        # every row falls back by design, and listing all of them is noise.
        "prs_final_from_recorded_round": (
            [row.pr for row in rows if row.t_final_current is None and row.t_final_recorded is not None]
            if score_source in ("live", "cache")
            else []
        ),
        "prs_where_settled_differs": [
            row.pr
            for row in rows
            if row.t_final_current is not None
            and row.t_final_recorded is not None
            and row.t_final_current != row.t_final_recorded
        ],
        "git_skipped": skip_git or not repos,
        "git_error": git_error,
    }

    return Dataset(
        rows=rows,
        max_pr=limit,
        block_size=block_size,
        blocks=make_blocks(limit, block_size),
        repos=repos,
        provenance=provenance,
        caveats=caveats,
    )


# --------------------------------------------------------------------------
# shared CLI plumbing
# --------------------------------------------------------------------------


def add_dataset_args(parser) -> None:
    parser.add_argument("--block-size", type=int, default=20, help="PRs per x-axis block (default 20)")
    parser.add_argument("--max-pr", type=int, default=None, help="analyse only PRs 1..N")
    parser.add_argument("--fetch", action="store_true", help="git fetch each arm before reading history")
    parser.add_argument("--no-git", action="store_true", help="skip every git-derived chart")
    parser.add_argument(
        "--no-gh",
        action="store_true",
        help="do not re-read settled review scores from GitHub; use the last recorded round instead",
    )
    parser.add_argument("--refresh", action="store_true", help="ignore the snapshot cache")
    parser.add_argument("--out", default=None, help="output directory (default out/<timestamp>/)")
    parser.add_argument("--quiet", action="store_true", help="only print the output path")


def dataset_from_args(args) -> Dataset:
    return build_dataset(
        block_size=args.block_size,
        max_pr=args.max_pr,
        fetch=args.fetch,
        skip_git=args.no_git,
        skip_gh=args.no_gh,
        refresh=args.refresh,
        log=(lambda _: None) if args.quiet else print,
    )


def run_directory(args) -> Path:
    if args.out:
        path = Path(args.out).expanduser().resolve()
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        path = OUT_DIR / stamp
    (path / "charts").mkdir(parents=True, exist_ok=True)
    (path / "data").mkdir(parents=True, exist_ok=True)
    return path
