import assert from "node:assert/strict";
import test from "node:test";
import { validateArtifactReferences } from "../../../src/core/gate-reducer.mjs";

test("validateArtifactReferences accepts relative in-root artifacts", () => {
  const errors = validateArtifactReferences({
    reviewers: [{ artifact: "reviews/codex.md" }],
    humanDecision: { artifact: "decision.md" },
    verification: { artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed", log: "checks/npm-test.log" }]
  });

  assert.deepEqual(errors, []);
});

test("validateArtifactReferences rejects path traversal and absolute paths", () => {
  const errors = validateArtifactReferences({
    reviewers: [{ artifact: "../codex.md" }],
    humanDecision: { artifact: "/tmp/decision.md" },
    verification: { artifact: "nested/../../verify.md" },
    findings: [],
    requiredChecks: []
  });

  assert.deepEqual(errors, [
    "reviewers[0].artifact must stay within artifact root",
    "humanDecision.artifact must stay within artifact root",
    "verification.artifact must stay within artifact root"
  ]);
});
