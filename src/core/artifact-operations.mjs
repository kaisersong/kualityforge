import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadManifestFromArtifactRoot, saveManifestToArtifactRoot } from "./artifact-root.mjs";
import { parseReviewArtifact, safeArtifactName } from "./review-artifact.mjs";
import { renderSummaryMarkdown, synthesizeFindings } from "./synthesis.mjs";

export async function writeReviewMarkdownToArtifactRoot(artifactRoot, markdown, options = {}) {
  const review = parseReviewArtifact(markdown);
  if (options.expectedRunnerId && review.runnerId !== options.expectedRunnerId) {
    throw new Error(`review runnerId mismatch: expected ${options.expectedRunnerId}, got ${review.runnerId}`);
  }

  const artifact = options.artifact || join("reviews", `${safeArtifactName(review.runnerId || options.sourceName || "review")}.md`);
  assertSafeArtifactPath(artifact, "review artifact");
  await mkdir(join(artifactRoot, dirname(artifact)), { recursive: true });
  await writeFile(join(artifactRoot, artifact), markdown, "utf8");

  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const reviewers = manifest.reviewers.filter((item) => item.runnerId !== review.runnerId);
  reviewers.push({
    runnerId: review.runnerId,
    status: review.status,
    artifact,
    contextRead: review.contextRead,
    contextConfidence: review.contextConfidence,
    contextGaps: review.contextGaps,
    contextProvenance: review.contextProvenance,
    principleAlignment: review.principleAlignment
  });
  reviewers.sort((a, b) => a.runnerId.localeCompare(b.runnerId));

  const findings = manifest.findings.filter((item) => item.sourceRunnerId !== review.runnerId);
  findings.push(...review.findings);

  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    reviewers,
    findings
  });

  return {
    runnerId: review.runnerId,
    artifact,
    findingCount: review.findings.length
  };
}

export async function writeReviewFileToArtifactRoot(artifactRoot, input, options = {}) {
  const markdown = await readFile(input, "utf8");
  return writeReviewMarkdownToArtifactRoot(artifactRoot, markdown, {
    sourceName: basename(input),
    ...options
  });
}

export async function synthesizeArtifactRoot(artifactRoot) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const findings = synthesizeFindings(manifest.findings);
  const contextGaps = manifest.reviewers
    .filter((reviewer) => Array.isArray(reviewer.contextGaps) && reviewer.contextGaps.length > 0)
    .map((reviewer) => ({ runnerId: reviewer.runnerId, gaps: reviewer.contextGaps }));
  const summary = renderSummaryMarkdown({ runId: manifest.runId, findings, contextGaps });
  const artifact = "summary.md";
  await writeFile(join(artifactRoot, artifact), summary, "utf8");
  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    findings,
    synthesis: {
      artifact,
      status: "completed"
    }
  });
  return { artifact, findingCount: findings.length };
}

export async function recordDecisionMarkdown(artifactRoot, markdown, options = {}) {
  const artifact = options.artifact || "decision.md";
  assertSafeArtifactPath(artifact, "decision artifact");
  await mkdir(join(artifactRoot, dirname(artifact)), { recursive: true });
  await writeFile(join(artifactRoot, artifact), markdown, "utf8");
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    humanDecision: {
      artifact,
      status: "recorded"
    }
  });
  return artifact;
}

export async function recordDecisionFile(artifactRoot, input, options = {}) {
  return recordDecisionMarkdown(artifactRoot, await readFile(input, "utf8"), options);
}

export async function recordCheckResult(artifactRoot, name, status, options = {}) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const requiredChecks = manifest.requiredChecks.filter((check) => check.name !== name);
  const check = { name, status };
  if (options.log) {
    assertSafeArtifactPath(options.log, "check log");
    check.log = options.log;
  }
  requiredChecks.push(check);
  requiredChecks.sort((a, b) => a.name.localeCompare(b.name));
  await saveManifestToArtifactRoot(artifactRoot, { ...manifest, requiredChecks });
  return check;
}

export async function recordVerificationMarkdown(artifactRoot, markdown, options = {}) {
  const runnerId = requireString(options.runnerId, "runnerId");
  const status = options.status || "verified";
  const artifact = options.artifact || "verify.md";
  assertSafeArtifactPath(artifact, "verification artifact");
  await mkdir(join(artifactRoot, dirname(artifact)), { recursive: true });
  await writeFile(join(artifactRoot, artifact), markdown, "utf8");
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    verification: {
      runnerId,
      status,
      artifact
    }
  });
  return artifact;
}

export async function recordVerificationFile(artifactRoot, input, options = {}) {
  return recordVerificationMarkdown(artifactRoot, await readFile(input, "utf8"), options);
}

function assertSafeArtifactPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.split(/[\\/]+/).includes("..")) {
    throw new Error(`${label} must stay within artifact root`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
