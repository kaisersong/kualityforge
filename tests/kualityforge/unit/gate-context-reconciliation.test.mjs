import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { initializeArtifactRoot } from "../../../src/core/artifact-root.mjs";
import { collectIntegrityErrors } from "../../../src/core/gate-input.mjs";
import { CONTEXT_FILES } from "../../../src/core/context-vocabulary.mjs";
import { applyDeterministicGitEnv } from "../helpers/git-env.mjs";

await applyDeterministicGitEnv();

const execFileAsync = promisify(execFile);

const PRINCIPLES = {
  schemaVersion: 1,
  scope: "user",
  required: true,
  principles: [
    {
      id: "independent-verification",
      priority: "must",
      statement: "Verifier must be independent.",
      appliesTo: ["release"],
      failureMode: "self verification cannot pass release",
      evidenceRequired: ["runner_identity"]
    }
  ]
};

// Every cell gets a fresh mkdtemp root on purpose: buildContextPack never cleans the
// context directory, so a reused root would carry the previous cell's files and the
// set reconciliation below would be measuring the fixture rather than the code.
async function seedContextPack({ withPrinciples = true, withProjectRoot = true, scan = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-b2-"));
  const projectRoot = join(root, "project");
  const docsRoot = join(root, "docs");
  const artifactRoot = join(root, "artifacts");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(docsRoot, { recursive: true });
  await writeFile(join(projectRoot, "AGENTS.md"), "# Agent rules\n", "utf8");
  await writeFile(join(projectRoot, "README.md"), "# Project 项目 \u{1F680}\n", "utf8");
  await writeFile(join(docsRoot, "README.md"), "# Docs\n", "utf8");

  if (withProjectRoot) {
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: projectRoot });
  }

  const context = {
    docsRoots: [docsRoot],
    enableStructureScan: scan
  };
  if (withProjectRoot) {
    context.projectRoot = projectRoot;
    context.instructionFiles = ["AGENTS.md"];
  }
  if (withPrinciples) {
    const principlesPath = join(root, "quality-principles.json");
    await writeFile(principlesPath, `${JSON.stringify(PRINCIPLES, null, 2)}\n`, "utf8");
    context.qualityPrinciplesPath = principlesPath;
  }

  const { manifest } = await initializeArtifactRoot(artifactRoot, {
    runId: "b2-run",
    profile: "release",
    context
  });

  return { root, artifactRoot, manifest };
}

async function readContextManifest(artifactRoot) {
  return JSON.parse(
    await readFile(join(artifactRoot, "context", CONTEXT_FILES.contextManifest), "utf8")
  );
}

async function writeContextManifest(artifactRoot, contextManifest) {
  await writeFile(
    join(artifactRoot, "context", CONTEXT_FILES.contextManifest),
    `${JSON.stringify(contextManifest, null, 2)}\n`,
    "utf8"
  );
}

