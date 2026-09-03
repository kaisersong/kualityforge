import assert from "node:assert/strict";
import test from "node:test";
import {
  mapReviewFindings,
  parseReviewArtifact,
  safeArtifactName
} from "../../../src/core/review-artifact.mjs";

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

test("parseReviewArtifact detects vacuous output with empty findings", () => {
  const review = parseReviewArtifact(`# Review

\`\`\`kualityforge-review
{
  "runnerId": "codex:gpt-5",
  "status": "completed",
  "findings": []
}
\`\`\`
`);

  assert.equal(review.isVacuous, true);
});

test("parseReviewArtifact detects vacuous output with short findings", () => {
  const review = parseReviewArtifact(`# Review

\`\`\`kualityforge-review
{
  "runnerId": "codex:gpt-5",
  "status": "completed",
  "findings": [
    {
      "id": "QF-001",
      "title": "ok",
      "severity": "info",
      "status": "open"
    }
  ]
}
\`\`\`
`);

  assert.equal(review.isVacuous, true);
});

test("parseReviewArtifact preserves description and suggestion in mapped findings", () => {
  const review = parseReviewArtifact(`# Review

\`\`\`kualityforge-review
{
  "runnerId": "codex:gpt-5",
  "status": "completed",
  "findings": [
    {
      "id": "QF-001",
      "title": "Missing input validation on API endpoint allows injection attacks",
      "description": "The /api/users endpoint does not validate the email parameter",
      "suggestion": "Add input validation using a schema library",
      "severity": "blocker",
      "status": "open"
    }
  ]
}
\`\`\`
`);

  assert.equal(review.findings[0].description, "The /api/users endpoint does not validate the email parameter");
  assert.equal(review.findings[0].suggestion, "Add input validation using a schema library");
});

test("parseReviewArtifact defaults description and suggestion to empty string when absent", () => {
  const review = parseReviewArtifact(`# Review

\`\`\`kualityforge-review
{
  "runnerId": "codex:gpt-5",
  "status": "completed",
  "findings": [
    {
      "id": "QF-001",
      "title": "Potential issue identified during review requiring further investigation and resolution",
      "severity": "info",
      "status": "open"
    }
  ]
}
\`\`\`
`);

  assert.equal(review.findings[0].description, "");
  assert.equal(review.findings[0].suggestion, "");
});

test("parseReviewArtifact marks substantive findings as non-vacuous", () => {
  const review = parseReviewArtifact(`# Review

\`\`\`kualityforge-review
{
  "runnerId": "codex:gpt-5",
  "status": "completed",
  "findings": [
    {
      "id": "QF-001",
      "title": "Missing input validation on API endpoint allows injection attacks via unsanitized user input",
      "description": "The /api/users endpoint does not validate or sanitize the email parameter before passing it to the database query",
      "suggestion": "Add input validation using a schema library and parameterized queries",
      "severity": "blocker",
      "status": "open"
    }
  ]
}
\`\`\`
`);

  assert.equal(review.isVacuous, false);
});

function reviewMarkdown(body) {
  return `# Review\n\n\`\`\`kualityforge-review\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

test("a review that never claimed completion is not silently promoted to completed", () => {
  assert.throws(
    () => parseReviewArtifact(reviewMarkdown({ runnerId: "codex:gpt-5", findings: [] })),
    /review status must be one of completed, failed/
  );
});

test("a review status outside the closed vocabulary is rejected", () => {
  assert.throws(
    () =>
      parseReviewArtifact(
        reviewMarkdown({ runnerId: "codex:gpt-5", status: "probably_fine", findings: [] })
      ),
    /review status must be one of completed, failed; got: probably_fine/
  );
});

test("a reviewer may honestly self-report a failed review", () => {
  const review = parseReviewArtifact(
    reviewMarkdown({ runnerId: "codex:gpt-5", status: "failed", findings: [] })
  );
  assert.equal(review.status, "failed");
});

test("mapReviewFindings is the mapping the parser applies, not a second copy of it", () => {
  const findings = [
    {
      id: "QF-001",
      title: "Missing input validation on API endpoint allows injection attacks",
      description: "The /api/users endpoint does not validate the email parameter",
      suggestion: "Add input validation using a schema library",
      severity: "blocker",
      status: "open"
    },
    { title: "Second issue worth reporting", severity: "info", status: "open" }
  ];
  const parsed = parseReviewArtifact(
    reviewMarkdown({ runnerId: "codex:gpt-5", status: "completed", findings })
  );
  const mapped = mapReviewFindings("codex:gpt-5", findings);

  assert.deepEqual(mapped.findings, parsed.findings);
  // The one accumulator: if a second one existed it could drift from the value
  // that actually decides isVacuous.
  assert.equal(mapped.findingsTextLength < 200, parsed.isVacuous);
});

test("mapReviewFindings enforces the same finding vocabulary as the parser", () => {
  assert.throws(
    () => mapReviewFindings("codex:gpt-5", [{ title: "x", severity: "high", status: "open" }]),
    /finding severity must be one of blocker, warning, info/
  );
  assert.throws(
    () => mapReviewFindings("codex:gpt-5", [{ title: "x", severity: "info", status: "verified" }]),
    /is not writable by a reviewer/
  );
});
