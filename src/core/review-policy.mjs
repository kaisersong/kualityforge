const REVIEW_MODES = new Set(["required_all", "quorum"]);
const OUTCOME_STATUSES = new Set(["succeeded", "failed", "skipped"]);

export function isReviewPolicyEnabled(policy) {
  return Boolean(policy && policy.review && typeof policy.review === "object" && !Array.isArray(policy.review));
}

export function normalizeReviewForCompare(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return null;
  }
  return {
    mode: typeof review.mode === "string" ? review.mode : null,
    requiredReviewers: sortedUnique(review.requiredReviewers),
    quorumMembers: sortedUnique(review.quorumMembers),
    advisoryReviewers: sortedUnique(review.advisoryReviewers),
    quorumMin: Number.isInteger(review.quorumMin) ? review.quorumMin : review.quorumMin ?? null
  };
}

export function validateReviewPolicyShape(review, legacyMinReviewers) {
  const errors = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return ["policy.review must be an object"];
  }

  if (!REVIEW_MODES.has(review.mode)) {
    errors.push(`policy.review.mode must be one of required_all|quorum, got ${stringify(review.mode)}`);
  }

  if (review.minReviewerScore !== undefined && review.minReviewerScore !== null) {
    if (
      typeof review.minReviewerScore !== "number" ||
      !Number.isFinite(review.minReviewerScore) ||
      review.minReviewerScore < 0 ||
      review.minReviewerScore > 100
    ) {
      errors.push("policy.review.minReviewerScore must be a number between 0 and 100");
    }
  }

  const required = review.requiredReviewers;
  const quorumMembers = review.quorumMembers;
  const advisory = review.advisoryReviewers;

  for (const [name, value, optional] of [
    ["requiredReviewers", required, false],
    ["quorumMembers", quorumMembers, review.mode === "quorum" ? false : true],
    ["advisoryReviewers", advisory, true]
  ]) {
    if (value === undefined && optional) {
      continue;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
      errors.push(`policy.review.${name} must be an array of non-empty strings`);
      continue;
    }
    if (hasDuplicates(value)) {
      errors.push(`policy.review.${name} must not contain duplicate runnerIds`);
    }
  }

  // Stop early if structural problems already present; set logic below assumes arrays.
  if (errors.length > 0) {
    return errors;
  }

  const requiredSet = new Set(required);
  const advisorySet = new Set(advisory || []);
  const quorumSet = new Set(quorumMembers || required);
  const knownSet = new Set([...requiredSet, ...advisorySet]);

  for (const runnerId of requiredSet) {
    if (advisorySet.has(runnerId)) {
      errors.push(`policy.review: ${runnerId} cannot be both required and advisory`);
    }
  }

  for (const runnerId of quorumSet) {
    if (!knownSet.has(runnerId)) {
      errors.push(`policy.review.quorumMembers contains unknown reviewer ${runnerId}`);
    }
  }

  for (const runnerId of requiredSet) {
    if (!quorumSet.has(runnerId)) {
      errors.push(`policy.review: required reviewer ${runnerId} must be a quorum member`);
    }
  }

  if (review.mode === "quorum") {
    if (!Number.isInteger(review.quorumMin) || review.quorumMin <= 0) {
      errors.push(`policy.review.quorumMin must be a positive integer, got ${stringify(review.quorumMin)}`);
    } else {
      if (review.quorumMin > quorumSet.size) {
        errors.push(`policy.review.quorumMin (${review.quorumMin}) exceeds quorum member count (${quorumSet.size})`);
      }
      if (review.quorumMin < requiredSet.size) {
        errors.push(`policy.review.quorumMin (${review.quorumMin}) is below required reviewer count (${requiredSet.size})`);
      }
    }
    if (legacyMinReviewers !== undefined && legacyMinReviewers !== null && legacyMinReviewers !== review.quorumMin) {
      errors.push(`policy.minReviewers (${legacyMinReviewers}) conflicts with policy.review.quorumMin (${review.quorumMin})`);
    }
  } else if (review.mode === "required_all") {
    if (legacyMinReviewers !== undefined && legacyMinReviewers !== null && legacyMinReviewers !== requiredSet.size) {
      errors.push(
        `policy.minReviewers (${legacyMinReviewers}) conflicts with required reviewer count (${requiredSet.size}) under required_all`
      );
    }
  }

  return errors;
}

