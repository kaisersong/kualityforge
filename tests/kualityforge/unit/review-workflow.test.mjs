import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assignDimensions, planReview, runReviewWorkflow } from "../../../src/core/review-workflow.mjs";

const SAMPLE_REVIEW = `# Review by codex

\`\`\`kualityforge-review
{
  "runnerId": "codex",
  "status": "completed",
  "findings": []
}
\`\`\`
`;

const SAMPLE_DECISION = `# Decision

No findings to decide.
`;

const SAMPLE_VERIFY = `# Verification by verifier:independent

All reviews completed. No findings to verify.
`;

const SECOND_REVIEW = `# Review by claude

\`\`\`kualityforge-review
{
  "runnerId": "claude",
  "status": "completed",
  "findings": []
}
\`\`\`
`;

const REVIEW_WITH_FINDING = `# Review by codex

\`\`\`kualityforge-review
{
  "runnerId": "codex",
  "status": "completed",
  "findings": [
    { "id": "F1", "title": "Missing input validation in src/api.ts", "severity": "warning", "status": "open", "reviewers": ["codex"], "count": 1 }
  ]
}
\`\`\`

### Findings

- **F1**: [warning] Missing input validation in src/api.ts
`;

async function createTempDir() {
  return mkdtemp(join(tmpdir(), "kualityforge-review-"));
}

