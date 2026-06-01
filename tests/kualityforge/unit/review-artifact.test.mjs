import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewArtifact, safeArtifactName } from "../../../src/core/review-artifact.mjs";

test("parseReviewArtifact reads a structured review block", () => {
  const review = parseReviewArtifact(`# Review

\`\`\`kualityforge-review
{
  "runnerId": "codex:gpt-5",
  "status": "completed",
  "findings": [
    {
      "id": "QF-001",
      "title": "Missing dependency",
      "severity": "blocker",
      "status": "open",
      "duplicateKey": "missing-dependency"
    }
  ]
}
\`\`\`
`);

  assert.equal(review.runnerId, "codex:gpt-5");
  assert.equal(review.status, "completed");
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].sourceRunnerId, "codex:gpt-5");
});

test("parseReviewArtifact preserves context acknowledgement and principle findings", () => {
  const review = parseReviewArtifact(`# Review

\`\`\`kualityforge-review
{
  "runnerId": "claude:sonnet",
  "status": "completed",
  "contextRead": {
    "user_quality_principles": true,
    "project_brief": true
  },
  "contextConfidence": "high",
  "contextGaps": ["docs root was not provided"],
  "contextProvenance": {
    "contextManifestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "promptContextHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "principleAlignment": {
    "eval-backed-gate": "missing"
  },
  "findings": [
    {
      "id": "QF-PRINCIPLE-001",
      "type": "quality_principle_violation",
      "principleId": "eval-backed-gate",
      "priority": "must",
      "title": "Missing eval coverage",
      "severity": "blocker",
      "status": "open",
      "duplicateKey": "principle:eval-backed-gate"
    }
  ]
}
\`\`\`
`);

  assert.deepEqual(review.contextRead, {
    user_quality_principles: true,
    project_brief: true
  });
  assert.equal(review.contextConfidence, "high");
  assert.deepEqual(review.contextGaps, ["docs root was not provided"]);
  assert.equal(
    review.contextProvenance.contextManifestHash,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  );
  assert.deepEqual(review.principleAlignment, {
    "eval-backed-gate": "missing"
  });
  assert.equal(review.findings[0].type, "quality_principle_violation");
  assert.equal(review.findings[0].principleId, "eval-backed-gate");
  assert.equal(review.findings[0].priority, "must");
});

test("parseReviewArtifact rejects missing structured block", () => {
  assert.throws(() => parseReviewArtifact("# Review without data"), /kualityforge-review block/);
});

test("safeArtifactName makes runner ids file-safe", () => {
  assert.equal(safeArtifactName("codex:gpt-5/session 1"), "codex-gpt-5-session-1");
});
