import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewPolicy,
  parseCheckOption,
  parseKeyValueOptions,
  readContextOptions,
  readOption,
  readOptions,
  requireOption
} from "../../../src/cli/options.mjs";

test("readOption returns the value after a flag", () => {
  assert.equal(readOption(["--artifact-root", "/tmp/run"], "--artifact-root"), "/tmp/run");
  assert.equal(readOption(["--artifact-root"], "--artifact-root"), null);
  assert.equal(readOption([], "--artifact-root"), null);
});

test("readOptions collects repeated flag values in order", () => {
  assert.deepEqual(
    readOptions(["--reviewer", "codex", "--other", "x", "--reviewer", "claude"], "--reviewer"),
    ["codex", "claude"]
  );
});

test("requireOption raises command-specific usage errors", () => {
  assert.equal(requireOption(["--input", "review.md"], "--input", "write-review"), "review.md");
  assert.throws(
    () => requireOption([], "--input", "write-review"),
    /write-review requires --input <value>/
  );
});

test("parseCheckOption requires name=status", () => {
  assert.deepEqual(parseCheckOption("tests=passed"), { name: "tests", status: "passed" });
  assert.throws(() => parseCheckOption("tests"), /--check must use <name>=<status>/);
});

test("parseKeyValueOptions requires key=value entries", () => {
  const parsed = parseKeyValueOptions(["codex=codex.md", "claude=claude.md"], "--review");
  assert.equal(parsed.get("codex"), "codex.md");
  assert.equal(parsed.get("claude"), "claude.md");
  assert.throws(() => parseKeyValueOptions(["codex"], "--review"), /--review must use <key>=<value>/);
});

test("readContextOptions builds optional context and changeset configuration", () => {
  assert.equal(readContextOptions([]), null);
  assert.deepEqual(
    readContextOptions([
      "--project-root", "/repo",
      "--docs-root", "/repo/docs",
      "--quality-principles", "/repo/principles.json",
      "--change-goal", "ship safely",
      "--instruction", "AGENTS.md",
      "--design-entrypoint", "docs/design.md",
      "--diff-base", "main",
      "--diff-head", "WORKTREE",
      "--diff-max-patch-bytes", "4096",
      "--enable-structure-scan",
      "--review-type", "full-project"
    ]),
    {
      projectRoot: "/repo",
      docsRoots: ["/repo/docs"],
      qualityPrinciplesPath: "/repo/principles.json",
      changeGoal: "ship safely",
      instructionFiles: ["AGENTS.md"],
      designEntrypoints: ["docs/design.md"],
      changeset: { base: "main", head: "WORKTREE", maxPatchBytes: 4096 },
      enableStructureScan: true,
      reviewType: "full-project"
    }
  );
  assert.throws(
    () => readContextOptions(["--diff-max-patch-bytes", "0"]),
    /--diff-max-patch-bytes must be a positive number/
  );
});

test("buildReviewPolicy dedupes reviewers and rejects advisory downgrades", () => {
  assert.equal(buildReviewPolicy(["codex"], [], null), null);
  assert.deepEqual(
    buildReviewPolicy(["codex", "codex"], ["claude", "claude"], "2"),
    {
      mode: "quorum",
      requiredReviewers: ["codex"],
      advisoryReviewers: ["claude"],
      quorumMembers: ["codex", "claude"],
      quorumMin: 2
    }
  );
  assert.throws(
    () => buildReviewPolicy(["codex"], ["codex"], null),
    /--advisory-reviewer codex cannot downgrade a required reviewer/
  );
});
