export const SEVERITY_LEVELS = Object.freeze(["blocker", "warning", "info"]);
export const FINDING_PRIORITIES = Object.freeze(["must", "should", "prefer"]);

// Closed vocabulary. Adding a member without giving it a NON_BLOCKING_STATUSES
// entry makes it block, so an unknown disposition can never fail open.
export const FINDING_STATUSES = Object.freeze([
  "open",
  "unchecked",
  "approved_for_fix",
  "deferred",
  "wont_fix",
  "risk_accepted",
  "fixed",
  "verification_failed",
  "verified",
  "dismissed"
]);

// A reviewer reports problems; it does not dispose of them. Dispositions come
// from the human decision artifact, fix states from the fixer, verification
// states from the verifier.
export const REVIEWER_WRITABLE_STATUSES = Object.freeze(["open"]);

// The outcome a reviewer declares for its own review pass — a different axis
// from a finding's status. Closed, and with no default: a review that never
// claimed completion must not be counted as one, because reviewer quorum reads
// this field.
export const REVIEW_ARTIFACT_STATUSES = Object.freeze(["completed", "failed"]);

// Blacklist direction: everything not listed here blocks the gate.
export const NON_BLOCKING_STATUSES = Object.freeze([
  "wont_fix",
  "risk_accepted",
  "dismissed",
  "verified"
]);

// Non-blocking but risk-bearing statuses stay auditable as gate warnings.
export const WARNING_STATUSES = Object.freeze([
  "wont_fix",
  "risk_accepted",
  "dismissed",
  "deferred"
]);

export const DECISION_DISPOSITIONS = Object.freeze([
  "approved_for_fix",
  "wont_fix",
  "deferred",
  "risk_accepted",
  "dismissed"
]);

// approved_for_fix authorizes work rather than accepting risk, so it needs no
// justification; the four terminal dispositions do.
export const DISPOSITIONS_REQUIRING_REASON = Object.freeze([
  "wont_fix",
  "deferred",
  "risk_accepted",
  "dismissed"
]);

// A must-priority finding only clears once a verifier confirmed it or a human
// ruled it invalid. Human waivers (risk_accepted, wont_fix) are deliberately
// excluded: "must" is not negotiable at the decision desk.
export const MUST_CLEARED_STATUSES = Object.freeze(["verified", "dismissed"]);

const SEVERITY_RANK = new Map(
  SEVERITY_LEVELS.map((severity, index) => [severity, SEVERITY_LEVELS.length - index])
);

export function isSeverityLevel(value) {
  return SEVERITY_RANK.has(value);
}

export function isFindingPriority(value) {
  return FINDING_PRIORITIES.includes(value);
}

export function isFindingStatus(value) {
  return FINDING_STATUSES.includes(value);
}

export function isReviewerWritableStatus(value) {
  return REVIEWER_WRITABLE_STATUSES.includes(value);
}

export function isReviewArtifactStatus(value) {
  return REVIEW_ARTIFACT_STATUSES.includes(value);
}

export function isDecisionDisposition(value) {
  return DECISION_DISPOSITIONS.includes(value);
}

export function isBlockingStatus(value) {
  return !NON_BLOCKING_STATUSES.includes(value);
}

export function severityRank(severity) {
  return SEVERITY_RANK.get(severity) ?? 0;
}

export function normalizeFindingKey(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown-finding";
}
