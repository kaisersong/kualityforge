import { evaluateReviewPolicy, isReviewPolicyEnabled } from "./review-policy.mjs";

export const DEFAULT_RELEASE_POLICY = Object.freeze({
  minReviewers: 2,
  requireHumanDecision: true,
  requireRequiredChecks: true,
  requireIndependentVerifier: true,
  context: Object.freeze({
    projectContextRequired: false,
    qualityPrinciplesRequired: false,
    requiredReviewerContextAck: Object.freeze([]),
    requireReviewerContextProvenance: false
  })
});

const TERMINAL_FAILURE_STATUSES = new Set([
  "failed",
  "invalid_artifact",
  "verification_failed"
]);

export function validateManifestShape(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest must be an object"];
  }

  if (!manifest.runId || typeof manifest.runId !== "string") {
    errors.push("runId is required");
  }

  if (!manifest.status || typeof manifest.status !== "string") {
    errors.push("status is required");
  }

  if (!Array.isArray(manifest.reviewers)) {
    errors.push("reviewers must be an array");
  }

  if (!Array.isArray(manifest.findings)) {
    errors.push("findings must be an array");
  }

  if (!Array.isArray(manifest.requiredChecks)) {
    errors.push("requiredChecks must be an array");
  }

  return [...errors, ...validateArtifactReferences(manifest), ...validateContextArtifacts(manifest)];
}

export function validateArtifactReferences(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [];
  }

  const errors = [];
  for (const [index, reviewer] of (manifest.reviewers || []).entries()) {
    if (reviewer.artifact && !isSafeArtifactPath(reviewer.artifact)) {
      errors.push(`reviewers[${index}].artifact must stay within artifact root`);
    }
  }

  if (manifest.humanDecision?.artifact && !isSafeArtifactPath(manifest.humanDecision.artifact)) {
    errors.push("humanDecision.artifact must stay within artifact root");
  }

  if (manifest.verification?.artifact && !isSafeArtifactPath(manifest.verification.artifact)) {
    errors.push("verification.artifact must stay within artifact root");
  }

  if (manifest.synthesis?.artifact && !isSafeArtifactPath(manifest.synthesis.artifact)) {
    errors.push("synthesis.artifact must stay within artifact root");
  }

  if (manifest.reviewerScores?.artifact && !isSafeArtifactPath(manifest.reviewerScores.artifact)) {
    errors.push("reviewerScores.artifact must stay within artifact root");
  }

  if (manifest.inducedPrinciples?.artifact && !isSafeArtifactPath(manifest.inducedPrinciples.artifact)) {
    errors.push("inducedPrinciples.artifact must stay within artifact root");
  }

  if (manifest.fixer?.artifact && !isSafeArtifactPath(manifest.fixer.artifact)) {
    errors.push("fixer.artifact must stay within artifact root");
  }

  for (const [index, check] of (manifest.requiredChecks || []).entries()) {
    if (check.log && !isSafeArtifactPath(check.log)) {
      errors.push(`requiredChecks[${index}].log must stay within artifact root`);
    }
  }

  return errors;
}

function validateContextArtifacts(manifest) {
  const errors = [];
  const context = manifest.context;
  if (!context) {
    return errors;
  }

  for (const key of [
    "contextManifest",
    "qualityPrinciples",
    "projectContext",
    "projectBrief",
    "docsIndex",
    "changeset"
  ]) {
    const item = context[key];
    if (!item) {
      continue;
    }

    if (item.artifact && !isSafeArtifactPath(item.artifact)) {
      errors.push(`context.${key}.artifact must stay within artifact root`);
    }

    if (item.sha256 && !isSha256HexDigest(item.sha256)) {
      errors.push(`context.${key}.sha256 must be a sha256 hex digest`);
    }
  }

  return errors;
}

function isSafeArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  return !value.startsWith("/") && !value.split(/[\\/]+/).includes("..");
}

