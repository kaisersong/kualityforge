import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPolicyFile, normalizePolicy } from "../../../src/core/policy.mjs";

test("normalizePolicy merges project settings with release defaults", () => {
  const policy = normalizePolicy({
    profile: "release",
    minReviewers: 3,
    requireIndependentVerifier: false
  });

  assert.equal(policy.profile, "release");
  assert.equal(policy.minReviewers, 3);
  assert.equal(policy.requireHumanDecision, true);
  assert.equal(policy.requireRequiredChecks, true);
  assert.equal(policy.requireIndependentVerifier, false);
});

test("loadPolicyFile reads .kualityfore.json style policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityfore-policy-"));
  try {
    const policyPath = join(root, ".kualityfore.json");
    await writeFile(
      policyPath,
      JSON.stringify({ profile: "smoke", minReviewers: 1 }, null, 2),
      "utf8"
    );

    const policy = await loadPolicyFile(policyPath);

    assert.equal(policy.profile, "smoke");
    assert.equal(policy.minReviewers, 1);
    assert.equal(policy.requireHumanDecision, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
