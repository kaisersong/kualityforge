import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildContextPack } from "./context-pack.mjs";

export const MANIFEST_FILE = "manifest.json";

export function createInitialManifest({ runId, profile = "default", createdAt = new Date().toISOString() }) {
  if (!runId || typeof runId !== "string") {
    throw new Error("runId is required");
  }

  return {
    schemaVersion: "kualityforge.manifest.v1",
    runId,
    status: "open",
    profile,
    createdAt,
    reviewers: [],
    findings: [],
    requiredChecks: []
  };
}

export async function initializeArtifactRoot(artifactRoot, options) {
  if (!artifactRoot || typeof artifactRoot !== "string") {
    throw new Error("artifactRoot is required");
  }

  await mkdir(artifactRoot, { recursive: true });
  await mkdir(join(artifactRoot, "reviews"), { recursive: true });
  await mkdir(join(artifactRoot, "checks"), { recursive: true });
  await writeFile(join(artifactRoot, "reviews", ".gitkeep"), "", "utf8");
  await writeFile(join(artifactRoot, "checks", ".gitkeep"), "", "utf8");

  let context = null;
  if (options.context) {
    context = (await buildContextPack(artifactRoot, options.context)).artifacts;
  }

  const manifest = {
    ...createInitialManifest(options),
    ...(context ? { context } : {}),
    ...(options.context?.reviewType ? { reviewType: options.context.reviewType } : {})
  };
  const manifestPath = join(artifactRoot, MANIFEST_FILE);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    artifactRoot,
    manifestPath,
    manifest
  };
}

export async function loadManifestFromArtifactRoot(artifactRoot) {
  if (!artifactRoot || typeof artifactRoot !== "string") {
    throw new Error("artifactRoot is required");
  }

  const manifestPath = join(artifactRoot, MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  return {
    artifactRoot,
    manifestPath,
    manifest
  };
}

export async function saveManifestToArtifactRoot(artifactRoot, manifest) {
  const manifestPath = join(artifactRoot, MANIFEST_FILE);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { artifactRoot, manifestPath, manifest };
}

export async function updateManifestInArtifactRoot(artifactRoot, updater) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const nextManifest = updater(structuredClone(manifest));
  return saveManifestToArtifactRoot(artifactRoot, nextManifest);
}
