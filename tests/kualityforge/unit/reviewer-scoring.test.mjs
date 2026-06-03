import assert from "node:assert/strict";
import { test } from "node:test";
import { WEIGHTS, scoreReviewers } from "../../../src/core/reviewer-scoring.mjs";

test("WEIGHTS sum to 1", () => {
  const sum = Object.values(WEIGHTS).reduce((acc, weight) => acc + weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("scoreReviewers is deterministic and bounded", () => {
  const reviewers = [
    {
      runnerId: "codex",
      status: "completed",
      contextConfidence: "high",
      contextRead: { projectBrief: true, changeset: true },
      contextGaps: []
    }
  ];
  const findings = [
    { id: "QF-001", severity: "blocker", duplicateKey: "dup-a", sourceRunnerId: "codex" }
  ];
  const synthesized = [{ id: "QF-001", duplicateKey: "dup-a", reviewerCount: 1 }];

  const a = scoreReviewers({ reviewers, findings, synthesizedFindings: synthesized });
  const b = scoreReviewers({ reviewers, findings, synthesizedFindings: synthesized });
  assert.deepEqual(a, b);
  const score = a.scores[0];
  assert.ok(score.overall >= 0 && score.overall <= 100);
});

test("consensus dimension rewards corroborated findings", () => {
  const reviewers = [
    { runnerId: "a", status: "completed", contextConfidence: "high", contextRead: { x: true }, contextGaps: [] },
    { runnerId: "b", status: "completed", contextConfidence: "high", contextRead: { x: true }, contextGaps: [] }
  ];
  const findings = [
    { id: "QF-1", severity: "warning", duplicateKey: "shared", sourceRunnerId: "a" },
    { id: "QF-2", severity: "warning", duplicateKey: "shared", sourceRunnerId: "b" }
  ];
  const synthesized = [{ id: "QF-1", duplicateKey: "shared", reviewerCount: 2 }];

  const result = scoreReviewers({ reviewers, findings, synthesizedFindings: synthesized });
  for (const score of result.scores) {
    assert.equal(score.dimensions.consensusRate, 1);
    assert.equal(score.stats.corroboratedCount, 1);
  }
});

test("ranking sorts by score then runnerId", () => {
  const reviewers = [
    { runnerId: "low", status: "completed", contextConfidence: "low", contextRead: {}, contextGaps: ["g1", "g2"] },
    { runnerId: "high", status: "completed", contextConfidence: "high", contextRead: { a: true }, contextGaps: [] }
  ];
  const result = scoreReviewers({ reviewers, findings: [], synthesizedFindings: [] });
  assert.equal(result.ranking[0], "high");
  assert.equal(result.ranking[1], "low");
});

test("failed outcome zeroes protocol compliance", () => {
  const reviewers = [
    { runnerId: "x", status: "completed", contextConfidence: "high", contextRead: { a: true }, contextGaps: [] }
  ];
  const reviewOutcomes = [{ runnerId: "x", status: "failed", absenceReason: "crash" }];
  const result = scoreReviewers({ reviewers, findings: [], synthesizedFindings: [], reviewOutcomes });
  assert.equal(result.scores[0].dimensions.protocolCompliance, 0);
});

test("contextRead penalizes unacknowledged required context keys", () => {
  const reviewers = [
    {
      runnerId: "partial",
      status: "completed",
      contextConfidence: "high",
      contextRead: { project_brief: true },
      contextRequired: ["project_brief", "user_quality_principles"],
      contextGaps: []
    },
    {
      runnerId: "full",
      status: "completed",
      contextConfidence: "high",
      contextRead: { project_brief: true, user_quality_principles: true },
      contextRequired: ["project_brief", "user_quality_principles"],
      contextGaps: []
    }
  ];
  const result = scoreReviewers({ reviewers, findings: [], synthesizedFindings: [], reviewOutcomes: [] });
  const byId = new Map(result.scores.map((score) => [score.runnerId, score]));
  assert.equal(byId.get("partial").dimensions.contextRead, 0.5);
  assert.equal(byId.get("full").dimensions.contextRead, 1);
});
