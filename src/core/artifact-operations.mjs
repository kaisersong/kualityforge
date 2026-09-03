import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { loadManifestFromArtifactRoot, saveManifestToArtifactRoot } from "./artifact-root.mjs";
import { isSafeArtifactPath, normalizeArtifactKey, toProtocolPath } from "./artifact-path-format.mjs";
import { parseReviewArtifact, safeArtifactName } from "./review-artifact.mjs";
import { renderSummaryMarkdown, synthesizeFindings } from "./synthesis.mjs";
import {
  deriveManifestVerification,
  parseVerificationArtifact
} from "./verification-artifact.mjs";
import {
  applyDecisionToFindings,
  computeFindingSetDigest,
  parseDecisionArtifact
} from "./decision-artifact.mjs";
import { GATE_MARKERS, protocolError } from "./gate-markers.mjs";
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
    throw protocolError(
      GATE_MARKERS.RUNNER_ID_MISMATCH,
      `review runnerId mismatch: expected ${options.expectedRunnerId}, got ${review.runnerId}`
    );
  }

  const artifactName = safeArtifactName(review.runnerId || options.sourceName || "review");
  if (artifactName.length === 0) {
    throw new Error(`runner id "${review.runnerId}" produces an empty artifact name`);
  }

  // The protocol form, not the string the caller passed: replay enumerates the
  // reviews directory and compares plain strings, so "reviews\foo.md" reaching join()
  // would create a file outside reviews/ that no enumeration can ever match.
  const artifact = assertArtifactShape(
    options.artifact || join("reviews", `${artifactName}.md`),
    "reviews",
    ".md"
  );

  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);

  // Checked before the write, not after: once the file is overwritten the
  // displaced reviewer's content is gone, and a later gate verdict cannot
  // bring it back.
  const artifactKey = normalizeArtifactKey(artifact);
  const incumbent = manifest.reviewers.find(
    (reviewer) =>
      reviewer.runnerId !== review.runnerId &&
      normalizeArtifactKey(reviewer.artifact) === artifactKey
  );
  if (incumbent) {
    throw protocolError(
      GATE_MARKERS.ARTIFACT_NAME_COLLISION,
      `artifact name collision: runner "${incumbent.runnerId}" already owns "${incumbent.artifact}", refusing to overwrite for "${review.runnerId}"`
    );
  }

  await mkdir(join(artifactRoot, dirname(artifact)), { recursive: true });
  await writeFile(join(artifactRoot, artifact), markdown, "utf8");

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
  const owner = requireString(options.owner, "owner");
  const artifact = options.artifact || "decision.md";
  assertSafeArtifactPath(artifact, "decision artifact");
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);

  const decision = parseDecisionArtifact(markdown, { findings: manifest.findings, owner });
  if (decision) {
    if (decision.runId !== manifest.runId) {
      throw new Error(`decision runId ${decision.runId} does not match manifest runId ${manifest.runId}`);
    }
    if (decision.findingSetDigest !== computeFindingSetDigest(manifest.findings)) {
      throw new Error("decision findingSetDigest does not match the current finding set");
    }
  }

  await mkdir(join(artifactRoot, dirname(artifact)), { recursive: true });
  await writeFile(join(artifactRoot, artifact), markdown, "utf8");
  if (!decision) {
    await saveManifestToArtifactRoot(artifactRoot, {
      ...manifest,
      humanDecision: { artifact, owner, status: "unparsed" }
    });
    return artifact;
  }

  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    findings: applyDecisionToFindings(manifest.findings, decision),
    humanDecision: {
      artifact,
      owner,
      status: "parsed",
      runId: decision.runId,
      findingSetDigest: decision.findingSetDigest,
      decidedAt: decision.decidedAt
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
  let parsed;
  try {
    parsed = parseVerificationArtifact(markdown);
  } catch (error) {
    throw protocolError(
      GATE_MARKERS.VERIFICATION_UNPARSED,
      error instanceof Error ? error.message : String(error)
    );
  }
  if (parsed.runnerId !== runnerId) {
    throw protocolError(
      GATE_MARKERS.RUNNER_ID_MISMATCH,
      `verification runnerId mismatch: expected ${runnerId}, got ${parsed.runnerId}`
    );
  }

  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const verification = deriveManifestVerification(parsed, manifest.findings, { artifact });

  await mkdir(join(artifactRoot, dirname(artifact)), { recursive: true });
  await writeFile(join(artifactRoot, artifact), markdown, "utf8");
  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    verification
  });
  return artifact;
}

