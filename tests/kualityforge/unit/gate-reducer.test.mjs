import assert from "node:assert/strict";
import test from "node:test";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";

test("passes a complete verified manifest", () => {
  const result = reduceQualityGate({
    runId: "qf-run-001",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", artifact: "codex.md" },
      { runnerId: "claude:r2", artifact: "claude.md" }
    ],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:fixer" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [
      { id: "QF-001", status: "verified" },
      { id: "QF-002", status: "wont_fix" }
    ],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  });

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
});

test("fails closed when reviewer count is below release policy", () => {
  const result = reduceQualityGate({
    runId: "qf-run-002",
    status: "verified",
    reviewers: [{ runnerId: "codex:r1", artifact: "codex.md" }],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:fixer" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.exitCode, 2);
  assert.match(result.reasons.join("\n"), /reviewer shortage/);
});

test("fails when verifier is the same runner as fixer", () => {
  const result = reduceQualityGate({
    runId: "qf-run-003",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", artifact: "codex.md" },
      { runnerId: "claude:r2", artifact: "claude.md" }
    ],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:same" },
    verification: { runnerId: "codex:same", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  });

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /independent/);
});

test("rejects invalid manifest shape", () => {
  const result = reduceQualityGate({
    status: "verified",
    reviewers: [],
    findings: [],
    requiredChecks: []
  });

  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
  assert.match(result.reasons.join("\n"), /runId is required/);
});
