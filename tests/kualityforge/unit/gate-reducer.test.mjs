import assert from "node:assert/strict";
import test from "node:test";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";

test("passes a complete verified manifest", () => {
  const result = reduceQualityGate({
    runId: "qf-run-001",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", artifact: "codex.md" },
      { runnerId: "claude:r2", artifact: "claude.md" }
    ],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:fixer" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [
      { id: "QF-001", status: "verified" },
      { id: "QF-002", status: "wont_fix" }
    ],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  });

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
});

test("fails closed when reviewer count is below release policy", () => {
  const result = reduceQualityGate({
    runId: "qf-run-002",
    status: "verified",
    reviewers: [{ runnerId: "codex:r1", artifact: "codex.md" }],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:fixer" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.exitCode, 2);
  assert.match(result.reasons.join("\n"), /reviewer shortage/);
});

test("fails when verifier is the same runner as fixer", () => {
  const result = reduceQualityGate({
    runId: "qf-run-003",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", artifact: "codex.md" },
      { runnerId: "claude:r2", artifact: "claude.md" }
    ],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:same" },
    verification: { runnerId: "codex:same", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  });

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /independent/);
});

test("rejects invalid manifest shape", () => {
  const result = reduceQualityGate({
    status: "verified",
    reviewers: [],
    findings: [],
    requiredChecks: []
  });

  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
  assert.match(result.reasons.join("\n"), /runId is required/);
});

test("fails closed when required quality principles are missing", () => {
  const result = reduceQualityGate(completeManifest(), contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /quality principles artifact is required/);
});

test("fails closed when required project context and brief are missing", () => {
  const manifest = completeManifest();
  manifest.context = {
    contextManifest: { artifact: "context/context-manifest.json", sha256: hexHash("a") },
    qualityPrinciples: { artifact: "context/quality-principles.json", sha256: hexHash("b") }
  };

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /project context artifact is required/);
  assert.match(result.reasons.join("\n"), /project brief artifact is required/);
});

test("rejects unsafe context artifact paths and invalid hashes", () => {
  const manifest = completeManifest();
  manifest.context = {
    contextManifest: { artifact: "../context-manifest.json", sha256: "not-a-hash" },
    projectContext: { artifact: "context/project-context.json", sha256: hexHash("b") },
    projectBrief: { artifact: "context/project-brief.md", sha256: hexHash("c") }
  };

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "invalid_artifact");
  assert.match(result.reasons.join("\n"), /context.contextManifest.artifact must stay within artifact root/);
  assert.match(result.reasons.join("\n"), /context.contextManifest.sha256 must be a sha256 hex digest/);
});

test("requires reviewers to acknowledge configured context", () => {
  const manifest = completeManifestWithContext();
  manifest.reviewers[0].contextRead = { project_brief: true };

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /reviewer codex:r1 did not acknowledge context: user_quality_principles/);
});

test("fails closed when reviewer context confidence is low", () => {
  const manifest = completeManifestWithContext();
  manifest.reviewers[1].contextConfidence = "low";

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /reviewer claude:r2 context confidence is low/);
});

test("requires reviewer context provenance to match context manifest hash", () => {
  const manifest = completeManifestWithContext();
  manifest.reviewers[0].contextProvenance.contextManifestHash = hexHash("z");

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /reviewer codex:r1 context provenance does not match context manifest/);
});

test("unresolved must quality principle violation blocks release", () => {
  const manifest = completeManifestWithContext();
  manifest.findings = [
    {
      id: "QF-PRINCIPLE-001",
      type: "quality_principle_violation",
      priority: "must",
      principleId: "independent-verification",
      status: "risk_accepted"
    }
  ];

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /unresolved must quality principle violations: QF-PRINCIPLE-001/);
});

test("advisory changeset, scores, and induced principle refs do not change the gate", () => {
  const manifest = completeManifest();
  manifest.context = {
    changeset: { artifact: "context/changeset.json", sha256: hexHash("a") }
  };
  manifest.reviewerScores = {
    artifact: "scores.json",
    status: "completed",
    scores: [{ runnerId: "codex:r1", overall: 88.5 }]
  };
  manifest.inducedPrinciples = { artifact: "induced-principles.json", status: "completed" };

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
});

test("rejects unsafe reviewerScores and inducedPrinciples artifact paths", () => {
  const manifest = completeManifest();
  manifest.reviewerScores = { artifact: "../scores.json" };
  manifest.inducedPrinciples = { artifact: "../induced-principles.json" };

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "invalid_artifact");
  assert.match(result.reasons.join("\n"), /reviewerScores.artifact must stay within artifact root/);
  assert.match(result.reasons.join("\n"), /inducedPrinciples.artifact must stay within artifact root/);
});

