import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../src/harness/github.js";
import {
  parseSource,
  recordFileName,
  snapshotMirror,
  type MirrorPullRecord,
} from "../src/mirror/snapshot.js";

const SLUG = "makors/vivarium-komodo-mirror";

// A gh stub answering by API path, so the suite needs neither network nor gh.
// Unlisted paths fail like a real 404 — a snapshot must treat an unreadable
// endpoint as an error, never as an empty conversation.
function fakeGh(responses: Record<string, unknown>): CommandRunner {
  return async (command, args) => {
    expect(command).toBe("gh");
    const path = args.at(-1) ?? "";
    if (path in responses) {
      return { code: 0, stdout: JSON.stringify(responses[path]), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `gh: Not Found (${path})` };
  };
}

function baseResponses(): Record<string, unknown> {
  return {
    [`repos/${SLUG}/pulls?state=all&per_page=100`]: [{ number: 26 }],
    [`repos/${SLUG}/pulls/26`]: {
      number: 26,
      html_url: `https://github.com/${SLUG}/pull/26`,
      title: "[codex] define repository workflow contracts",
      state: "closed",
      merged_at: "2026-07-29T22:40:00Z",
      created_at: "2026-07-29T22:31:00Z",
      updated_at: "2026-07-29T22:39:00Z",
      additions: 876,
      deletions: 5,
      changed_files: 9,
      head: { ref: "sync/abc1234" },
      body: [
        "## Original Ticket",
        "",
        "### Objective",
        "…",
        "",
        "---",
        "",
        "Source PR: #26 — https://github.com/greptile-projects/vivarium-komodo/pull/26",
        "Source SHA: 6e6be39f26c7b58746863da58360811d62e9a41f",
        "Original author: https://github.com/komodo-arm",
        "",
        "Synced state; see repo README for mechanism.",
      ].join("\n"),
    },
    [`repos/${SLUG}/pulls/26/reviews`]: [
      {
        id: 900,
        user: { login: "greptile-apps[bot]" },
        body: "Overview — confidence 4/5",
        state: "COMMENTED",
        submitted_at: "2026-07-29T22:35:00Z",
        html_url: `https://github.com/${SLUG}/pull/26#pullrequestreview-900`,
      },
    ],
    [`repos/${SLUG}/issues/26/comments`]: [
      {
        id: 500,
        user: { login: "greptile-apps[bot]" },
        body: "summary comment",
        created_at: "2026-07-29T22:35:10Z",
        updated_at: "2026-07-29T22:35:10Z",
        html_url: `https://github.com/${SLUG}/pull/26#issuecomment-500`,
        reactions: { total_count: 1 },
      },
    ],
    [`repos/${SLUG}/issues/comments/500/reactions`]: [
      {
        id: 71,
        user: { login: "someone" },
        content: "+1",
        created_at: "2026-07-29T22:36:00Z",
      },
    ],
    [`repos/${SLUG}/pulls/26/comments`]: [
      {
        id: 600,
        user: { login: "greptile-apps[bot]" },
        body: "P1: off-by-one",
        created_at: "2026-07-29T22:35:20Z",
        updated_at: "2026-07-29T22:35:20Z",
        html_url: `https://github.com/${SLUG}/pull/26#discussion_r600`,
        path: "apps/api/workflow/service.go",
        line: 334,
        original_line: 334,
        diff_hunk: "@@ -0,0 +1,3 @@",
        reactions: { total_count: 0 },
      },
    ],
  };
}

async function readRecord(dir: string, pull: number): Promise<MirrorPullRecord> {
  return JSON.parse(
    await readFile(join(dir, recordFileName(pull)), "utf8"),
  ) as MirrorPullRecord;
}

describe("parseSource", () => {
  test("reads the provenance lines mirror_sync.sh writes", () => {
    const source = parseSource(
      "ticket text\n\n---\n\nSource PR: #7 — https://github.com/o/r/pull/7\nSource SHA: abc1234\nOriginal author: x",
    );
    expect(source).toEqual({
      pullRequest: 7,
      url: "https://github.com/o/r/pull/7",
      sha: "abc1234",
    });
  });

  test("absent provenance is absent, not zeroes", () => {
    expect(parseSource("just a body")).toBeUndefined();
    expect(parseSource(undefined)).toBeUndefined();
  });
});

describe("snapshotMirror", () => {
  test("records the pull request, conversation, source, and revisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mirror-snapshot-"));
    const summary = await snapshotMirror({
      slug: SLUG,
      directory: dir,
      exec: fakeGh(baseResponses()),
    });
    expect(summary).toEqual({ pulls: 1, newRevisions: 4, errors: [] });

    const record = await readRecord(dir, 26);
    expect(record.schemaVersion).toBe(1);
    expect(record.pullRequest).toMatchObject({
      number: 26,
      state: "MERGED",
      additions: 876,
      deletions: 5,
      changedFiles: 9,
      headRefName: "sync/abc1234",
    });
    expect(record.source).toEqual({
      pullRequest: 26,
      url: "https://github.com/greptile-projects/vivarium-komodo/pull/26",
      sha: "6e6be39f26c7b58746863da58360811d62e9a41f",
    });
    // Chronological, and in the same kind:id vocabulary as run.json.
    expect(record.conversation.map((note) => note.id)).toEqual([
      "review:900",
      "issue-comment:500",
      "review-comment:600",
      "reaction:issue-comment:71",
    ]);
    expect(record.conversationRevisions).toHaveLength(4);
  });

  test("an in-place edit accumulates a revision instead of replacing history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mirror-snapshot-"));
    const responses = baseResponses();
    const first = await snapshotMirror({
      slug: SLUG,
      directory: dir,
      exec: fakeGh(responses),
    });
    expect(first.newRevisions).toBe(4);

    // Greptile edits its summary in place: same id, new body and updated_at.
    (responses[`repos/${SLUG}/issues/26/comments`] as Record<string, unknown>[])[0] = {
      id: 500,
      user: { login: "greptile-apps[bot]" },
      body: "summary comment — confidence revised to 3/5",
      created_at: "2026-07-29T22:35:10Z",
      updated_at: "2026-07-29T22:50:00Z",
      html_url: `https://github.com/${SLUG}/pull/26#issuecomment-500`,
      reactions: { total_count: 1 },
    };
    const second = await snapshotMirror({
      slug: SLUG,
      directory: dir,
      exec: fakeGh(responses),
    });
    expect(second.newRevisions).toBe(1);

    const record = await readRecord(dir, 26);
    // The live conversation holds only the final text…
    const summaries = record.conversation.filter(
      (note) => note.id === "issue-comment:500",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.body).toContain("revised to 3/5");
    // …and the revisions hold both versions under the stable id.
    const revisions = record.conversationRevisions.filter(
      (note) => note.id === "issue-comment:500",
    );
    expect(revisions.map((note) => note.body).sort()).toEqual([
      "summary comment",
      "summary comment — confidence revised to 3/5",
    ]);

    // A third pass with nothing new adds nothing.
    const third = await snapshotMirror({
      slug: SLUG,
      directory: dir,
      exec: fakeGh(responses),
    });
    expect(third.newRevisions).toBe(0);
  });

  test("a corrupt existing record is an error, never overwritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mirror-snapshot-"));
    await writeFile(join(dir, recordFileName(26)), "{not json", "utf8");
    const summary = await snapshotMirror({
      slug: SLUG,
      directory: dir,
      exec: fakeGh(baseResponses()),
    });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("not overwriting");
    expect(await readFile(join(dir, recordFileName(26)), "utf8")).toBe(
      "{not json",
    );
  });

  test("one unreadable pull request fails alone; the rest are still written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mirror-snapshot-"));
    const responses = baseResponses();
    responses[`repos/${SLUG}/pulls?state=all&per_page=100`] = [
      { number: 25 },
      { number: 26 },
    ];
    // #25 has no detail response, so its fetch fails like a real 404.
    const summary = await snapshotMirror({
      slug: SLUG,
      directory: dir,
      exec: fakeGh(responses),
    });
    expect(summary.pulls).toBe(2);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("#25");
    expect((await readRecord(dir, 26)).pullRequest.number).toBe(26);
  });

  test("an unreadable listing throws — an empty mirror and a failed read must differ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mirror-snapshot-"));
    await expect(
      snapshotMirror({ slug: SLUG, directory: dir, exec: fakeGh({}) }),
    ).rejects.toThrow("pull requests");
  });
});
