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

test("parseReviewArtifact rejects missing structured block", () => {
  assert.throws(() => parseReviewArtifact("# Review without data"), /kualityforge-review block/);
});

test("safeArtifactName makes runner ids file-safe", () => {
  assert.equal(safeArtifactName("codex:gpt-5/session 1"), "codex-gpt-5-session-1");
});
