import { validateReviewPolicyShape } from "./review-policy.mjs";

export const DEFAULT_RELEASE_POLICY = Object.freeze({
  minReviewers: 2,
  requireHumanDecision: true,
  requireRequiredChecks: true,
  requireIndependentVerifier: true,
  context: Object.freeze({
    projectContextRequired: false,
    projectBriefRequired: true,
    qualityPrinciplesRequired: false,
    requiredReviewerContextAck: Object.freeze([]),
    requireReviewerContextProvenance: true
  })
});

const TOP_LEVEL_BOOLEAN_FIELDS = Object.freeze([
  "requireHumanDecision",
  "requireRequiredChecks",
  "requireIndependentVerifier"
]);

const CONTEXT_BOOLEAN_FIELDS = Object.freeze([
  "projectContextRequired",
  "projectBriefRequired",
  "qualityPrinciplesRequired",
  "requireReviewerContextProvenance"
]);

export function validatePolicyShape(policy) {
  if (!isPlainObject(policy)) {
    return ["policy must be a plain object"];
  }

  const errors = [];
  if (
    policy.minReviewers !== undefined &&
    (!Number.isInteger(policy.minReviewers) || policy.minReviewers < 1)
  ) {
    errors.push("policy.minReviewers must be an integer greater than or equal to 1");
  }

  for (const field of TOP_LEVEL_BOOLEAN_FIELDS) {
    if (policy[field] !== undefined && typeof policy[field] !== "boolean") {
      errors.push(`policy.${field} must be a boolean`);
    }
  }

  if (policy.context !== undefined) {
    if (!isPlainObject(policy.context)) {
      errors.push("policy.context must be a plain object");
    } else {
      for (const field of CONTEXT_BOOLEAN_FIELDS) {
        if (policy.context[field] !== undefined && typeof policy.context[field] !== "boolean") {
          errors.push(`policy.context.${field} must be a boolean`);
        }
      }
    }
  }

  if (policy.review !== undefined) {
    errors.push(...validateReviewPolicyShape(policy.review, policy.minReviewers));
  }

  return errors;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
