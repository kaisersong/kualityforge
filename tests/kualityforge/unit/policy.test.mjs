import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPolicyFile, normalizePolicy } from "../../../src/core/policy.mjs";
import { validatePolicyShape } from "../../../src/core/policy-shape.mjs";

for (const [name, input] of [
  ["null", null],
  ["undefined", undefined],
  ["an empty object", {}]
]) {
  test(`normalizePolicy accepts ${name} as an empty policy`, () => {
    const policy = normalizePolicy(input);

    assert.equal(policy.profile, "release");
    assert.equal(policy.minReviewers, 2);
    assert.ok(policy.context && typeof policy.context === "object");
  });
}

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

test("normalizePolicy preserves context requirements", () => {
  const policy = normalizePolicy({
    context: {
      projectContextRequired: true,
      qualityPrinciplesRequired: true,
      requiredReviewerContextAck: ["user_quality_principles", "project_brief"]
    }
  });

  assert.equal(policy.context.projectContextRequired, true);
  assert.equal(policy.context.qualityPrinciplesRequired, true);
  assert.deepEqual(policy.context.requiredReviewerContextAck, [
    "user_quality_principles",
    "project_brief"
  ]);
  assert.equal(policy.context.projectBriefRequired, true);
  assert.equal(policy.context.requireReviewerContextProvenance, true);
});

test("policy schema declares projectBriefRequired as a boolean", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schemas", "policy.schema.json"), "utf8")
  );

  assert.equal(schema.properties.context.properties.projectBriefRequired.type, "boolean");
});

for (const [label, policy, expected] of [
  ["array root", [], "policy must be a plain object"],
  ["zero minReviewers", { minReviewers: 0 }, "policy.minReviewers must be an integer greater than or equal to 1"],
  ["negative minReviewers", { minReviewers: -1 }, "policy.minReviewers must be an integer greater than or equal to 1"],
  ["fractional minReviewers", { minReviewers: 1.5 }, "policy.minReviewers must be an integer greater than or equal to 1"],
  ["string minReviewers", { minReviewers: "2" }, "policy.minReviewers must be an integer greater than or equal to 1"],
  ["NaN minReviewers", { minReviewers: Number.NaN }, "policy.minReviewers must be an integer greater than or equal to 1"],
  ["string top-level boolean", { requireRequiredChecks: "false" }, "policy.requireRequiredChecks must be a boolean"],
  ["array context", { context: [] }, "policy.context must be a plain object"],
  ["string context boolean", { context: { projectBriefRequired: "false" } }, "policy.context.projectBriefRequired must be a boolean"],
  ["invalid review", { review: {} }, "policy.review.mode must be one of required_all|quorum, got undefined"]
]) {
  test(`validatePolicyShape rejects ${label}`, () => {
    assert.ok(validatePolicyShape(policy).includes(expected));
  });
}

test("loadPolicyFile returns invalid shape for the reducer to reject", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-invalid-policy-"));
  try {
    const policyPath = join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({ minReviewers: 0 }), "utf8");

    const policy = await loadPolicyFile(policyPath);
    assert.ok(validatePolicyShape(policy).includes(
      "policy.minReviewers must be an integer greater than or equal to 1"
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadPolicyFile reads .kualityforge.json style policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-policy-"));
  try {
    const policyPath = join(root, ".kualityforge.json");
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
