import assert from "node:assert/strict";
import test from "node:test";
import { synthesizeFindings, renderSummaryMarkdown } from "../../../src/core/synthesis.mjs";

test("synthesizeFindings merges findings with the same duplicate key", () => {
  const findings = synthesizeFindings([
    {
      id: "QF-001",
      title: "Missing dependency",
      severity: "blocker",
      status: "open",
      duplicateKey: "missing-dep",
      sourceRunnerId: "codex"
    },
    {
      id: "QF-002",
      title: "Runtime dependency not declared",
      severity: "blocker",
      status: "open",
      duplicateKey: "missing-dep",
      sourceRunnerId: "claude"
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].reviewerCount, 2);
  assert.deepEqual(findings[0].sourceRunnerIds, ["claude", "codex"]);
});

test("renderSummaryMarkdown writes a human decision checklist", () => {
  const markdown = renderSummaryMarkdown({
    runId: "run-1",
    findings: [
      {
        id: "QF-001",
        title: "Missing dependency",
        severity: "blocker",
        status: "open",
        reviewerCount: 2,
        sourceRunnerIds: ["codex", "claude"]
      }
    ]
  });

  assert.match(markdown, /# KualityForge Summary: run-1/);
  assert.match(markdown, /- \[ \] QF-001/);
  assert.match(markdown, /Reviewers: codex, claude/);
});
