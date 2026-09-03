import assert from "node:assert/strict";
import test from "node:test";
import { runDeterministicEvalCases } from "../../../src/core/eval-runner.mjs";
import { bindDecision, withChangeset } from "../helpers/artifact-fixtures.mjs";

test("runDeterministicEvalCases reports pass/fail metrics", () => {
  const result = runDeterministicEvalCases([
    {
      name: "pass case",
      manifest: withChangeset(bindDecision({
        runId: "case-1",
        status: "verified",
        reviewers: [
          { runnerId: "codex", status: "completed", artifact: "reviews/codex.md" },
          { runnerId: "claude", status: "completed", artifact: "reviews/claude.md" }
        ],
        verification: { runnerId: "verifier", status: "verified", artifact: "verify.md" },
        findings: [],
        requiredChecks: [{ name: "npm test", status: "passed" }]
      })),
      expected: { status: "passed", exitCode: 0 }
    }
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.total, 1);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 0);
});

test("runDeterministicEvalCases fails when expected result differs", () => {
  const result = runDeterministicEvalCases([
    {
      name: "mismatch",
      manifest: {
        runId: "case-2",
        status: "open",
        reviewers: [],
        findings: [],
        requiredChecks: []
      },
      expected: { status: "passed", exitCode: 0 }
    }
  ]);

  assert.equal(result.status, "failed");
  assert.equal(result.total, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.cases[0].actual.status, "incomplete");
});