export function evaluateReviewPolicy(manifest, policy) {
  const review = policy.review;
  const legacyMinReviewers = policy.minReviewersExplicit ? policy.minReviewers : null;
  const shapeErrors = validateReviewPolicyShape(review, legacyMinReviewers);
  if (shapeErrors.length > 0) {
    return { invalid: shapeErrors };
  }

  const requiredSet = new Set(review.requiredReviewers);
  const advisorySet = new Set(review.advisoryReviewers || []);
  const quorumSet = new Set(review.quorumMembers || review.requiredReviewers);
  const knownSet = new Set([...requiredSet, ...advisorySet]);

  const errors = [];

  // Manifest echo / drift (B3 source of truth).
  const normalizedPolicyReview = normalizeReviewForCompare(review);
  if (manifest.reviewPolicy === undefined || manifest.reviewPolicy === null) {
    errors.push("manifest.reviewPolicy is required when policy.review is set (echo missing)");
  } else {
    const normalizedManifestReview = normalizeReviewForCompare(manifest.reviewPolicy);
    if (JSON.stringify(normalizedManifestReview) !== JSON.stringify(normalizedPolicyReview)) {
      errors.push("manifest.reviewPolicy drifts from policy.review (echo mismatch)");
    }
  }

  const reviewers = Array.isArray(manifest.reviewers) ? manifest.reviewers : [];

  // Reviewer uniqueness + known-set membership + role spoof.
  const reviewerIds = reviewers.map((reviewer) => reviewer.runnerId);
  if (hasDuplicates(reviewerIds)) {
    errors.push("manifest.reviewers contains duplicate runnerIds");
  }
  const succeededSet = new Set();
  for (const reviewer of reviewers) {
    if (!knownSet.has(reviewer.runnerId)) {
      errors.push(`manifest.reviewers contains unknown reviewer ${reviewer.runnerId}`);
      continue;
    }
    if (reviewer.role !== undefined && reviewer.role !== deriveRole(reviewer.runnerId, requiredSet)) {
      errors.push(`reviewer ${reviewer.runnerId} self-declared role conflicts with policy`);
    }
    if (reviewer.status === undefined || reviewer.status === "completed") {
      succeededSet.add(reviewer.runnerId);
    }
  }

  // Finding role spoof + unknown source (B2).
  for (const finding of Array.isArray(manifest.findings) ? manifest.findings : []) {
    if (finding.sourceRunnerId === undefined || finding.sourceRunnerId === null) {
      continue;
    }
    if (!knownSet.has(finding.sourceRunnerId)) {
      errors.push(`finding ${finding.id || "?"} has unknown sourceRunnerId ${finding.sourceRunnerId}`);
      continue;
    }
    const derived = deriveRole(finding.sourceRunnerId, requiredSet);
    if (finding.sourceReviewerRole !== undefined && finding.sourceReviewerRole !== derived) {
      errors.push(`finding ${finding.id || "?"} self-declared sourceReviewerRole conflicts with policy`);
    }
  }

  // reviewOutcomes consistency (B3). Required for quorum mode.
  const outcomes = manifest.reviewOutcomes;
  if (review.mode === "quorum" || outcomes !== undefined) {
    if (!Array.isArray(outcomes)) {
      errors.push("manifest.reviewOutcomes must be an array when policy.review is set");
    } else {
      const seen = new Set();
      for (const outcome of outcomes) {
        const runnerId = outcome?.runnerId;
        if (!knownSet.has(runnerId)) {
          errors.push(`reviewOutcomes contains unknown reviewer ${stringify(runnerId)}`);
          continue;
        }
        if (seen.has(runnerId)) {
          errors.push(`reviewOutcomes contains duplicate outcome for ${runnerId}`);
          continue;
        }
        seen.add(runnerId);
        if (!OUTCOME_STATUSES.has(outcome.status)) {
          errors.push(`reviewOutcomes[${runnerId}].status must be succeeded|failed|skipped`);
          continue;
        }
        if (outcome.role !== undefined && outcome.role !== deriveRole(runnerId, requiredSet)) {
          errors.push(`reviewOutcomes[${runnerId}].role conflicts with policy`);
        }
        if (outcome.quorumMember !== undefined && outcome.quorumMember !== quorumSet.has(runnerId)) {
          errors.push(`reviewOutcomes[${runnerId}].quorumMember conflicts with policy`);
        }
        if (outcome.status === "succeeded" && !succeededSet.has(runnerId)) {
          errors.push(`reviewOutcomes[${runnerId}] is succeeded but reviewer is not registered`);
        }
        if ((outcome.status === "failed" || outcome.status === "skipped") && succeededSet.has(runnerId)) {
          errors.push(`reviewOutcomes[${runnerId}] is ${outcome.status} but reviewer is registered as completed`);
        }
        if ((outcome.status === "failed" || outcome.status === "skipped") && !nonEmptyString(outcome.absenceReason)) {
          errors.push(`reviewOutcomes[${runnerId}] is ${outcome.status} but absenceReason is missing`);
        }
      }
      for (const runnerId of [...knownSet].sort()) {
        if (!seen.has(runnerId)) {
          errors.push(`reviewOutcomes is missing an entry for expected reviewer ${runnerId}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { invalid: errors.sort() };
  }

  // Decision: required presence + quorum count.
  const blockers = [];
  const warnings = [];

  for (const runnerId of [...requiredSet].sort()) {
    if (!succeededSet.has(runnerId)) {
      blockers.push(`required reviewer missing: ${runnerId}`);
    }
  }

  if (review.mode === "quorum") {
    let quorumSucceeded = 0;
    for (const runnerId of quorumSet) {
      if (succeededSet.has(runnerId)) {
        quorumSucceeded += 1;
      }
    }
    if (quorumSucceeded < review.quorumMin) {
      blockers.push(`quorum shortage: expected at least ${review.quorumMin}, got ${quorumSucceeded}`);
    }
  }

  // Advisory absence warnings (B5). Sorted by runnerId.
  for (const runnerId of [...advisorySet].sort()) {
    if (!succeededSet.has(runnerId)) {
      const outcome = Array.isArray(outcomes) ? outcomes.find((item) => item.runnerId === runnerId) : null;
      const reason = outcome?.absenceReason || "absent";
      warnings.push(`advisory reviewer absent: ${runnerId} (${reason})`);
    }
  }

  return { blockers, warnings, succeededSet };
}

export function deriveRole(runnerId, requiredSet) {
  return requiredSet.has(runnerId) ? "required" : "advisory";
}

function sortedUnique(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value)].sort();
}

function hasDuplicates(value) {
  return Array.isArray(value) && new Set(value).size !== value.length;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringify(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}
