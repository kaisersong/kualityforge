import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeSuspiciousPatterns,
  detectorModulePath
} from "../../../src/core/suspicious-patterns.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

async function seedFiles(files) {
  const dir = await mkdtemp(join(tmpdir(), "kualityforge-suspicious-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

test("the detector module reports its own path relative to the project root", () => {
  assert.equal(detectorModulePath(repoRoot), "src/core/suspicious-patterns.mjs");
});

// Two assertions in one test on purpose: they are the two halves of the same
// decision. Marking instead of excluding means the detector module stays in scope,
// so a real suspicious call added to it is still reported — and the marker is what
// keeps that from reading as a genuine finding.
test("the detector's own pattern table stays in scope and is marked as expected", async () => {
  const detector = detectorModulePath(repoRoot);

  const results = await computeSuspiciousPatterns(repoRoot, [detector]);
  const innerHtml = results.find((result) => result.pattern === "innerHTML");

  assert.ok(innerHtml, "the detector module must stay inside the scan, not be excluded");
  const entry = innerHtml.files.find((file) => file.path === detector);
  assert.ok(entry, "the detector module's own hit must still be listed");
  assert.equal(entry.expectedSelfHit, true);
});

test("counts are occurrences, not files hit", async () => {
  // Three hits on one line: a line-oriented counter reports 1 here, so this
  // distinguishes occurrence counting from the line counting it replaced.
  const dir = await seedFiles({
    "a.js": "// TODO TODO TODO\n",
    "b.js": "// TODO\n"
  });
  try {
    const results = await computeSuspiciousPatterns(dir, ["a.js", "b.js"]);
    const todo = results.find((result) => result.pattern === "TODO");

    assert.equal(todo.totalOccurrences, 4);
    assert.deepEqual(todo.files, [
      { path: "a.js", count: 3 },
      { path: "b.js", count: 1 }
    ]);
    assert.equal(todo.filesTruncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hit outside the detector module carries no expected-self-hit marker", async () => {
  const dir = await seedFiles({ "a.js": "// TODO\n" });
  try {
    const results = await computeSuspiciousPatterns(dir, ["a.js"]);

    for (const result of results) {
      for (const file of result.files) {
        assert.equal(file.expectedSelfHit, undefined, file.path);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Truncation is reported as a fact about the file list, not inferred by comparing
// the list length against an occurrence total: one busy file can outnumber the
// entries while nothing was cut, which would claim files are missing when none are.
test("truncation is reported when the file list is cut, not when counts exceed it", async () => {
  const many = {};
  for (let index = 0; index < 21; index += 1) {
    many[`f${index}.js`] = "// TODO\n";
  }
  const dir = await seedFiles(many);
  try {
    const results = await computeSuspiciousPatterns(dir, Object.keys(many));
    const todo = results.find((result) => result.pattern === "TODO");

    assert.equal(todo.files.length, 20);
    assert.equal(todo.totalOccurrences, 21);
    assert.equal(todo.filesTruncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable file is skipped without failing the scan", async () => {
  const dir = await seedFiles({ "a.js": "// TODO\n" });
  try {
    const results = await computeSuspiciousPatterns(dir, ["a.js", "does-not-exist.js"]);
    const todo = results.find((result) => result.pattern === "TODO");

    assert.deepEqual(todo.files, [{ path: "a.js", count: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The pattern table is shared across files and across calls; a global regex that
// carried lastIndex between uses would drop hits in every file after the first.
test("scanning the same file list twice yields the same counts", async () => {
  const dir = await seedFiles({ "a.js": "// TODO TODO\n", "b.js": "// TODO TODO\n" });
  try {
    const first = await computeSuspiciousPatterns(dir, ["a.js", "b.js"]);
    const second = await computeSuspiciousPatterns(dir, ["a.js", "b.js"]);

    assert.deepEqual(second, first);
    assert.equal(first.find((result) => result.pattern === "TODO").totalOccurrences, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
