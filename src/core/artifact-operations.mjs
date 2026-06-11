import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadManifestFromArtifactRoot, saveManifestToArtifactRoot } from "./artifact-root.mjs";
import { parseReviewArtifact, safeArtifactName } from "./review-artifact.mjs";
import { renderSummaryMarkdown, synthesizeFindings } from "./synthesis.mjs";
import { parseVerificationArtifact } from "./verification-artifact.mjs";
import { scoreReviewers } from "./reviewer-scoring.mjs";
import { inducePrinciples, renderInducedPrinciplesMarkdown } from "./principle-induction.mjs";
import {
  buildReportModel,
  renderReportHtml,
  renderReportMarkdown,
  resolveReportOutDir
} from "./report.mjs";

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
    principleAlignment: review.principleAlignment,
    isVacuous: review.isVacuous || false
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
    findingCount: review.findings.length,
    isVacuous: review.isVacuous || false
  };
}

export async function writeReviewFileToArtifactRoot(artifactRoot, input, options = {}) {
  const markdown = await readFile(input, "utf8");
  return writeReviewMarkdownToArtifactRoot(artifactRoot, markdown, {
    sourceName: basename(input),
    ...options
  });
}

export async function synthesizeArtifactRoot(artifactRoot, options = {}) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const findings = synthesizeFindings(manifest.findings);
  const contextGaps = manifest.reviewers
    .filter((reviewer) => Array.isArray(reviewer.contextGaps) && reviewer.contextGaps.length > 0)
    .map((reviewer) => ({ runnerId: reviewer.runnerId, gaps: reviewer.contextGaps }));

  const reviewOutcomes = Array.isArray(manifest.reviewOutcomes) ? manifest.reviewOutcomes : [];
  const reviewerScores = scoreReviewers({
    reviewers: manifest.reviewers,
    findings: manifest.findings,
    synthesizedFindings: findings,
    reviewOutcomes
  });
  const scoresWithTimestamp = { ...reviewerScores, generatedAt: new Date().toISOString() };

  const existingPrinciples = await loadExistingPrinciples(artifactRoot);
  const induced = inducePrinciples({
    synthesizedFindings: findings,
    reviewers: manifest.reviewers,
    existingPrinciples,
    lang: options.lang
  });
  const inducedWithTimestamp = { ...induced, generatedAt: new Date().toISOString() };

  const summary = renderSummaryMarkdown({
    runId: manifest.runId,
    findings,
    contextGaps,
    reviewPolicy: manifest.reviewPolicy || null,
    reviewOutcomes,
    reviewerScores,
    inducedPrinciples: induced,
    reviewers: manifest.reviewers || []
  });

  const artifact = "summary.md";
  const scoresArtifact = "scores.json";
  const inducedPrinciplesArtifact = "induced-principles.json";
  const inducedPrinciplesMarkdownArtifact = "induced-principles.md";

  await writeFile(join(artifactRoot, artifact), summary, "utf8");
  await writeFile(
    join(artifactRoot, scoresArtifact),
    `${JSON.stringify(scoresWithTimestamp, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(artifactRoot, inducedPrinciplesArtifact),
    `${JSON.stringify(inducedWithTimestamp, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(artifactRoot, inducedPrinciplesMarkdownArtifact),
    renderInducedPrinciplesMarkdown(induced),
    "utf8"
  );

  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    findings,
    synthesis: {
      artifact,
      status: "completed"
    },
    reviewerScores: {
      artifact: scoresArtifact,
      status: "completed",
      scores: (reviewerScores.scores || []).map((score) => ({
        runnerId: score.runnerId,
        overall: score.overall
      }))
    },
    inducedPrinciples: {
      artifact: inducedPrinciplesArtifact,
      status: "completed"
    }
  });
  return { artifact, findingCount: findings.length, scoresArtifact, inducedPrinciplesArtifact };
}