export async function recordVerificationFile(artifactRoot, input, options = {}) {
  return recordVerificationMarkdown(artifactRoot, await readFile(input, "utf8"), options);
}

export { isSafeArtifactPath, normalizeArtifactKey, toProtocolPath };

// A reference that cannot be reached is a verdict about the run; a permission or IO
// fault is a fault of the process running the gate and must not be reported as
// "this artifact was tampered with".
const REACHABILITY_ERRNOS = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

// The lexical half of both shape exports. Sharing it is the point: a second copy is
// how the write boundary and the replay side would come to disagree about which
// paths are legal, and the write boundary would then produce artifacts its own gate
// refuses.
function artifactShapeReason(value, expectedRoot, expectedSuffix) {
  if (!isSafeArtifactPath(value)) {
    return "must stay within artifact root";
  }
  const segments = toProtocolPath(value).split("/");
  // Case-sensitive on purpose: folding case here would admit "Reviews/x.md" at the
  // write boundary while replay enumerates the literal "reviews" directory.
  if (expectedRoot && segments[0] !== expectedRoot) {
    return `must live under ${expectedRoot}/`;
  }
  if (expectedSuffix && !segments[segments.length - 1].endsWith(expectedSuffix)) {
    return `must end with ${expectedSuffix}`;
  }
  return null;
}

// Write boundary only. Returns the protocol form so the caller writes the string it
// just validated rather than the one it was handed.
export function assertArtifactShape(value, expectedRoot, expectedSuffix = null) {
  const reason = artifactShapeReason(value, expectedRoot, expectedSuffix);
  if (reason) {
    throw new Error(`artifact "${value}" ${reason}`);
  }
  return toProtocolPath(value);
}

// Gate and replay side. Protocol violations and unreachable references come back as
// a reason; anything else is a process fault and keeps travelling, so callers must
// not wrap this in try/catch.
export async function checkArtifactShape({
  value,
  expectedRoot = null,
  artifactRoot,
  expectedSuffix = null
}) {
  const reason = artifactShapeReason(value, expectedRoot, expectedSuffix);
  if (reason) {
    return { ok: false, reason };
  }
  if (toProtocolPath(value) !== value) {
    return { ok: false, reason: "is not a canonical artifact path" };
  }

  const target = join(artifactRoot, value);
  let stats;
  try {
    stats = await stat(target);
  } catch (error) {
    if (REACHABILITY_ERRNOS.has(error.code)) {
      return { ok: false, reason: "does not exist" };
    }
    throw error;
  }

  if (!stats.isFile()) {
    return { ok: false, reason: "is not a file" };
  }
  if (stats.size === 0) {
    return { ok: false, reason: "is empty" };
  }

  // A clean relative path can still be a symlink out of the root, which no amount of
  // string inspection can see.
  let targetRealpath;
  let rootRealpath;
  try {
    rootRealpath = await realpath(artifactRoot);
    targetRealpath = await realpath(target);
  } catch (error) {
    if (REACHABILITY_ERRNOS.has(error.code)) {
      return { ok: false, reason: "does not exist" };
    }
    throw error;
  }

  const withinRoot = relative(rootRealpath, targetRealpath);
  if (withinRoot === "" || withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
    return { ok: false, reason: "resolves outside the artifact root" };
  }

  return { ok: true };
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
