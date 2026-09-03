import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildContextPack } from "./context-pack.mjs";

export const MANIFEST_FILE = "manifest.json";

let tempCounter = 0;

// The temp file must live in the target directory: a rename across filesystems
// degrades to copy + unlink and stops being atomic. pid alone is not enough,
// because one process can have several manifest writes in flight.
export function nextTempPath(filePath) {
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${tempCounter++}.tmp`);
}

// Crash-safe, and the contents are durable once this resolves. Not power-safe:
// the parent directory entry is never fsynced, so a rename can still be lost.
export async function writeFileAtomic(filePath, contents) {
  const tempPath = nextTempPath(filePath);
  let committed = false;
  try {
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    committed = true;
  } finally {
    if (!committed) {
      await rm(tempPath, { force: true });
    }
  }
}

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
  let contextFiles = {};
  let changeset = null;
  if (options.context) {
    const contextPack = await buildContextPack(artifactRoot, options.context);
    context = contextPack.artifacts;
    contextFiles = contextPack.files;
    changeset = contextPack.changeset;
  }

  const manifest = {
    ...createInitialManifest(options),
    ...(context ? { context } : {}),
    ...(options.context?.reviewType ? { reviewType: options.context.reviewType } : {})
  };
  const manifestPath = join(artifactRoot, MANIFEST_FILE);
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    artifactRoot,
    manifestPath,
    manifest,
    contextFiles,
    changeset
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
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifactRoot, manifestPath, manifest };
}

export async function updateManifestInArtifactRoot(artifactRoot, updater) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const nextManifest = updater(structuredClone(manifest));
  return saveManifestToArtifactRoot(artifactRoot, nextManifest);
}
