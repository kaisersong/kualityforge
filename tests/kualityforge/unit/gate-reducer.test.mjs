import assert from "node:assert/strict";
import test from "node:test";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";
import { applyReviewMode, asFullProject, bindDecision, withChangeset } from "../helpers/artifact-fixtures.mjs";

test("passes a complete verified manifest", () => {
  const result = reduceQualityGate(withChangeset(bindDecision({
    runId: "qf-run-001",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "claude.md" }
    ],
    fixer: { runnerId: "codex:fixer", artifact: "fix-plan.md" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [
      { id: "QF-001", status: "verified", sourceRunnerId: "codex:r1" },
      { id: "QF-002", status: "wont_fix", sourceRunnerId: "claude:r2" }
    ],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  })));

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
});

test("fails closed when reviewer count is below release policy", () => {
  const result = reduceQualityGate(asFullProject(bindDecision({
    runId: "qf-run-002",
    status: "verified",
    reviewers: [{ runnerId: "codex:r1", status: "completed", artifact: "codex.md" }],
    fixer: { runnerId: "codex:fixer", artifact: "fix-plan.md" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  })));

  assert.equal(result.status, "incomplete");
  assert.equal(result.exitCode, 2);
  assert.match(result.reasons.join("\n"), /reviewer shortage/);
});

// Array occupancy is not review evidence: plain flow only counts completed,
// non-advisory reviewers toward minReviewers.
test("failed reviewers do not satisfy the plain-flow reviewer minimum", () => {
  const manifest = asFullProject(bindDecision({
    runId: "qf-failed-reviewers",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", status: "failed", artifact: "codex.md" },
      { runnerId: "claude:r2", status: "failed", artifact: "claude.md" }
    ],
    verification: { runnerId: "xiaok:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  }));

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /reviewer shortage: expected at least 2, got 0/);
});

test("fails when verifier is the same runner as fixer", () => {
  const result = reduceQualityGate(asFullProject(bindDecision({
    runId: "qf-run-003",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "claude.md" }
    ],
    fixer: { runnerId: "codex:same", artifact: "fix-plan.md" },
    verification: { runnerId: "codex:same", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  })));

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

test("a null policy is treated as the default policy", () => {
  const result = reduceQualityGate(completeManifest("full-project"), null);

  assert.equal(result.status, "passed", result.reasons.join("; "));
});

for (const status of ["cancelled", "test_blocked"]) {
  test(`${status} is a terminal manifest failure`, () => {
    const result = reduceQualityGate({ ...completeManifest("full-project"), status });

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.reasons, [`manifest status is ${status}`]);
  });
}

test("invalid policy shape fails closed before policy truthiness is consumed", () => {
  const result = reduceQualityGate(completeManifest("full-project"), {
    minReviewers: 0,
    requireHumanDecision: "false"
  });

  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
  assert.ok(result.reasons.includes("policy.minReviewers must be an integer greater than or equal to 1"));
  assert.ok(result.reasons.includes("policy.requireHumanDecision must be a boolean"));
});

test("fails closed when required quality principles are missing", () => {
  const result = reduceQualityGate(completeManifest("full-project"), contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /quality principles artifact is required/);
});

test("fails closed when required project context and brief are missing", () => {
  const manifest = completeManifest("changeset");
  manifest.context = {
    ...manifest.context,
    contextManifest: { artifact: "context/context-manifest.json", sha256: hexHash("a") },
    qualityPrinciples: { artifact: "context/quality-principles.json", sha256: hexHash("b") }
  };
  delete manifest.context.projectBrief;

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /project context artifact is required/);
  assert.match(result.reasons.join("\n"), /project brief artifact is required/);
});

for (const cell of [
  {
    name: "quality principles",
    contextKey: "qualityPrinciples",
    policy: { qualityPrinciplesRequired: true },
    reason: /quality principles artifact is required/
  },
  {
    name: "project context",
    contextKey: "projectContext",
    policy: { projectContextRequired: true },
    reason: /project context artifact is required/
  },
  {
    name: "project brief",
    contextKey: "projectBrief",
    policy: { projectBriefRequired: true },
    reason: /project brief artifact is required/
  }
]) {
  test(`fails closed when required ${cell.name} is an empty object`, () => {
    const manifest = completeManifestWithContext("changeset");
    manifest.context[cell.contextKey] = {};

    const result = reduceQualityGate(manifest, { context: cell.policy });

    assert.equal(result.status, "incomplete");
    assert.match(result.reasons.join("\n"), cell.reason);
  });
}

test("projectBriefRequired independently changes the gate conclusion", () => {
  const manifest = completeManifestWithContext("changeset");
  delete manifest.context.projectBrief;

  const optional = reduceQualityGate(manifest, {
    context: {
      projectContextRequired: false,
      projectBriefRequired: false,
      requireReviewerContextProvenance: false
    }
  });
  const required = reduceQualityGate(manifest, {
    context: {
      projectContextRequired: false,
      projectBriefRequired: true,
      requireReviewerContextProvenance: false
    }
  });

  assert.equal(optional.status, "passed", optional.reasons.join("; "));
  assert.equal(required.status, "incomplete");
  assert.match(required.reasons.join("\n"), /project brief artifact is required/);
});

test("default policy requires reviewer context provenance", () => {
  const manifest = completeManifestWithContext("changeset");
  for (const reviewer of manifest.reviewers) {
    delete reviewer.contextProvenance;
  }

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /context provenance is required/);
});

test("fails closed when reviewer provenance has no expected context manifest hash", () => {
  const manifest = completeManifestWithContext("changeset");
  delete manifest.context.contextManifest.sha256;

  const result = reduceQualityGate(manifest, {
    context: { requireReviewerContextProvenance: true }
  });

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /context manifest hash is required for reviewer provenance/);
});

