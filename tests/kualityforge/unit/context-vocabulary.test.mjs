import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CONTEXT_ACK_KEYS,
  CONTEXT_DIR,
  CONTEXT_FILES,
  DEFAULT_CONTEXT_ACK_KEYS,
  contextArtifactPath,
  deriveContextAvailability
} from "../../../src/core/context-vocabulary.mjs";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

// Only the write side, the IO derivation layer, and the prompt rendering layer may
// depend on the canonical tables. The reducer in particular must stay out: its ack
// requirements come from policy, and importing the table would let it decide policy
// for itself.
const IMPORT_ALLOWLIST = new Set([
  "core/context-pack.mjs",
  "core/artifact-root.mjs",
  "core/gate-input.mjs",
  "core/kswarm-workflow.mjs"
]);

async function collectSourceFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(join(dir, entry.name), rel)));
    } else if (entry.name.endsWith(".mjs")) {
      files.push(rel);
    }
  }
  return files;
}

test("the canonical ack keys are the snake_case keys the policy schema and eval corpus use", () => {
  assert.deepEqual(Object.values(CONTEXT_ACK_KEYS).sort(), [
    "project_brief",
    "structure_scan",
    "user_quality_principles"
  ]);
  assert.deepEqual(DEFAULT_CONTEXT_ACK_KEYS, ["user_quality_principles", "project_brief"]);
});

test("context artifact paths are protocol-form paths under the context directory", () => {
  assert.equal(CONTEXT_DIR, "context");
  assert.equal(contextArtifactPath(CONTEXT_FILES.projectBrief), "context/project-brief.md");
  assert.equal(
    contextArtifactPath(CONTEXT_FILES.qualityPrinciplesJson),
    "context/quality-principles.json"
  );
  for (const file of Object.values(CONTEXT_FILES)) {
    assert.equal(contextArtifactPath(file), `context/${file}`);
    assert.ok(!file.includes("\\"), `${file} must not carry a backslash separator`);
  }
});

test("context availability is derived from the frozen file table, not from caller flags", () => {
  const availability = deriveContextAvailability({
    "quality-principles.json": { artifact: "context/quality-principles.json", sha256: "a" },
    "project-brief.md": { artifact: "context/project-brief.md", sha256: "b" },
    "changeset.json": { artifact: "context/changeset.json", sha256: "c" }
  });
  assert.equal(availability.hasQualityPrinciples, true);
  assert.equal(availability.hasProjectBrief, true);
  assert.equal(availability.hasChangeset, true);
  assert.equal(availability.hasStructureScan, false);
});

test("an empty or absent file table derives no available context", () => {
  for (const input of [undefined, null, {}, "not an object", 7]) {
    const availability = deriveContextAvailability(input);
    assert.equal(availability.hasQualityPrinciples, false);
    assert.equal(availability.hasProjectBrief, false);
    assert.equal(availability.hasChangeset, false);
    assert.equal(availability.hasStructureScan, false);
    assert.deepEqual(availability.ackKeys, []);
  }
});

test("an ack key is only required for context that was actually frozen", () => {
  const withoutScan = deriveContextAvailability({
    "quality-principles.json": { artifact: "context/quality-principles.json", sha256: "a" },
    "project-brief.md": { artifact: "context/project-brief.md", sha256: "b" }
  });
  assert.deepEqual(withoutScan.ackKeys, ["user_quality_principles", "project_brief"]);

  const withScan = deriveContextAvailability({
    "quality-principles.json": { artifact: "context/quality-principles.json", sha256: "a" },
    "project-brief.md": { artifact: "context/project-brief.md", sha256: "b" },
    "structure-scan.md": { artifact: "context/structure-scan.md", sha256: "c" }
  });
  assert.deepEqual(withScan.ackKeys, [
    "user_quality_principles",
    "project_brief",
    "structure_scan"
  ]);

  const briefOnly = deriveContextAvailability({
    "project-brief.md": { artifact: "context/project-brief.md", sha256: "b" }
  });
  assert.deepEqual(briefOnly.ackKeys, ["project_brief"]);
});

// An ack is a claim that the reviewer read a file, so the file that decides whether to
// ask for the ack has to be the one the prompt points at. Asking for structure_scan
// because the machine-readable .json landed, while the prompt only ever references the
// .md, fails an honest reviewer for not acknowledging a file it was never shown.
test("the structure scan ack follows the file the reviewer prompt actually references", async () => {
  const prompt = await readFile(join(srcRoot, "core", "kswarm-workflow.mjs"), "utf8");
  assert.ok(prompt.includes("structureScanMarkdown"), "the prompt must reference the markdown scan");
  assert.ok(
    !prompt.includes("structureScanJson"),
    "the prompt must not reference the machine-readable scan"
  );

  const markdownOnly = deriveContextAvailability({
    "structure-scan.md": { artifact: "context/structure-scan.md", sha256: "c" }
  });
  assert.equal(markdownOnly.hasStructureScan, true);
  assert.deepEqual(markdownOnly.ackKeys, ["structure_scan"]);

  const jsonOnly = deriveContextAvailability({
    "structure-scan.json": { artifact: "context/structure-scan.json", sha256: "c" }
  });
  assert.equal(jsonOnly.hasStructureScan, false);
  assert.deepEqual(jsonOnly.ackKeys, []);
});

// The table comes from parsed JSON, so membership must be an own-property question.
// A prototype lookup would let an inherited name stand in for a file the pack never
// froze, and the prompt would then reference a file that is not on disk.
test("an inherited entry is not evidence that the pack froze a context file", () => {
  const inherited = Object.create({
    "project-brief.md": { artifact: "context/project-brief.md", sha256: "b" }
  });
  const availability = deriveContextAvailability(inherited);
  assert.equal(availability.hasProjectBrief, false);
  assert.deepEqual(availability.ackKeys, []);
});

test("only the write, IO derivation, and prompt rendering layers import the canonical tables", async () => {
  const files = await collectSourceFiles(srcRoot);
  const importers = [];
  for (const file of files) {
    const source = await readFile(join(srcRoot, file), "utf8");
    if (source.includes("context-vocabulary.mjs")) {
      importers.push(file);
    }
  }
  const unexpected = importers.filter((file) => !IMPORT_ALLOWLIST.has(file));
  assert.deepEqual(unexpected, [], `unexpected importers of context-vocabulary.mjs: ${unexpected.join(", ")}`);
});

test("the tables are frozen so no consumer can mutate the single source of truth", () => {
  assert.ok(Object.isFrozen(CONTEXT_FILES));
  assert.ok(Object.isFrozen(CONTEXT_ACK_KEYS));
  assert.ok(Object.isFrozen(DEFAULT_CONTEXT_ACK_KEYS));
});
