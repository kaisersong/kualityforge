import { readFile } from "node:fs/promises";
import { DEFAULT_RELEASE_POLICY } from "./gate-reducer.mjs";

export function normalizePolicy(policy = {}) {
  const normalized = {
    profile: policy.profile || "release",
    ...DEFAULT_RELEASE_POLICY,
    ...policy,
    minReviewersExplicit: Object.prototype.hasOwnProperty.call(policy, "minReviewers"),
    context: {
      ...DEFAULT_RELEASE_POLICY.context,
      ...(policy.context || {})
    }
  };
  if (policy.review !== undefined) {
    normalized.review = policy.review;
  }
  return normalized;
}

export async function loadPolicyFile(policyPath) {
  if (!policyPath || typeof policyPath !== "string") {
    throw new Error("policyPath is required");
  }

  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  return normalizePolicy(policy);
}
