import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { initializeArtifactRoot } from "../../../src/core/artifact-root.mjs";
import { deriveGateManifest } from "../../../src/core/gate-input.mjs";
import { CONTEXT_FILES } from "../../../src/core/context-vocabulary.mjs";
import { applyDeterministicGitEnv } from "../helpers/git-env.mjs";

await applyDeterministicGitEnv();

const execFileAsync = promisify(execFile);

// `available` and `deterministicEnvDegraded` live only inside the changeset document.
// The manifest reference beside it carries a path and a hash and nothing else, so a
// reducer that reads `manifest.context.changeset` can never see either field — which is
// how a criterion on them stayed a no-op. These cells pin the one layer that can see
// them: the derivation that reads the file.
async function seedPack({ withProjectRoot = true, git = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-derive-"));
  const projectRoot = join(root, "project");
  const docsRoot = join(root, "docs");
  const artifactRoot = join(root, "artifacts");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(docsRoot, { recursive: true });
  await writeFile(join(projectRoot, "AGENTS.md"), "# Agent rules\n", "utf8");
  await writeFile(join(docsRoot, "README.md"), "# Docs\n", "utf8");

  if (withProjectRoot && git) {
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: projectRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: projectRoot });
    await execFileAsync("git", ["commit", "-qm", "init"], { cwd: projectRoot });
    await writeFile(join(projectRoot, "AGENTS.md"), "# Agent rules\nchanged\n", "utf8");
  }

  const context = { docsRoots: [docsRoot] };
  if (withProjectRoot) {
    context.projectRoot = projectRoot;
  }

  const { manifest } = await initializeArtifactRoot(artifactRoot, {
    runId: "derive-run",
    profile: "release",
    context
  });

  return { root, artifactRoot, manifest };
}

function changesetPath(artifactRoot) {
  return join(artifactRoot, "context", CONTEXT_FILES.changesetJson);
}

async function rewriteChangeset(artifactRoot, mutate) {
  const document = JSON.parse(await readFile(changesetPath(artifactRoot), "utf8"));
  await writeFile(changesetPath(artifactRoot), `${JSON.stringify(mutate(document), null, 2)}\n`, "utf8");
}

test("a freeze that succeeded derives an available changeset onto the manifest", async () => {
  const { root, artifactRoot, manifest } = await seedPack();
  try {
    const { manifest: derived, errors } = await deriveGateManifest(artifactRoot, manifest);
    assert.deepEqual(errors, []);
    assert.equal(derived.context.changeset.available, true);
    assert.equal(typeof derived.context.changeset.deterministicEnvDegraded, "boolean");
    // The reference itself has to survive: the hash is what binds the derived values to
    // bytes, so a derivation that replaced the reference would cut its own anchor.
    assert.equal(derived.context.changeset.artifact, manifest.context.changeset.artifact);
    assert.equal(derived.context.changeset.sha256, manifest.context.changeset.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The input is what a caller may still want to report or serialise. Deriving in place
// would mean the gate's verdict and the manifest on disk stop describing each other.
test("the derivation leaves the manifest it was handed untouched", async () => {
  const { root, artifactRoot, manifest } = await seedPack();
  try {
    await deriveGateManifest(artifactRoot, manifest);
    assert.equal(manifest.context.changeset.available, undefined);
    assert.equal(manifest.context.changeset.deterministicEnvDegraded, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a freeze that failed derives available false rather than a missing field", async () => {
  const { root, artifactRoot, manifest } = await seedPack({ git: false });
  try {
    const { manifest: derived, errors } = await deriveGateManifest(artifactRoot, manifest);
    assert.deepEqual(errors, []);
    assert.equal(derived.context.changeset.available, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a degraded git environment is carried through to the derived manifest", async () => {
  const { root, artifactRoot, manifest } = await seedPack();
  try {
    await rewriteChangeset(artifactRoot, (document) => ({
      ...document,
      deterministicEnvDegraded: true
    }));
    const { manifest: derived } = await deriveGateManifest(artifactRoot, manifest);
    assert.equal(derived.context.changeset.deterministicEnvDegraded, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Anything other than a literal true has to land on false, because the field is what a
// blocker reads and a truthy string would otherwise pass for a successful freeze.
test("a changeset that claims availability with a non-boolean derives false", async () => {
  const { root, artifactRoot, manifest } = await seedPack();
  try {
    await rewriteChangeset(artifactRoot, (document) => ({ ...document, available: "true" }));
    const { manifest: derived } = await deriveGateManifest(artifactRoot, manifest);
    assert.equal(derived.context.changeset.available, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run that froze no changeset derives nothing and reports nothing", async () => {
  const { root, artifactRoot, manifest } = await seedPack({ withProjectRoot: false });
  try {
    assert.equal(manifest.context.changeset, null);
    const { manifest: derived, errors } = await deriveGateManifest(artifactRoot, manifest);
    assert.deepEqual(errors, []);
    assert.equal(derived.context.changeset, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an artifact root with no context at all derives nothing and reports nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-derive-bare-"));
  try {
    const { manifest } = await initializeArtifactRoot(root, { runId: "bare", profile: "release" });
    const { manifest: derived, errors } = await deriveGateManifest(root, manifest);
    assert.deepEqual(errors, []);
    assert.equal(derived.context, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The derivation is the layer that reads the file, so a file that is not a document has
// to become an integrity error here. The reducer's contract is that it never throws, so
// letting a SyntaxError travel would break it.
test("a changeset that is not parseable json is an integrity error, not a throw", async () => {
  const { root, artifactRoot, manifest } = await seedPack();
  try {
    await writeFile(changesetPath(artifactRoot), "{ not json\n", "utf8");
    const { manifest: derived, errors } = await deriveGateManifest(artifactRoot, manifest);
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(errors[0], /^context\/changeset\.json is not readable as a frozen changeset: /);
    // Underived rather than defaulted: a value invented here would be indistinguishable
    // from one the freeze actually reported.
    assert.equal(derived.context.changeset.available, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The reference has already been refused by the reconciliation layer. Reading it here
// anyway would be a second, unconstrained read path into whatever it names.
test("a changeset reference that is not the canonical path is never read", async () => {
  const { root, artifactRoot, manifest } = await seedPack();
  try {
    const tampered = {
      ...manifest,
      context: {
        ...manifest.context,
        changeset: { artifact: "context/docs-index.json", sha256: manifest.context.changeset.sha256 }
      }
    };
    const { manifest: derived, errors } = await deriveGateManifest(artifactRoot, tampered);
    assert.deepEqual(errors, []);
    assert.equal(derived.context.changeset.available, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