test("advisory minReviewerScore only produces a warning, never a blocker", () => {
  const review = {
    mode: "required_all",
    requiredReviewers: ["codex:r1", "claude:r2"],
    minReviewerScore: 60
  };
  const manifest = {
    runId: "qf-score-advisory",
    status: "verified",
    reviewPolicy: { ...review },
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "reviews/codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "reviews/claude.md" }
    ],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:fixer" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }],
    reviewerScores: {
      artifact: "scores.json",
      scores: [
        { runnerId: "codex:r1", overall: 40 },
        { runnerId: "claude:r2", overall: 90 }
      ]
    }
  };

  const result = reduceQualityGate(manifest, { review: { ...review } });

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.match(result.warnings.join("\n"), /reviewer codex:r1 score 40 below advisory threshold 60/);
});

test("vacuous required reviewer blocks the gate", () => {
  const manifest = completeManifest();
  manifest.reviewers[0].isVacuous = true;

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /required reviewer codex:r1 produced vacuous output/);
});

test("vacuous advisory reviewer produces a warning but does not block", () => {
  const review = {
    mode: "required_all",
    requiredReviewers: ["codex:r1"],
    advisoryReviewers: ["claude:r2"]
  };
  const manifest = {
    runId: "qf-vacuous-advisory",
    status: "verified",
    reviewPolicy: { ...review },
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "reviews/codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "reviews/claude.md", isVacuous: true }
    ],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:fixer" },
    verification: { runnerId: "xiaok:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  };

  const result = reduceQualityGate(manifest, { review: { ...review } });

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.match(result.warnings.join("\n"), /advisory reviewer claude:r2 produced vacuous output/);
});

test("dismissed finding does not block the gate", () => {
  const manifest = completeManifest();
  manifest.verification = { runnerId: "claude:verifier", status: "verified_with_dismissals", artifact: "verify.md", dismissedCount: 1 };
  manifest.findings = [
    { id: "QF-001", status: "dismissed", dismissedBy: "claude:verifier" }
  ];

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.match(result.warnings.join("\n"), /dismissed 1 finding/);
});

test("verified_with_dismissals with remaining open finding still blocks", () => {
  const manifest = completeManifest();
  manifest.verification = { runnerId: "claude:verifier", status: "verified_with_dismissals", artifact: "verify.md", dismissedCount: 1 };
  manifest.findings = [
    { id: "QF-001", status: "open" },
    { id: "QF-002", status: "dismissed", dismissedBy: "claude:verifier" }
  ];

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /QF-001/);
  assert.doesNotMatch(result.reasons.join("\n"), /QF-002/);
  assert.match(result.warnings.join("\n"), /dismissed 1 finding/);
});

test("partially_verified verification status blocks the gate", () => {
  const manifest = completeManifest();
  manifest.verification = { runnerId: "claude:verifier", status: "partially_verified", artifact: "verify.md" };
  manifest.findings = [];

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /partially_verified/);
});

test("cannot_verify verification status blocks the gate", () => {
  const manifest = completeManifest();
  manifest.verification = { runnerId: "claude:verifier", status: "cannot_verify", artifact: "verify.md" };
  manifest.findings = [];

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /cannot_verify/);
});

function completeManifest() {
  return {
    runId: "qf-run-complete",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", artifact: "reviews/codex.md" },
      { runnerId: "claude:r2", artifact: "reviews/claude.md" }
    ],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:fixer" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  };
}

function completeManifestWithContext() {
  const contextManifestHash = hexHash("a");
  const manifest = completeManifest();
  manifest.context = {
    contextManifest: { artifact: "context/context-manifest.json", sha256: contextManifestHash },
    qualityPrinciples: { artifact: "context/quality-principles.json", sha256: hexHash("b") },
    projectContext: { artifact: "context/project-context.json", sha256: hexHash("c") },
    projectBrief: { artifact: "context/project-brief.md", sha256: hexHash("d") },
    docsIndex: { artifact: "context/docs-index.json", sha256: hexHash("e") }
  };
  manifest.reviewers = manifest.reviewers.map((reviewer) => ({
    ...reviewer,
    contextRead: {
      user_quality_principles: true,
      project_brief: true
    },
    contextConfidence: "high",
    contextProvenance: {
      contextManifestHash,
      promptContextHash: hexHash("p")
    }
  }));
  return manifest;
}

function contextRequiredPolicy() {
  return {
    minReviewers: 2,
    requireHumanDecision: true,
    requireRequiredChecks: true,
    requireIndependentVerifier: true,
    context: {
      projectContextRequired: true,
      qualityPrinciplesRequired: true,
      requiredReviewerContextAck: ["user_quality_principles", "project_brief"],
      requireReviewerContextProvenance: true
    }
  };
}

function hexHash(seed) {
  return seed.repeat(64).slice(0, 64);
}