test("rejects unsafe context artifact paths and invalid hashes", () => {
  const manifest = completeManifest("changeset");
  manifest.context = {
    ...manifest.context,
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
  const manifest = completeManifestWithContext("full-project");
  manifest.reviewers[0].contextRead = { project_brief: true };

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /reviewer codex:r1 did not acknowledge context: user_quality_principles/);
});

test("fails closed when reviewer context confidence is low", () => {
  const manifest = completeManifestWithContext("full-project");
  manifest.reviewers[1].contextConfidence = "low";

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /reviewer claude:r2 context confidence is low/);
});

test("requires reviewer context provenance to match context manifest hash", () => {
  const manifest = completeManifestWithContext("full-project");
  manifest.reviewers[0].contextProvenance.contextManifestHash = hexHash("z");

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /reviewer codex:r1 context provenance does not match context manifest/);
});

test("unresolved must finding blocks release even when risk accepted", () => {
  const manifest = completeManifestWithContext("full-project");
  manifest.findings = [
    {
      id: "QF-PRINCIPLE-001",
      type: "quality_principle_violation",
      priority: "must",
      principleId: "independent-verification",
      status: "risk_accepted",
      sourceRunnerId: "codex:r1"
    }
  ];
  bindDecision(manifest);

  const result = reduceQualityGate(manifest, contextRequiredPolicy());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /unresolved must findings: QF-PRINCIPLE-001/);
});

test("advisory scores and induced principle refs do not change the gate", () => {
  const manifest = completeManifest("changeset");
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
  const manifest = completeManifest("changeset");
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
  const manifest = asFullProject(bindDecision({
    runId: "qf-score-advisory",
    status: "verified",
    reviewPolicy: { ...review },
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "reviews/codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "reviews/claude.md" }
    ],
    fixer: { runnerId: "codex:fixer", artifact: "fix-plan.md" },
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
  }));

  const result = reduceQualityGate(manifest, { review: { ...review } });

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.match(result.warnings.join("\n"), /reviewer codex:r1 score 40 below advisory threshold 60/);
});

