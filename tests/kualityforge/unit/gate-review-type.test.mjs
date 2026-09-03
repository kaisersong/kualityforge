import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";
import { asFullProject, bindDecision, withChangeset } from "../helpers/artifact-fixtures.mjs";

// The reviewType branches read no policy key on purpose: the whole value of this
// criterion is that a policy override cannot switch it off. Every cell below therefore
// runs on the default policy unless it is specifically about a policy key.

test("a manifest that declares no reviewType is judged as changeset mode and needs a freeze", () => {
  const result = reduceQualityGate(baseManifest());

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /changeset/);
});

// The reference exists whenever a project root does, so a truthiness check on it would
// see a run whose freeze failed and let it through.
test("changeset mode blocks a freeze that reported itself unavailable", () => {
  const result = reduceQualityGate(withChangeset(baseManifest(), { available: false }));

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /changeset/);
});

test("changeset mode blocks a changeset whose availability was never derived", () => {
  const manifest = baseManifest();
  manifest.context = {
    changeset: { artifact: "context/changeset.json", sha256: "a".repeat(64) }
  };

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /changeset/);
});

test("changeset mode passes on a freeze that succeeded", () => {
  const result = reduceQualityGate(withChangeset(baseManifest()));

  assert.equal(result.status, "passed", result.reasons.join("; "));
  assert.equal(result.exitCode, 0);
});

// A freeze can contain bytes while the host git configuration was not fully neutralized.
// Availability alone is therefore insufficient evidence of deterministic input.
test("changeset mode blocks a freeze captured under degraded git isolation", () => {
  const manifest = withChangeset(baseManifest());
  manifest.context.changeset.deterministicEnvDegraded = true;

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /deterministic git isolation degraded/);
});

test("a policy that names no context requirement still cannot switch the freeze check off", () => {
  const result = reduceQualityGate(baseManifest(), {
    minReviewers: 2,
    requireHumanDecision: true,
    requireRequiredChecks: false,
    requireIndependentVerifier: false,
    context: {}
  });

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /changeset/);
});

test("full-project mode needs no frozen changeset", () => {
  const result = reduceQualityGate(asFullProject(baseManifest()));

  assert.equal(result.status, "passed", result.reasons.join("; "));
  assert.equal(result.exitCode, 0);
});

// full-project is an explicit mode switch, not a way to shed the evidence requirement:
// what it swaps in is a context pack it must actually have.
test("full-project mode blocks when it declares no context at all", () => {
  const manifest = baseManifest();
  manifest.reviewType = "full-project";

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /projectContext|projectBrief/);
});

test("full-project mode blocks when projectContext is missing", () => {
  const manifest = asFullProject(baseManifest());
  delete manifest.context.projectContext;

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /projectContext/);
});

test("full-project mode blocks when projectBrief is missing", () => {
  const manifest = asFullProject(baseManifest());
  delete manifest.context.projectBrief;

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /projectBrief/);
});

// The reverse test for the whole branch: nothing on the review path writes a quality
// principles artifact, so requiring it unconditionally would reject every honest
// full-project run. Only this cell can tell that apart from a working criterion.
test("full-project mode passes when qualityPrinciples is absent under the default policy", () => {
  const manifest = asFullProject(baseManifest());
  manifest.context.qualityPrinciples = null;

  const result = reduceQualityGate(manifest);

  assert.equal(result.status, "passed", result.reasons.join("; "));
});

// Dropping it from the unconditional set changes the default only. A project that does
// carry quality principles still needs a switch that says "inject them every run".
test("qualityPrinciplesRequired still blocks a full-project run that has no quality principles", () => {
  const manifest = asFullProject(baseManifest());
  manifest.context.qualityPrinciples = null;

  const result = reduceQualityGate(manifest, {
    minReviewers: 2,
    requireHumanDecision: true,
    requireRequiredChecks: false,
    requireIndependentVerifier: false,
    context: { qualityPrinciplesRequired: true }
  });

  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /quality principles/i);
});

// The default is a gate criterion, not a schema `required`, so an absent field has to
// stay schema-valid while the reducer still treats it as changeset mode.
test("manifest schema declares reviewType as an optional two-value enum", async () => {
  const schema = JSON.parse(
    await readFile(join(process.cwd(), "schemas", "manifest.schema.json"), "utf8")
  );

  assert.deepEqual(schema.properties.reviewType.enum, ["changeset", "full-project"]);
  assert.equal(schema.required.includes("reviewType"), false);
});

function baseManifest() {
  return bindDecision({
    runId: "qf-review-type",
    status: "verified",
    reviewers: [
      { runnerId: "codex:r1", status: "completed", artifact: "reviews/codex.md" },
      { runnerId: "claude:r2", status: "completed", artifact: "reviews/claude.md" }
    ],
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }]
  });
}