export function reduceQualityGate(manifest, policy = DEFAULT_RELEASE_POLICY) {
  const effectivePolicy = mergePolicy(policy);
  const shapeErrors = validateManifestShape(manifest);
  if (shapeErrors.length > 0) {
    return failure("invalid_artifact", shapeErrors);
  }

  if (TERMINAL_FAILURE_STATUSES.has(manifest.status)) {
    return failure("failed", [`manifest status is ${manifest.status}`]);
  }

  const blockers = [];
  const warnings = [];

  if (isReviewPolicyEnabled(effectivePolicy)) {
    const reviewResult = evaluateReviewPolicy(manifest, effectivePolicy);
    if (reviewResult.invalid) {
      return failure("invalid_artifact", reviewResult.invalid);
    }
    blockers.push(...reviewResult.blockers);
    warnings.push(...reviewResult.warnings);
  } else {
    const reviewerCount = manifest.reviewers.length;
    if (reviewerCount < effectivePolicy.minReviewers) {
      blockers.push(
        `reviewer shortage: expected at least ${effectivePolicy.minReviewers}, got ${reviewerCount}`
      );
    }
  }

  if (effectivePolicy.requireHumanDecision && !manifest.humanDecision) {
    blockers.push("human decision artifact is required");
  }

  const reviewEnabled = isReviewPolicyEnabled(effectivePolicy);
  const requiredReviewerSet = reviewEnabled
    ? new Set(effectivePolicy.review.requiredReviewers || [])
    : null;
  const isAdvisoryFinding = (finding) => {
    if (!reviewEnabled) {
      return false;
    }
    const sources = findingSources(finding);
    if (sources.length === 0) {
      return false;
    }
    return sources.every((runnerId) => !requiredReviewerSet.has(runnerId));
  };

  const openFindings = manifest.findings.filter((finding) => {
    return ["open", "approved_for_fix", "fixed", "verification_failed"].includes(
      finding.status
    );
  });
  const blockingOpenFindings = openFindings.filter((finding) => !isAdvisoryFinding(finding));
  const advisoryOpenFindings = openFindings.filter((finding) => isAdvisoryFinding(finding));
  if (blockingOpenFindings.length > 0) {
    blockers.push(`unresolved findings: ${blockingOpenFindings.map((f) => f.id).join(", ")}`);
  }
  for (const finding of advisoryOpenFindings) {
    warnings.push(`advisory finding (non-blocking): ${finding.id}`);
  }

  const unresolvedMustPrincipleViolations = manifest.findings.filter((finding) => {
    return (
      finding.type === "quality_principle_violation" &&
      finding.priority === "must" &&
      !["verified", "resolved"].includes(finding.status) &&
      !isAdvisoryFinding(finding)
    );
  });
  if (unresolvedMustPrincipleViolations.length > 0) {
    blockers.push(
      `unresolved must quality principle violations: ${unresolvedMustPrincipleViolations
        .map((finding) => finding.id)
        .join(", ")}`
    );
  }

  if (effectivePolicy.requireRequiredChecks) {
    const failedChecks = manifest.requiredChecks.filter((check) => check.status !== "passed");
    if (failedChecks.length > 0) {
      blockers.push(`required checks not passed: ${failedChecks.map((c) => c.name).join(", ")}`);
    }
  }

  if (!manifest.verification) {
    blockers.push("verification artifact is required");
  } else if (manifest.verification.status !== "verified") {
    blockers.push(`verification status is ${manifest.verification.status}`);
  }

  if (
    effectivePolicy.requireIndependentVerifier &&
    manifest.verification &&
    manifest.fixer &&
    manifest.verification.runnerId === manifest.fixer.runnerId
  ) {
    blockers.push("verifier runner must be independent from fixer runner");
  }

  blockers.push(...contextBlockers(manifest, effectivePolicy.context));

  const minReviewerScore = effectivePolicy.review?.minReviewerScore;
  if (typeof minReviewerScore === "number" && Number.isFinite(minReviewerScore)) {
    const inlineScores = Array.isArray(manifest.reviewerScores?.scores)
      ? manifest.reviewerScores.scores
      : [];
    for (const score of inlineScores) {
      if (typeof score.overall === "number" && score.overall < minReviewerScore) {
        warnings.push(
          `reviewer ${score.runnerId} score ${score.overall} below advisory threshold ${minReviewerScore}`
        );
      }
    }
  }

  if (blockers.length > 0) {
    return {
      status: "incomplete",
      exitCode: 2,
      reasons: blockers,
      warnings: [...warnings].sort()
    };
  }

  return {
    status: "passed",
    exitCode: 0,
    reasons: [],
    warnings: [...warnings].sort()
  };
}

function contextBlockers(manifest, contextPolicy) {
  const blockers = [];
  const context = manifest.context;

  if (contextPolicy.qualityPrinciplesRequired && !context?.qualityPrinciples) {
    blockers.push("quality principles artifact is required");
  }

  if (contextPolicy.projectContextRequired && !context?.projectContext) {
    blockers.push("project context artifact is required");
  }

  if (contextPolicy.projectContextRequired && !context?.projectBrief) {
    blockers.push("project brief artifact is required");
  }

  const requiredAck = contextPolicy.requiredReviewerContextAck || [];
  if (requiredAck.length > 0) {
    for (const reviewer of manifest.reviewers) {
      const missing = requiredAck.filter((key) => reviewer.contextRead?.[key] !== true);
      if (missing.length > 0) {
        blockers.push(
          `reviewer ${reviewer.runnerId} did not acknowledge context: ${missing.join(", ")}`
        );
      }
    }
  }

  for (const reviewer of manifest.reviewers) {
    if (reviewer.contextConfidence === "low") {
      blockers.push(`reviewer ${reviewer.runnerId} context confidence is low`);
    }

    if (contextPolicy.requireReviewerContextProvenance) {
      const expectedHash = context?.contextManifest?.sha256;
      const actualHash = reviewer.contextProvenance?.contextManifestHash;
      if (!actualHash) {
        blockers.push(`reviewer ${reviewer.runnerId} context provenance is required`);
      } else if (expectedHash && actualHash !== expectedHash) {
        blockers.push(
          `reviewer ${reviewer.runnerId} context provenance does not match context manifest`
        );
      }
    }
  }

  return blockers;
}

function mergePolicy(policy) {
  return {
    ...DEFAULT_RELEASE_POLICY,
    ...policy,
    context: {
      ...DEFAULT_RELEASE_POLICY.context,
      ...(policy.context || {})
    }
  };
}

function findingSources(finding) {
  const sources = new Set();
  if (typeof finding.sourceRunnerId === "string" && finding.sourceRunnerId.length > 0) {
    sources.add(finding.sourceRunnerId);
  }
  for (const runnerId of Array.isArray(finding.sourceRunnerIds) ? finding.sourceRunnerIds : []) {
    if (typeof runnerId === "string" && runnerId.length > 0) {
      sources.add(runnerId);
    }
  }
  return [...sources];
}

function isSha256HexDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function failure(status, reasons) {
  return {
    status,
    exitCode: 1,
    reasons,
    warnings: []
  };
}