test("runReviewWorkflow runs full flow with reviews only", async () => {
  const root = await createTempDir();
  const reviewDir = join(root, "reviews");
  await mkdir(reviewDir, { recursive: true });

  const reviewPath = join(reviewDir, "codex.md");
  await writeFile(reviewPath, REVIEW_WITH_FINDING, "utf8");

  try {
    const result = await runReviewWorkflow({
      artifactRoot: join(root, "quality"),
      runId: "test-review-1",
      reviewers: [{ runnerId: "codex", path: reviewPath }]
    });

    assert.equal(result.runId, "test-review-1");
    assert.equal(result.gate.status, "incomplete");
    assert.ok(result.gate.reasons.length > 0, "expected incomplete reasons");
    assert.equal(result.report, null);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("runReviewWorkflow with decision and verify achieves passed gate", async () => {
  const root = await createTempDir();
  const reviewDir = join(root, "reviews");
  await mkdir(reviewDir, { recursive: true });

  const reviewPath = join(reviewDir, "codex.md");
  await writeFile(reviewPath, SAMPLE_REVIEW, "utf8");

  const secondReviewPath = join(reviewDir, "claude.md");
  await writeFile(secondReviewPath, SECOND_REVIEW, "utf8");

  const decisionPath = join(root, "decision.md");
  await writeFile(decisionPath, SAMPLE_DECISION, "utf8");

  const verifyPath = join(root, "verify.md");
  await writeFile(verifyPath, SAMPLE_VERIFY, "utf8");

  try {
    const result = await runReviewWorkflow({
      artifactRoot: join(root, "quality"),
      runId: "test-review-2",
      reviewers: [
        { runnerId: "codex", path: reviewPath },
        { runnerId: "claude", path: secondReviewPath }
      ],
      decisionPath,
      checks: [{ name: "npm-test", status: "passed" }],
      verifyPath,
      verifierRunnerId: "verifier:independent"
    });

    assert.equal(result.runId, "test-review-2");
    assert.equal(result.gate.status, "passed");
    assert.equal(result.gate.exitCode, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("runReviewWorkflow with --project auto-sets artifact root", async () => {
  const root = await createTempDir();
  const reviewDir = join(root, "reviews");
  await mkdir(reviewDir, { recursive: true });

  const reviewPath = join(reviewDir, "codex.md");
  await writeFile(reviewPath, SAMPLE_REVIEW, "utf8");

  try {
    const result = await runReviewWorkflow({
      projectRoot: root,
      runId: "test-review-3",
      reviewers: [{ runnerId: "codex", path: reviewPath }]
    });

    assert.ok(
      result.artifactRoot.includes("docs/quality/test-review-3"),
      `expected artifact root under docs/quality, got ${result.artifactRoot}`
    );
    assert.equal(result.gate.status, "incomplete");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("runReviewWorkflow with --report generates report", async () => {
  const root = await createTempDir();
  const reviewDir = join(root, "reviews");
  await mkdir(reviewDir, { recursive: true });

  const reviewPath = join(reviewDir, "codex.md");
  await writeFile(reviewPath, SAMPLE_REVIEW, "utf8");

  const secondReviewPath = join(reviewDir, "claude.md");
  await writeFile(secondReviewPath, SECOND_REVIEW, "utf8");

  const decisionPath = join(root, "decision.md");
  await writeFile(decisionPath, SAMPLE_DECISION, "utf8");

  const verifyPath = join(root, "verify.md");
  await writeFile(verifyPath, SAMPLE_VERIFY, "utf8");

  try {
    const result = await runReviewWorkflow({
      artifactRoot: join(root, "quality"),
      runId: "test-review-4",
      reviewers: [
        { runnerId: "codex", path: reviewPath },
        { runnerId: "claude", path: secondReviewPath }
      ],
      decisionPath,
      checks: [{ name: "npm-test", status: "passed" }],
      verifyPath,
      verifierRunnerId: "verifier:independent",
      report: true,
      html: true,
      lang: "zh"
    });

    assert.equal(result.gate.status, "passed");
    assert.ok(result.report, "expected report result");
    assert.ok(result.report.markdownPath, "expected markdown path");
    assert.ok(result.report.htmlPath, "expected html path");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("runReviewWorkflow throws when no reviewers", async () => {
  await assert.rejects(
    () => runReviewWorkflow({ artifactRoot: "/tmp/test", reviewers: [] }),
    { message: /at least one --reviewer/ }
  );
});

test("runReviewWorkflow throws when no project or artifact-root", async () => {
  await assert.rejects(
    () => runReviewWorkflow({ reviewers: [{ runnerId: "codex", path: "/tmp/review.md" }] }),
    { message: /--project.*--artifact-root/ }
  );
});

test("runReviewWorkflow auto-generates run-id when not provided", async () => {
  const root = await createTempDir();
  const reviewDir = join(root, "reviews");
  await mkdir(reviewDir, { recursive: true });

  const reviewPath = join(reviewDir, "codex.md");
  await writeFile(reviewPath, SAMPLE_REVIEW, "utf8");

  try {
    const result = await runReviewWorkflow({
      artifactRoot: join(root, "quality"),
      reviewers: [{ runnerId: "codex", path: reviewPath }]
    });

    assert.ok(result.runId.startsWith("review-"), `expected auto-generated run-id, got ${result.runId}`);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("assignDimensions distributes 5 dimensions across 4 agents", () => {
  const result = assignDimensions(["codex", "claude", "qoder", "xiaok"], { lang: "zh" });

  assert.equal(result.length, 4);
  assert.equal(result[0].agent, "codex");
  assert.equal(result[0].dimensions.length, 2);
  assert.equal(result[0].dimensions[0].label, "安全与性能");
  assert.equal(result[1].agent, "claude");
  assert.equal(result[1].dimensions.length, 1);
  assert.equal(result[2].agent, "qoder");
  assert.equal(result[2].dimensions.length, 1);
  assert.equal(result[3].agent, "xiaok");
  assert.equal(result[3].dimensions.length, 1);
});

test("assignDimensions gives 1 dimension per agent when agents >= dimensions", () => {
  const result = assignDimensions(["a", "b", "c", "d", "e", "f"], { lang: "en" });

  assert.equal(result.length, 6);
  assert.equal(result[0].dimensions.length, 1);
  assert.equal(result[0].dimensions[0].id, "security-performance");
  assert.equal(result[4].dimensions.length, 1);
  assert.equal(result[4].dimensions[0].id, "build-scripts");
  assert.equal(result[5].dimensions.length, 1);
  assert.equal(result[5].dimensions[0].id, "security-performance");
});

test("assignDimensions gives all dimensions to single agent", () => {
  const result = assignDimensions(["solo"], { lang: "zh" });

  assert.equal(result.length, 1);
  assert.equal(result[0].dimensions.length, 5);
});

test("assignDimensions returns empty for no agents", () => {
  const result = assignDimensions([]);
  assert.deepEqual(result, []);
});

test("planReview returns structured review plan", () => {
  const plan = planReview(["codex", "claude"], { projectRoot: "/tmp/project", lang: "zh" });

  assert.equal(plan.projectRoot, "/tmp/project");
  assert.equal(plan.agentCount, 2);
  assert.equal(plan.dimensionCount, 5);
  assert.equal(plan.reviewType, "full-project");
  assert.equal(plan.assignments.length, 2);
  assert.ok(plan.assignments[0].dimensions.length >= 2);
  assert.ok(plan.assignments[1].dimensions.length >= 2);
});
