export const DEFAULT_RELEASE_POLICY = Object.freeze({
  minReviewers: 2,
  requireHumanDecision: true,
  requireRequiredChecks: true,
  requireIndependentVerifier: true
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

  return errors;
}

export function reduceQualityGate(manifest, policy = DEFAULT_RELEASE_POLICY) {
  const shapeErrors = validateManifestShape(manifest);
  if (shapeErrors.length > 0) {
    return failure("invalid_artifact", shapeErrors);
  }

  if (TERMINAL_FAILURE_STATUSES.has(manifest.status)) {
    return failure("failed", [`manifest status is ${manifest.status}`]);
  }

  const blockers = [];
  const reviewerCount = manifest.reviewers.length;

  if (reviewerCount < policy.minReviewers) {
    blockers.push(
      `reviewer shortage: expected at least ${policy.minReviewers}, got ${reviewerCount}`
    );
  }

  if (policy.requireHumanDecision && !manifest.humanDecision) {
    blockers.push("human decision artifact is required");
  }

  const openFindings = manifest.findings.filter((finding) => {
    return ["open", "approved_for_fix", "fixed", "verification_failed"].includes(
      finding.status
    );
  });
  if (openFindings.length > 0) {
    blockers.push(`unresolved findings: ${openFindings.map((f) => f.id).join(", ")}`);
  }

  if (policy.requireRequiredChecks) {
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
    policy.requireIndependentVerifier &&
    manifest.verification &&
    manifest.fixer &&
    manifest.verification.runnerId === manifest.fixer.runnerId
  ) {
    blockers.push("verifier runner must be independent from fixer runner");
  }

  if (blockers.length > 0) {
    return {
      status: "incomplete",
      exitCode: 2,
      reasons: blockers
    };
  }

  return {
    status: "passed",
    exitCode: 0,
    reasons: []
  };
}

function failure(status, reasons) {
  return {
    status,
    exitCode: 1,
    reasons
  };
}
