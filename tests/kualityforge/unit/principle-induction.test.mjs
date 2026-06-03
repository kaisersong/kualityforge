import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inducePrinciples } from "../../../src/core/principle-induction.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "../../../schemas/quality-principles.schema.json");

test("inducePrinciples clusters findings and maps severity to priority", () => {
  const synthesized = [
    { id: "QF-1", type: "code", duplicateKey: "missing-dep", severity: "blocker", reviewerCount: 2 },
    { id: "QF-2", type: "code", duplicateKey: "missing-dep", severity: "warning", reviewerCount: 2 },
    { id: "QF-3", type: "code", duplicateKey: "style", severity: "info", reviewerCount: 1 }
  ];
  const result = inducePrinciples({ synthesizedFindings: synthesized });
  const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
  const depCandidate = result.candidates.find((c) => c.id.includes("missing-dep"));
  assert.equal(depCandidate.priority, "must");
  assert.ok(depCandidate.evidenceRequired.includes("consensus"));
  const styleCandidate = result.candidates.find((c) => c.id.includes("style"));
  assert.equal(styleCandidate.priority, "prefer");
  assert.ok(!styleCandidate.evidenceRequired.includes("consensus"));
  assert.ok(byId.size === result.candidates.length);
});

test("inducePrinciples excludes principles already in the existing set", () => {
  const synthesized = [
    { id: "QF-1", type: "quality_principle_violation", principleId: "P-1", duplicateKey: "x", severity: "blocker", reviewerCount: 1 }
  ];
  const result = inducePrinciples({
    synthesizedFindings: synthesized,
    existingPrinciples: [{ id: "P-1" }]
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.clusters[0].matchedExistingPrincipleId, "P-1");
});

test("inducePrinciples deduplicates candidate ids that normalize to the same slug", () => {
  const synthesized = [
    { id: "QF-1", type: "code", duplicateKey: "foo bar", title: "Foo bar one", severity: "warning", reviewerCount: 1 },
    { id: "QF-2", type: "code", duplicateKey: "foo/bar", title: "Foo bar two", severity: "warning", reviewerCount: 1 }
  ];
  const result = inducePrinciples({ synthesizedFindings: synthesized });
  const ids = result.candidates.map((candidate) => candidate.id);
  assert.equal(new Set(ids).size, ids.length, "candidate ids must be unique");
  assert.ok(ids.some((id) => /-2$/.test(id)), "a colliding id should be suffixed");
});

test("inducePrinciples suffixed ids do not collide with existing principle ids", () => {
  const synthesized = [
    { id: "QF-1", type: "code", duplicateKey: "foo", title: "Foo one", severity: "warning", reviewerCount: 1 },
    { id: "QF-2", type: "code", duplicateKey: "foo", title: "Foo two", severity: "warning", reviewerCount: 1 }
  ];
  const result = inducePrinciples({
    synthesizedFindings: synthesized,
    existingPrinciples: [{ id: "induced-foo-2" }]
  });
  const ids = result.candidates.map((candidate) => candidate.id);
  assert.equal(new Set(ids).size, ids.length, "candidate ids must be unique");
  assert.ok(!ids.includes("induced-foo-2"), "must not reuse an existing principle id");
});

test("induced candidates satisfy the quality-principles schema required fields", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const required = schema.properties.principles.items.required;
  const synthesized = [
    { id: "QF-1", type: "code", duplicateKey: "leak", title: "Resource leak", severity: "warning", reviewerCount: 1 }
  ];
  const result = inducePrinciples({ synthesizedFindings: synthesized });
  assert.ok(result.candidates.length > 0);
  for (const candidate of result.candidates) {
    for (const field of required) {
      assert.ok(candidate[field] !== undefined, `missing ${field}`);
    }
    assert.ok(["must", "should", "prefer"].includes(candidate.priority));
  }
});
