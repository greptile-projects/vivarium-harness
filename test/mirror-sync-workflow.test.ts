import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("mirror sync workflow isolation", () => {
  test("routes production and test dispatches into separate configuration", async () => {
    const [production, testWorkflow] = await Promise.all([
      readFile(
        join(repository, ".github", "workflows", "mirror-sync.yml"),
        "utf8",
      ),
      readFile(
        join(repository, ".github", "workflows", "mirror-sync-test.yml"),
        "utf8",
      ),
    ]);

    expect(production).toContain("types: [komodo-main-push]");
    expect(production).not.toContain("test-komodo-main-push");
    expect(production).not.toContain("TEST_LAST_SYNCED_SHA");

    expect(testWorkflow).toContain("types: [test-komodo-main-push]");
    expect(testWorkflow).not.toContain("types: [komodo-main-push]");
    expect(testWorkflow).toContain("SOURCE_REPO: ${{ vars.TEST_SOURCE_REPO }}");
    expect(testWorkflow).toContain("MIRROR_REPO: ${{ vars.TEST_MIRROR_REPO }}");
    expect(testWorkflow).toContain("STATE_VAR: TEST_LAST_SYNCED_SHA");
    expect(testWorkflow).not.toContain("SOURCE_REPO: ${{ vars.SOURCE_REPO }}");
    expect(testWorkflow).not.toContain("MIRROR_REPO: ${{ vars.MIRROR_REPO }}");
  });
});
