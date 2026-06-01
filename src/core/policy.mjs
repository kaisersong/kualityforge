import { readFile } from "node:fs/promises";
import { DEFAULT_RELEASE_POLICY } from "./gate-reducer.mjs";

export function normalizePolicy(policy = {}) {
  return {
    profile: policy.profile || "release",
    ...DEFAULT_RELEASE_POLICY,
    ...policy
  };
}

export async function loadPolicyFile(policyPath) {
  if (!policyPath || typeof policyPath !== "string") {
    throw new Error("policyPath is required");
  }

  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  return normalizePolicy(policy);
}
