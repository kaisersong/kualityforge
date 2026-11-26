import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewArtifact } from "../../../src/core/review-artifact.mjs";
import { synthesizeFindings, findPossibleDuplicates, renderSummaryMarkdown } from "../../../src/core/synthesis.mjs";
import { sampleAcrossDirectories } from "../../../src/core/context-pack.mjs";
import { readContextOptions } from "../../../src/cli/options.mjs";

const LONG = "detail long enough to avoid the vacuous threshold check entirely for this finding";

function review(runnerId, id, title, description = LONG) {
  const body = { runnerId, status: "completed", findings: [{ id, title, description, suggestion: LONG, severity: "warning" }] };
  return parseReviewArtifact(`\`\`\`kualityforge-review\n${JSON.stringify(body)}\n\`\`\`\n`);
}

test("structure scan sampling represents every top-level directory", () => {
  const files = [
    ...Array.from({ length: 600 }, (_, i) => `desktop/f${String(i).padStart(4, "0")}.ts`),
    ...Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`)
  ];
  const picked = sampleAcrossDirectories(files, 100);
  assert.equal(picked.length, 100);
  assert.equal(picked.filter((f) => f.startsWith("src/")).length, 50);
  assert.deepEqual(sampleAcrossDirectories(files.slice(0, 10), 100), files.slice(0, 10));
});

test("--structure-scan-max-files is parsed and validated", () => {
  assert.equal(readContextOptions(["--project-root", ".", "--structure-scan-max-files", "2000"]).structureScanMaxFiles, 2000);
  assert.throws(() => readContextOptions(["--project-root", ".", "--structure-scan-max-files", "abc"]), /positive integer/);
});

test("same problem worded differently by two reviewers is flagged as a possible duplicate, never merged", () => {
  const a = review("business", "x", "Key permissions not in FAQ", "See src/utils/config.ts:26 and docs/faq.md:22 and release-notes/1.5.md");
  const b = review("uiux", "y", "API key storage change missing from release notes", "src/utils/config.ts:83 changes storage; docs/faq.md and release-notes/1.5.md are stale");
  const merged = synthesizeFindings([...a.findings, ...b.findings]);
  assert.equal(merged.length, 2);
  const pairs = findPossibleDuplicates(merged);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].sharedFiles, ["docs/faq.md", "release-notes/1.5.md", "src/utils/config.ts"]);
  assert.match(renderSummaryMarkdown({ runId: "r", findings: merged }), /Possible Duplicates/);
});

test("a file cited by most findings does not make unrelated findings look duplicated", () => {
  const mk = (runner, id, extra) => review(runner, id, `Title ${id}`, `src/main.ts:1 ${extra}`).findings[0];
  const all = [mk("a", "1", "docs/x.md"), mk("b", "2", "docs/y.md"), mk("c", "3", "docs/z.md"), mk("d", "4", "docs/w.md")];
  assert.equal(findPossibleDuplicates(all).length, 0);
});

test("findings from the same reviewer are never paired", () => {
  const a = review("one", "a", "A", "src/a.ts and src/b.ts");
  const b = review("one", "b", "B", "src/a.ts and src/b.ts");
  assert.equal(findPossibleDuplicates([...a.findings, ...b.findings]).length, 0);
});
