import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createInitialManifest,
  initializeArtifactRoot,
  loadManifestFromArtifactRoot,
  nextTempPath,
  saveManifestToArtifactRoot
} from "../../../src/core/artifact-root.mjs";

test("createInitialManifest creates a deterministic empty run manifest", () => {
  const manifest = createInitialManifest({
    runId: "release-1",
    profile: "release",
    createdAt: "2026-06-02T00:00:00.000Z"
  });

  assert.deepEqual(manifest, {
    schemaVersion: "kualityforge.manifest.v1",
    runId: "release-1",
    status: "open",
    profile: "release",
    createdAt: "2026-06-02T00:00:00.000Z",
    reviewers: [],
    findings: [],
    requiredChecks: []
  });
});

test("initializeArtifactRoot writes manifest and expected directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-artifacts-"));
  try {
    const result = await initializeArtifactRoot(root, {
      runId: "release-2",
      profile: "release",
      createdAt: "2026-06-02T00:00:00.000Z"
    });

    assert.equal(result.manifestPath, join(root, "manifest.json"));

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.runId, "release-2");
    assert.equal(manifest.profile, "release");

    await readFile(join(root, "reviews", ".gitkeep"), "utf8");
    await readFile(join(root, "checks", ".gitkeep"), "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeArtifactRoot can attach a frozen context pack", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-context-root-"));
  const projectRoot = join(root, "project");
  const artifactRoot = join(root, "artifacts");
  try {
    await mkdir(projectRoot, { recursive: true });
    const result = await initializeArtifactRoot(artifactRoot, {
      runId: "release-with-context",
      profile: "release",
      createdAt: "2026-06-02T00:00:00.000Z",
      context: {
        projectRoot,
        changeGoal: "Review with project context"
      }
    });

    const manifest = JSON.parse(await readFile(join(artifactRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.context.projectContext.artifact, "context/project-context.json");
    assert.equal(manifest.context.projectBrief.artifact, "context/project-brief.md");
    assert.match(manifest.context.contextManifest.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Object.hasOwn(result.contextFiles, "project-brief.md"));
    assert.ok(Object.hasOwn(result.contextFiles, "changeset.json"));
    assert.equal(typeof result.changeset, "object");
    assert.equal(result.changeset.available, false);

    const brief = await readFile(join(artifactRoot, "context", "project-brief.md"), "utf8");
    assert.match(brief, /Review with project context/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadManifestFromArtifactRoot reads manifest.json from a run directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-load-"));
  try {
    await initializeArtifactRoot(root, {
      runId: "release-3",
      profile: "release",
      createdAt: "2026-06-02T00:00:00.000Z"
    });

    const { manifest, manifestPath } = await loadManifestFromArtifactRoot(root);

    assert.equal(manifestPath, join(root, "manifest.json"));
    assert.equal(manifest.runId, "release-3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nextTempPath stays in the target directory and never repeats", () => {
  const target = join("some", "dir", "manifest.json");
  const first = nextTempPath(target);
  const second = nextTempPath(target);

  assert.equal(dirname(first), dirname(target));
  assert.equal(dirname(second), dirname(target));
  assert.notEqual(first, second);
});

test("saveManifestToArtifactRoot leaves no temp file behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-atomic-"));
  try {
    await initializeArtifactRoot(root, { runId: "atomic-1", profile: "release" });
    await saveManifestToArtifactRoot(root, createInitialManifest({ runId: "atomic-1" }));

    const entries = await readdir(root);
    assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), []);
    assert.equal(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).runId, "atomic-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveManifestToArtifactRoot cleans up the temp file when the rename fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-atomic-fail-"));
  try {
    // A directory at the target path cannot be replaced by rename, so the commit
    // step fails after the temp file already exists.
    await mkdir(join(root, "manifest.json"), { recursive: true });

    await assert.rejects(
      saveManifestToArtifactRoot(root, createInitialManifest({ runId: "atomic-2" }))
    );

    const entries = await readdir(root);
    assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent saves in one process do not leave temp files or corrupt the manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-atomic-race-"));
  try {
    await initializeArtifactRoot(root, { runId: "atomic-3", profile: "release" });

    await Promise.all([
      saveManifestToArtifactRoot(root, createInitialManifest({ runId: "writer-a" })),
      saveManifestToArtifactRoot(root, createInitialManifest({ runId: "writer-b" }))
    ]);

    const entries = await readdir(root);
    assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), []);

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.ok(["writer-a", "writer-b"].includes(manifest.runId), manifest.runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
