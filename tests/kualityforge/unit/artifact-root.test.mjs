import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createInitialManifest,
  initializeArtifactRoot,
  loadManifestFromArtifactRoot
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