async function loadExistingPrinciples(artifactRoot) {
  try {
    const content = await readFile(join(artifactRoot, "context", "quality-principles.json"), "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.principles) ? parsed.principles : [];
  } catch {
    return [];
  }
}

export async function writeReportFromArtifactRoot(artifactRoot, options = {}) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const summaryMarkdown = await readArtifactText(join(artifactRoot, "summary.md"));
  const scores = await readArtifactJson(join(artifactRoot, "scores.json"));
  const inducedPrinciples = await readArtifactJson(join(artifactRoot, "induced-principles.json"));
  const changeset = await readArtifactJson(join(artifactRoot, "context", "changeset.json"));

  const model = buildReportModel({
    manifest,
    summaryMarkdown: summaryMarkdown || "",
    scores,
    inducedPrinciples,
    changeset,
    gate: options.gate || null,
    reviewType: manifest.reviewType || "changeset"
  });

  const outDir = resolveReportOutDir(options.outDir, process.env, join(artifactRoot, "reports"));
  await mkdir(outDir, { recursive: true });
  const baseName = `${safeArtifactName(manifest.runId || "run")}-report`;
  const langOpt = { lang: options.lang };
  const markdownPath = join(outDir, `${baseName}.md`);
  await writeFile(markdownPath, renderReportMarkdown(model, langOpt), "utf8");

  const result = { markdownPath };
  if (options.html) {
    const htmlPath = join(outDir, `${baseName}.html`);
    await writeFile(htmlPath, renderReportHtml(model, langOpt), "utf8");
    result.htmlPath = htmlPath;
  }
  return result;
}

async function readArtifactText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readArtifactJson(path) {
  const text = await readArtifactText(path);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  const artifact = options.artifact || "verify.md";
  assertSafeArtifactPath(artifact, "verification artifact");
  await mkdir(join(artifactRoot, dirname(artifact)), { recursive: true });
  await writeFile(join(artifactRoot, artifact), markdown, "utf8");
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);

  let verification;
  let updatedFindings = manifest.findings;

  try {
    const parsed = parseVerificationArtifact(markdown);
    // backfill findings using duplicateKey or id matching
    const verdictByKey = new Map();
    for (const verdict of parsed.verdicts) {
      verdictByKey.set(verdict.findingId, verdict);
    }
    updatedFindings = manifest.findings.map((finding) => {
      const key = finding.duplicateKey || finding.id;
      const verdict = verdictByKey.get(key) || verdictByKey.get(finding.id);
      if (!verdict) return finding;
      if (verdict.status === "dismissed") {
        return { ...finding, status: "dismissed", dismissedBy: parsed.runnerId };
      }
      if (verdict.status === "cannot_verify") {
        return { ...finding, verificationNote: "cannot_verify" };
      }
      return finding;
    });
    verification = {
      runnerId: parsed.runnerId,
      status: parsed.overallStatus,
      artifact,
      verdicts: parsed.verdicts,
      verdictCount: parsed.verdictCount,
      confirmedCount: parsed.confirmedCount,
      dismissedCount: parsed.dismissedCount,
      cannotVerifyCount: parsed.cannotVerifyCount
    };
  } catch {
    // fallback: use caller-supplied status (backward compatible)
    // do not default to "verified" on parse failure — fail closed
    verification = {
      runnerId,
      status: options.status || "unparsed",
      artifact
    };
  }

  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    findings: updatedFindings,
    verification
  });
  return artifact;
}

export async function recordVerificationFile(artifactRoot, input, options = {}) {
  return recordVerificationMarkdown(artifactRoot, await readFile(input, "utf8"), options);
}

export function isSafeArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return false;
  }
  if (value.split(/[\\/]+/).includes("..")) {
    return false;
  }
  return true;
}

function assertSafeArtifactPath(value, label) {
  if (!isSafeArtifactPath(value)) {
    throw new Error(`${label} must stay within artifact root`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
