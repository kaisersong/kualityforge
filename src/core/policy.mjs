import { readFile } from "node:fs/promises";
import { DEFAULT_RELEASE_POLICY } from "./policy-shape.mjs";

export function normalizePolicy(policy = {}) {
  const source = policy ?? {};
  const normalized = {
    profile: source.profile || "release",
    ...DEFAULT_RELEASE_POLICY,
    ...source,
    minReviewersExplicit: Object.prototype.hasOwnProperty.call(source, "minReviewers"),
    context: {
      ...DEFAULT_RELEASE_POLICY.context,
      ...(source.context || {})
    }
  };
  if (source.review !== undefined) {
    normalized.review = source.review;
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