// The positive guard. It is the only thing standing between the reconciliation and the
// cheapest way to make a failing cell green: weakening step 3 back to a one-way check.
// Weakening it leaves every negative cell below green too, so without this the
// regression would be invisible.
for (const variant of [
  { name: "a full pack", options: {} },
  { name: "a pack with a structure scan", options: { scan: true } },
  { name: "a pack with no quality principles", options: { withPrinciples: false } },
  { name: "a pack with no project root", options: { withProjectRoot: false } }
]) {
  test(`${variant.name} reconciles against its own context directory with no integrity error`, async () => {
    const { root, artifactRoot, manifest } = await seedContextPack(variant.options);
    try {
      assert.deepEqual(await collectIntegrityErrors(artifactRoot, manifest), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a pack with no project root leaves the changeset and structure scan references null", async () => {
  const { root, manifest } = await seedContextPack({ withProjectRoot: false });
  try {
    assert.equal(manifest.context.changeset, null);
    assert.equal(manifest.context.structureScan, null);
    assert.notEqual(manifest.context.projectBrief, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file planted in the context directory that the context manifest does not list is refused", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    await writeFile(join(artifactRoot, "context", "planted.json"), "{}\n", "utf8");
    const errors = await collectIntegrityErrors(artifactRoot, manifest);
    assert.deepEqual(errors, [
      "context/planted.json is on disk but context-manifest.json does not list it"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Dropping the entry is the move that a one-way reconciliation cannot see: the file is
// still on disk, still hashes to whatever the attacker wrote, and no per-entry check
// ever reaches it.
test("an entry removed from the context manifest leaves the file unclaimed", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const contextManifest = await readContextManifest(artifactRoot);
    delete contextManifest.files[CONTEXT_FILES.changesetMarkdown];
    await writeContextManifest(artifactRoot, contextManifest);

    const errors = await collectIntegrityErrors(artifactRoot, manifest);
    assert.ok(
      errors.some((error) => error.includes("context/changeset.md is on disk")),
      errors.join("\n")
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an entry listing a file that is not on disk is a dangling reference", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const contextManifest = await readContextManifest(artifactRoot);
    contextManifest.files["ghost.json"] = {
      artifact: "context/ghost.json",
      sha256: "0".repeat(64)
    };
    await writeContextManifest(artifactRoot, contextManifest);

    const errors = await collectIntegrityErrors(artifactRoot, manifest);
    assert.ok(
      errors.some((error) => error.includes("context/ghost.json") && error.includes("does not exist")),
      errors.join("\n")
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// changeset.md is the file a reviewer actually reads and its hash exists in exactly one
// place: the context manifest's files table. manifest.context.changeset points at the
// .json, so nothing else anchors these bytes.
test("appending a byte to a listed file that no manifest reference covers is refused", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    await appendFile(join(artifactRoot, "context", CONTEXT_FILES.changesetMarkdown), Buffer.from([0xff]));
    const errors = await collectIntegrityErrors(artifactRoot, manifest);
    assert.deepEqual(errors, [
      "context-manifest.json entry changeset.md artifact context/changeset.md does not match its recorded sha256"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A separate cell from the one above because the two turn red down different paths:
// tampering with the descriptor breaks the parse, so it must short circuit and report
// that, not a derived "the index is empty" error.
test("appending a byte to the context manifest itself is refused as a parse failure", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    await appendFile(join(artifactRoot, "context", CONTEXT_FILES.contextManifest), Buffer.from([0xff]));
    const errors = await collectIntegrityErrors(artifactRoot, manifest);
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(errors[0], /context\/context-manifest\.json is not readable as a context manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a context manifest whose files table is not an object short circuits with one error", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    await writeContextManifest(artifactRoot, { schemaVersion: 1, files: [] });
    const errors = await collectIntegrityErrors(artifactRoot, manifest);
    assert.deepEqual(errors, [
      "context/context-manifest.json does not declare a files table"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Pre-validated in the same step as the parse because the two consumers of these fields
// live in different later steps: putting the check in either one leaves the other able
// to throw on a malformed entry.
test("a context manifest entry missing its sha256 short circuits with one error", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const contextManifest = await readContextManifest(artifactRoot);
    contextManifest.files[CONTEXT_FILES.docsIndex] = { artifact: "context/docs-index.json" };
    await writeContextManifest(artifactRoot, contextManifest);

    const errors = await collectIntegrityErrors(artifactRoot, manifest);
    assert.deepEqual(errors, [
      "context/context-manifest.json entry docs-index.json must declare a non-empty artifact and sha256"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The keys of the files table never enter a comparison, so a prototype-looking key is
// data like any other. It must be walked as an own property rather than reached through
// a prototype chain, and its value still has to satisfy the shape pre-check.
test("a prototype-looking key in the files table is treated as ordinary data", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const contextManifest = await readContextManifest(artifactRoot);
    // Plain assignment would set the prototype and never reach the serialized JSON, so
    // the cell would be measuring JavaScript rather than the reconciliation. JSON.parse
    // on the other side turns this literal key back into an ordinary own property.
    Object.defineProperty(contextManifest.files, "__proto__", {
      value: { artifact: "context/planted.json", sha256: "" },
      enumerable: true,
      configurable: true,
      writable: true
    });
    await writeContextManifest(artifactRoot, contextManifest);

    const errors = await collectIntegrityErrors(artifactRoot, manifest);
    assert.deepEqual(errors, [
      "context/context-manifest.json entry __proto__ must declare a non-empty artifact and sha256"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, artifact] of [
  ["a traversal reference", "../../kualityforge-outside-probe.json"],
  ["an absolute reference", "/kualityforge-outside-probe.json"],
  ["a reference outside the context directory", "reviews/codex.md"]
]) {
  test(`${name} in the files table is refused before it is read`, async () => {
    const { root, artifactRoot, manifest } = await seedContextPack();
    try {
      const contextManifest = await readContextManifest(artifactRoot);
      contextManifest.files["smuggled.json"] = { artifact, sha256: "0".repeat(64) };
      await writeContextManifest(artifactRoot, contextManifest);

      const errors = await collectIntegrityErrors(artifactRoot, manifest);
      assert.ok(
        errors.some((error) => error.includes("smuggled.json") && error.includes(artifact)),
        errors.join("\n")
      );
      assert.ok(
        !errors.some((error) => error.includes("does not match its recorded sha256")),
        `the reference must never be hashed: ${errors.join("\n")}`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

// Role confusion, not a fail-open: whoever can rewrite the artifact field can rewrite
// the sha256 next to it. What this catches is a producer that renames a file and misses
// one reference, and a manifest that points a role at another role's bytes.
test("a context reference pointed at another role's file is refused even with a matching hash", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const contextManifest = await readContextManifest(artifactRoot);
    const docsIndex = contextManifest.files[CONTEXT_FILES.docsIndex];
    const tampered = {
      ...manifest,
      context: {
        ...manifest.context,
        changeset: { artifact: docsIndex.artifact, sha256: docsIndex.sha256 }
      }
    };

    const errors = await collectIntegrityErrors(artifactRoot, tampered);
    assert.deepEqual(errors, [
      "context.changeset.artifact context/docs-index.json is not the canonical path context/changeset.json"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a context reference that differs from the canonical path only by case is refused", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const tampered = {
      ...manifest,
      context: {
        ...manifest.context,
        projectBrief: {
          artifact: "context/Project-Brief.md",
          sha256: manifest.context.projectBrief.sha256
        }
      }
    };

    const errors = await collectIntegrityErrors(artifactRoot, tampered);
    // Not an exact array: a case-insensitive host reaches the miscased file and a
    // case-sensitive one does not, so the reference walk's reachability verdict is host
    // dependent. The canonical-path verdict is what must hold on every host.
    assert.ok(
      errors.includes(
        "context.projectBrief.artifact context/Project-Brief.md is not the canonical path context/project-brief.md"
      ),
      errors.join("\n")
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a context reference whose recorded hash does not match the bytes on disk is refused", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const tampered = {
      ...manifest,
      context: {
        ...manifest.context,
        projectBrief: { ...manifest.context.projectBrief, sha256: "0".repeat(64) }
      }
    };

    const errors = await collectIntegrityErrors(artifactRoot, tampered);
    assert.deepEqual(errors, [
      "context.projectBrief sha256 does not match the bytes of context/project-brief.md"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a context manifest reference that is not the canonical descriptor path is refused", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const tampered = {
      ...manifest,
      context: {
        ...manifest.context,
        contextManifest: {
          artifact: "context/docs-index.json",
          sha256: manifest.context.contextManifest.sha256
        }
      }
    };

    const errors = await collectIntegrityErrors(artifactRoot, tampered);
    assert.ok(
      errors.some((error) =>
        error.includes("context.contextManifest.artifact context/docs-index.json is not the canonical path")
      ),
      errors.join("\n")
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a context directory with no context manifest claim leaves nothing unclaimed to find", async () => {
  const { root, artifactRoot, manifest } = await seedContextPack();
  try {
    const tampered = { ...manifest };
    delete tampered.context;

    const errors = await collectIntegrityErrors(artifactRoot, tampered);
    assert.ok(
      errors.every((error) => error.includes("no context manifest claims")),
      errors.join("\n")
    );
    assert.ok(errors.length > 0, "a context directory with no claim must not pass unnoticed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an artifact root with no context directory reconciles to nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-b2-bare-"));
  try {
    const { manifest } = await initializeArtifactRoot(root, { runId: "bare", profile: "release" });
    assert.deepEqual(await collectIntegrityErrors(root, manifest), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
