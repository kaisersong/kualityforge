import assert from "node:assert/strict";
import test from "node:test";
import {
  findArtifactNameCollisions,
  validateArtifactReferences,
  validateManifestShape
} from "../../../src/core/gate-reducer.mjs";
import { normalizeArtifactKey } from "../../../src/core/artifact-operations.mjs";

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

test("normalizeArtifactKey folds separator and case differences", () => {
  const expected = normalizeArtifactKey("reviews/a.md");
  for (const variant of ["reviews\\a.md", "reviews/A.md", "reviews//a.md", "./reviews/a.md"]) {
    assert.equal(normalizeArtifactKey(variant), expected, variant);
  }
  assert.notEqual(normalizeArtifactKey("reviews/b.md"), expected);
});

test("findArtifactNameCollisions returns errors instead of throwing", () => {
  const errors = findArtifactNameCollisions([
    { runnerId: "codex:gpt-5", artifact: "reviews/codex-gpt-5.md" },
    { runnerId: "codex/gpt-5", artifact: "reviews/other.md" }
  ]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /collides with "codex:gpt-5"/);
});

test("findArtifactNameCollisions reports a runner id that sanitizes to an empty name", () => {
  const errors = findArtifactNameCollisions([{ runnerId: "!!!", artifact: "reviews/x.md" }]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /empty artifact name/);
});

test("validateManifestShape rejects colliding runner ids without throwing", () => {
  const errors = validateManifestShape({
    runId: "collision",
    status: "verified",
    reviewers: [
      { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex-gpt-5.md" },
      { runnerId: "codex/gpt-5", status: "completed", artifact: "reviews/other.md" }
    ],
    findings: [],
    requiredChecks: []
  });

  assert.match(errors.join("\n"), /collides with "codex:gpt-5"/);
});

test("validateManifestShape rejects one artifact path claimed twice in different spellings", () => {
  for (const variant of ["reviews\\a.md", "reviews/A.md"]) {
    const errors = validateManifestShape({
      runId: "duplicate-path",
      status: "verified",
      reviewers: [
        { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/a.md" },
        { runnerId: "claude:sonnet", status: "completed", artifact: variant }
      ],
      findings: [],
      requiredChecks: []
    });

    assert.match(errors.join("\n"), /already claimed by reviewer "codex:gpt-5"/, variant);
  }
});
