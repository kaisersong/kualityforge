import assert from "node:assert/strict";
import test from "node:test";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";
import { asFullProject, bindDecision } from "../helpers/artifact-fixtures.mjs";

// Declared full-project once for the whole file: required checks are orthogonal to the
// frozen changeset, and that mode's own context requirements are satisfied below.
function manifest(overrides = {}) {
  return asFullProject(bindDecision({
    runId: "checks-run",
    status: "verified",
    reviewers: [
      { runnerId: "codex:gpt-5", artifact: "reviews/codex.md", status: "completed" },
      { runnerId: "claude:sonnet", artifact: "reviews/claude.md", status: "completed" }
    ],
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }],
    ...overrides
  }));
}

test("an empty requiredChecks array no longer satisfies requireRequiredChecks", () => {
  const result = reduceQualityGate(manifest({ requiredChecks: [] }));
  assert.equal(result.status, "incomplete");
  assert.equal(result.exitCode, 2);
  assert.match(result.reasons.join("\n"), /requiredChecks is empty while requireRequiredChecks is enabled/);
});

test("a project without checks opts out explicitly instead of passing on no evidence", () => {
  const result = reduceQualityGate(manifest({ requiredChecks: [] }), {
    requireRequiredChecks: false
  });
  assert.equal(result.status, "passed", result.reasons.join("; "));
});

test("a failed check still blocks alongside the emptiness rule", () => {
  const result = reduceQualityGate(manifest({ requiredChecks: [{ name: "npm test", status: "failed" }] }));
  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /required checks not passed: npm test/);
  assert.doesNotMatch(result.reasons.join("\n"), /requiredChecks is empty/);
});
