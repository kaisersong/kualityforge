import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewArtifact } from "../../../src/core/review-artifact.mjs";
import { synthesizeFindings } from "../../../src/core/synthesis.mjs";

function reviewMarkdown(runnerId, titles) {
  const findings = titles.map((title) => ({
    title,
    description: `Detail for ${title} long enough to avoid the vacuous threshold check entirely`,
    suggestion: `Suggestion for ${title} long enough to avoid the vacuous threshold check entirely`,
    severity: "warning"
  }));
  return `# Review

\`\`\`kualityforge-review
${JSON.stringify({ runnerId, status: "completed", findings }, null, 2)}
\`\`\`
`;
}

test("a default finding id is namespaced by its reviewer", () => {
  const review = parseReviewArtifact(reviewMarkdown("codex:gpt-5", ["SQL injection in login"]));
  assert.equal(review.findings[0].id, "codex:gpt-5:QF-001");
});

test("two reviewers reporting different findings no longer collide on QF-001", () => {
  const codex = parseReviewArtifact(reviewMarkdown("codex:gpt-5", ["SQL injection in login"]));
  const claude = parseReviewArtifact(reviewMarkdown("claude:sonnet", ["Missing CSRF token"]));

  const merged = synthesizeFindings([...codex.findings, ...claude.findings]);
  assert.equal(merged.length, 2);
  assert.equal(new Set(merged.map((finding) => finding.id)).size, 2);
});

test("an id a reviewer chose explicitly is left alone", () => {
  const markdown = `# Review

\`\`\`kualityforge-review
{
  "runnerId": "codex:gpt-5",
  "status": "completed",
  "findings": [
    {
      "id": "SEC-42",
      "title": "SQL injection in login",
      "description": "Detail long enough to avoid the vacuous threshold check entirely for this case",
      "suggestion": "Suggestion long enough to avoid the vacuous threshold check entirely for this",
      "severity": "warning"
    }
  ]
}
\`\`\`
`;
  const review = parseReviewArtifact(markdown);
  assert.equal(review.findings[0].id, "SEC-42");
});

test("synthesis refuses to emit two findings sharing an id", () => {
  const collided = [
    {
      id: "QF-001",
      title: "SQL injection in login",
      severity: "warning",
      status: "open",
      sourceRunnerId: "codex:gpt-5"
    },
    {
      id: "QF-001",
      title: "Missing CSRF token",
      severity: "warning",
      status: "open",
      sourceRunnerId: "claude:sonnet"
    }
  ];
  assert.throws(() => synthesizeFindings(collided), /duplicate finding id QF-001/);
});

test("merging findings that share a title keeps a single id", () => {
  const codex = parseReviewArtifact(reviewMarkdown("codex:gpt-5", ["Shared concern about input validation"]));
  const claude = parseReviewArtifact(reviewMarkdown("claude:sonnet", ["Shared concern about input validation"]));

  const merged = synthesizeFindings([...codex.findings, ...claude.findings]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sourceRunnerIds, ["claude:sonnet", "codex:gpt-5"]);
});