test("vacuous required reviewer blocks the gate", () => {
  const manifest = completeManifest("full-project");
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
  const manifest = asFullProject(bindDecision({
    runId: "qf-vacuous-advisory",
    status: "verified",
    reviewPolicy: { ...review },
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "reviews/codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "reviews/claude.md", isVacuous: true }
    ],
    fixer: { runnerId: "codex:fixer", artifact: "fix-plan.md" },
    verification: { runnerId: "xiaok:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  }));

  const result = reduceQualityGate(manifest, { review: { ...review } });

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.match(result.warnings.join("\n"), /advisory reviewer claude:r2 produced vacuous output/);
});

test("a dispute over a finding a human already ruled on does not block the gate", () => {
  const manifest = completeManifest("full-project");
  manifest.findings = [
    { id: "QF-001", status: "dismissed", decisionReason: "false positive", sourceRunnerId: "codex:r1" }
  ];
  manifest.verification = {
    runnerId: "claude:verifier",
    status: "disputed",
    artifact: "verify.md",
    coveredFindingIds: ["QF-001"],
    uncoveredOpenFindingIds: [],
    disputedFindings: ["QF-001"]
  };
  bindDecision(manifest);

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.match(result.warnings.join("\n"), /verifier disputed finding QF-001 after a human ruling/);
});

test("a dispute alongside a still-open finding still blocks", () => {
  const manifest = completeManifest("full-project");
  manifest.findings = [
    { id: "QF-001", status: "open", sourceRunnerId: "codex:r1" },
    { id: "QF-002", status: "dismissed", decisionReason: "false positive", sourceRunnerId: "claude:r2" }
  ];
  manifest.verification = {
    runnerId: "claude:verifier",
    status: "disputed",
    artifact: "verify.md",
    coveredFindingIds: ["QF-001", "QF-002"],
    uncoveredOpenFindingIds: [],
    disputedFindings: ["QF-002"]
  };
  bindDecision(manifest);

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /unresolved findings: QF-001/);
  assert.doesNotMatch(result.reasons.join("\n"), /QF-002/);
  assert.match(result.warnings.join("\n"), /verifier disputed finding QF-002 after a human ruling/);
});

test("partially_verified verification status blocks the gate", () => {
  const manifest = completeManifest("full-project");
  manifest.verification = { runnerId: "claude:verifier", status: "partially_verified", artifact: "verify.md" };
  manifest.findings = [];

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /partially_verified/);
});

test("cannot_verify verification status blocks the gate", () => {
  const manifest = completeManifest("full-project");
  manifest.verification = { runnerId: "claude:verifier", status: "cannot_verify", artifact: "verify.md" };
  manifest.findings = [];

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /cannot_verify/);
});

function completeManifest(mode) {
  return applyReviewMode(
    bindDecision({
      runId: "qf-run-complete",
      status: "verified",
      reviewers: [
        { runnerId: "codex:r1", status: "completed", artifact: "reviews/codex.md" },
        { runnerId: "claude:r2", status: "completed", artifact: "reviews/claude.md" }
      ],
      fixer: { runnerId: "codex:fixer", artifact: "fix-plan.md" },
      verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
      findings: [],
      requiredChecks: [{ name: "npm test", status: "passed" }]
    }),
    mode
  );
}

function completeManifestWithContext(mode) {
  const contextManifestHash = hexHash("a");
  const manifest = completeManifest(mode);
  manifest.context = {
    ...manifest.context,
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

test("records a warning when no fix was ever recorded", () => {
  const result = reduceQualityGate(withChangeset(bindDecision({
    runId: "qf-no-fix",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "claude.md" }
    ],
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [{ id: "QF-001", status: "verified", sourceRunnerId: "codex:r1" }],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  })));

  assert.equal(result.status, "passed");
  assert.match(result.warnings.join("\n"), /verifier independence not applicable: no fix recorded/);
});

test("blocks when fix evidence exists but no fixer was recorded", () => {
  for (const status of ["fixed", "verification_failed"]) {
    const result = reduceQualityGate(withChangeset(bindDecision({
      runId: "qf-orphan-fix",
      status: "verified",
      reviewers: [
        { runnerId: "codex:r1", status: "completed", artifact: "codex.md" },
        { runnerId: "claude:r2", status: "completed", artifact: "claude.md" }
      ],
      verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
      findings: [{ id: "QF-001", status, sourceRunnerId: "codex:r1" }],
      requiredChecks: [{ name: "npm test", status: "passed" }]
    })));

    assert.equal(result.status, "incomplete", status);
    assert.match(
      result.reasons.join("\n"),
      /fix evidence present but no fixer record: verifier independence unprovable/,
      status
    );
  }
});

test("does not warn about independence when a fixer is recorded", () => {
  const result = reduceQualityGate(withChangeset(bindDecision({
    runId: "qf-with-fixer",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "claude.md" }
    ],
    fixer: { runnerId: "codex:fixer", artifact: "fix-plan.md" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  })));

  assert.equal(result.status, "passed");
  assert.deepEqual(result.warnings, []);
});
