import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reduceQualityGate, validateManifestShape } from "../../../src/core/gate-reducer.mjs";
import { MANIFEST_STATUSES } from "../../../src/core/manifest-status.mjs";
import { asFullProject, bindDecision } from "../helpers/artifact-fixtures.mjs";

// One case per field read point in gate-reducer.mjs / review-policy.mjs. A field
// list in prose keeps claiming to be exhaustive and keeps being wrong; a matrix
// of failing cases cannot make that claim.
// Declared full-project once for the whole file: none of these cases is about the
// frozen changeset, and that mode's own context requirements are satisfied below.
function validManifest(overrides = {}) {
  return asFullProject(bindDecision({
    runId: "shape-run",
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

test("the shape matrix baseline passes the gate", () => {
  const result = reduceQualityGate(validManifest());
  assert.equal(result.status, "passed", result.reasons.join("; "));
});

test("runtime manifest status vocabulary exactly matches the schema enum", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schemas", "manifest.schema.json"), "utf8")
  );

  assert.equal(MANIFEST_STATUSES.length, 13);
  assert.deepEqual([...MANIFEST_STATUSES], schema.properties.status.enum);
});

test("unknown manifest status is a deterministic shape error", () => {
  const manifest = validManifest({ status: "completed" });
  const expected = `status must be one of ${MANIFEST_STATUSES.join(", ")}`;

  assert.deepEqual(validateManifestShape(manifest), [expected]);
  const result = reduceQualityGate(manifest);
  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.reasons, [expected]);
});

const CASES = [
  {
    what: "reviewers[i] is null",
    manifest: { reviewers: [null, { runnerId: "b", artifact: "b.md", status: "completed" }] },
    error: "reviewers[0] must be an object"
  },
  {
    what: "reviewers[i].runnerId is missing",
    manifest: { reviewers: [{}, {}] },
    error: "reviewers[0].runnerId must be a non-empty string"
  },
  {
    what: "reviewers[i].artifact is missing",
    manifest: { reviewers: [{ runnerId: "a", status: "completed" }] },
    error: "reviewers[0].artifact must be a non-empty string"
  },
  {
    what: "reviewers[i].status is missing",
    manifest: { reviewers: [{ runnerId: "a", artifact: "a.md" }] },
    error: "reviewers[0].status must be a non-empty string"
  },
  {
    what: "reviewers[i].role is outside the vocabulary",
    manifest: {
      reviewers: [{ runnerId: "a", artifact: "a.md", status: "completed", role: "observer" }]
    },
    error: "reviewers[0].role must be one of required, advisory"
  },
  {
    what: "reviewers[i].isVacuous is a string",
    manifest: {
      reviewers: [{ runnerId: "a", artifact: "a.md", status: "completed", isVacuous: "false" }]
    },
    error: "reviewers[0].isVacuous must be a boolean"
  },
  {
    what: "reviewers[i].runnerId repeats",
    manifest: {
      reviewers: [
        { runnerId: "a", artifact: "a.md", status: "completed" },
        { runnerId: "a", artifact: "b.md", status: "completed" }
      ]
    },
    error: "reviewers[1].runnerId duplicates reviewer a"
  },
  {
    what: "reviewers[i].artifact repeats",
    manifest: {
      reviewers: [
        { runnerId: "a", artifact: "shared.md", status: "completed" },
        { runnerId: "b", artifact: "shared.md", status: "completed" }
      ]
    },
    error: 'reviewers[1].artifact "shared.md" is already claimed by reviewer "a"'
  },
  {
    what: "findings[i].id is missing",
    manifest: { findings: [{ status: "open" }] },
    error: "findings[0].id must be a non-empty string"
  },
  {
    what: "findings[i].id repeats",
    manifest: {
      findings: [
        { id: "QF-001", status: "open", sourceRunnerId: "codex:gpt-5" },
        { id: "QF-001", status: "open", sourceRunnerId: "claude:sonnet" }
      ]
    },
    error: "findings[1].id duplicates finding QF-001"
  },
  {
    what: "findings[i].sourceRunnerIds holds a non-string",
    manifest: { findings: [{ id: "QF-001", status: "open", sourceRunnerIds: [42] }] },
    error: "findings[0].sourceRunnerIds[0] must be a non-empty string"
  },
  {
    what: "requiredChecks[i] is null",
    manifest: { requiredChecks: [null] },
    error: "requiredChecks[0] must be an object"
  },
  {
    what: "requiredChecks[i].name is missing",
    manifest: { requiredChecks: [{ status: "passed" }] },
    error: "requiredChecks[0].name must be a non-empty string"
  },
  {
    what: "requiredChecks[i].status is missing",
    manifest: { requiredChecks: [{ name: "npm test" }] },
    error: "requiredChecks[0].status must be a non-empty string"
  },
  {
    what: "verification.runnerId is missing",
    manifest: { verification: { status: "verified", artifact: "verify.md" } },
    error: "verification.runnerId must be a non-empty string"
  },
  {
    what: "verification.status is missing",
    manifest: { verification: { runnerId: "v", artifact: "verify.md" } },
    error: "verification.status must be a non-empty string"
  },
  {
    what: "verification.artifact is missing",
    manifest: { verification: { runnerId: "v", status: "verified" } },
    error: "verification.artifact must be a non-empty string"
  },
  {
    what: "fixer.runnerId is missing",
    manifest: { fixer: { artifact: "fix-plan.md" } },
    error: "fixer.runnerId must be a non-empty string"
  },
  {
    what: "fixer.artifact is missing",
    manifest: { fixer: { runnerId: "codex:fixer" } },
    error: "fixer.artifact must be a non-empty string"
  },
  {
    what: "reviewerScores.scores[i] is null",
    manifest: { reviewerScores: { artifact: "scores.json", scores: [null] } },
    error: "reviewerScores.scores[0] must be an object"
  },
  {
    what: "reviewOutcomes[i] is null",
    manifest: { reviewOutcomes: [null] },
    error: "reviewOutcomes[0] must be an object"
  },
  {
    what: "reviewOutcomes[i].runnerId is missing",
    manifest: { reviewOutcomes: [{ status: "succeeded" }] },
    error: "reviewOutcomes[0].runnerId must be a non-empty string"
  }
];

for (const { what, manifest, error } of CASES) {
  test(`shape validation rejects a manifest where ${what}`, () => {
    const errors = validateManifestShape(validManifest(manifest));
    assert.ok(
      errors.includes(error),
      `expected "${error}" among:\n${errors.join("\n")}`
    );

    const result = reduceQualityGate(validManifest(manifest));
    assert.equal(result.status, "invalid_artifact");
    assert.equal(result.exitCode, 1);
  });
}

test("an empty reviewer object no longer counts toward the reviewer quorum", () => {
  const forged = {
    runId: "forged",
    status: "verified",
    reviewers: [{}, {}],
    humanDecision: {},
    verification: { status: "verified" },
    findings: [],
    requiredChecks: [{ name: "t", status: "passed" }]
  };
  const result = reduceQualityGate(forged);
  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
});

test("humanDecision must carry its owner and status once it exists", () => {
  const manifest = validManifest();
  manifest.humanDecision = {};
  const errors = validateManifestShape(manifest);
  assert.ok(errors.includes("humanDecision.artifact must be a non-empty string"), errors.join("\n"));
  assert.ok(errors.includes("humanDecision.owner must be a non-empty string"), errors.join("\n"));
  assert.ok(errors.includes("humanDecision.status must be a non-empty string"), errors.join("\n"));
});

test("an unparsed decision is a gate outcome, not a shape error", () => {
  const manifest = validManifest();
  manifest.humanDecision = { artifact: "decision.md", owner: "kai", status: "unparsed" };
  assert.deepEqual(validateManifestShape(manifest), []);

  const result = reduceQualityGate(manifest);
  assert.equal(result.status, "incomplete");
  assert.equal(result.exitCode, 2);
  assert.match(result.reasons.join("\n"), /human decision artifact is unparsed/);
});

test("a parsed decision must carry its replay-protection binding", () => {
  const manifest = validManifest();
  manifest.humanDecision = { artifact: "decision.md", owner: "kai", status: "parsed" };
  const errors = validateManifestShape(manifest);
  assert.ok(errors.includes("humanDecision.runId must be a non-empty string"), errors.join("\n"));
  assert.ok(errors.includes("humanDecision.decidedAt must be a non-empty string"), errors.join("\n"));
  assert.ok(
    errors.includes("humanDecision.findingSetDigest must be a sha256:<hex> digest"),
    errors.join("\n")
  );
});

test("a malformed findingSetDigest is rejected at the shape layer", () => {
  const manifest = validManifest();
  manifest.humanDecision.findingSetDigest = "sha256:nothex";
  const errors = validateManifestShape(manifest);
  assert.ok(
    errors.includes("humanDecision.findingSetDigest must be a sha256:<hex> digest"),
    errors.join("\n")
  );
});

test("a missing verification stays an incomplete gate rather than an invalid artifact", () => {
  const manifest = validManifest();
  delete manifest.verification;
  assert.deepEqual(validateManifestShape(manifest), []);

  const result = reduceQualityGate(manifest);
  assert.equal(result.status, "incomplete");
  assert.equal(result.exitCode, 2);
  assert.match(result.reasons.join("\n"), /verification artifact is required/);
});

test("an incomplete fixer can no longer slip past the independence check", () => {
  const manifest = validManifest({ fixer: { artifact: "fix-plan.md" } });
  const result = reduceQualityGate(manifest);
  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
});
