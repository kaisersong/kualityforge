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
