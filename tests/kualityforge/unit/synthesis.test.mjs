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

test("synthesizeFindings appends different descriptions and suggestions when merging", () => {
  const findings = synthesizeFindings([
    {
      id: "QF-001",
      title: "Missing dependency",
      severity: "blocker",
      status: "open",
      duplicateKey: "missing-dep",
      sourceRunnerId: "codex",
      description: "Package foo is not in package.json",
      suggestion: "Add foo to dependencies"
    },
    {
      id: "QF-002",
      title: "Runtime dependency not declared",
      severity: "warning",
      status: "open",
      duplicateKey: "missing-dep",
      sourceRunnerId: "claude",
      description: "Package foo is imported but undeclared",
      suggestion: "Run npm install foo --save"
    }
  ]);

  assert.equal(findings.length, 1);
  assert.ok(findings[0].description.includes("Package foo is not in package.json"));
  assert.ok(findings[0].description.includes("Package foo is imported but undeclared"));
  assert.ok(findings[0].suggestion.includes("Add foo to dependencies"));
  assert.ok(findings[0].suggestion.includes("Run npm install foo --save"));
});

test("synthesizeFindings preserves description and suggestion through spread", () => {
  const findings = synthesizeFindings([
    {
      id: "QF-001",
      title: "Missing dependency",
      severity: "blocker",
      status: "open",
      sourceRunnerId: "codex",
      description: "Package foo is not in package.json",
      suggestion: "Add foo to dependencies"
    }
  ]);

  assert.equal(findings[0].description, "Package foo is not in package.json");
  assert.equal(findings[0].suggestion, "Add foo to dependencies");
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

test("renderSummaryMarkdown highlights context gaps and quality principle violations", () => {
  const markdown = renderSummaryMarkdown({
    runId: "run-context",
    contextGaps: [
      {
        runnerId: "claude",
        gaps: ["docs root was not provided"]
      }
    ],
    findings: [
      {
        id: "QF-PRINCIPLE-001",
        type: "quality_principle_violation",
        principleId: "eval-backed-gate",
        priority: "must",
        title: "Missing eval coverage",
        severity: "blocker",
        status: "open",
        reviewerCount: 1,
        sourceRunnerIds: ["claude"]
      }
    ]
  });

  assert.match(markdown, /## Context Gaps/);
  assert.match(markdown, /claude: docs root was not provided/);
  assert.match(markdown, /## Quality Principle Violations/);
  assert.match(markdown, /Principle: eval-backed-gate/);
  assert.match(markdown, /Priority: must/);
});
