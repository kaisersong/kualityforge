import { isBlockingStatus } from "./finding-vocabulary.mjs";

const VERIFICATION_BLOCK_PATTERN = /```kualityforge-verification\s*\n([\s\S]*?)\n```/g;
const VERDICT_STATUSES = ["confirmed", "dismissed", "cannot_verify"];

export function parseVerificationArtifact(markdown) {
  if (typeof markdown !== "string") {
    throw new Error("verification markdown must be a string");
  }
  const matches = [...markdown.matchAll(VERIFICATION_BLOCK_PATTERN)];
  if (matches.length === 0) {
    throw new Error("verification artifact must include a kualityforge-verification block");
  }
  if (matches.length !== 1) {
    throw new Error("verification artifact must include exactly one kualityforge-verification block");
  }
  const match = matches[0];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`kualityforge-verification block is not valid JSON: ${e.message}`);
  }
  if (!data.runnerId || typeof data.runnerId !== "string") {
    throw new Error("kualityforge-verification block must include runnerId");
  }
  if (!Array.isArray(data.verdicts)) {
    throw new Error("kualityforge-verification block must include a verdicts array");
  }

  const seen = new Set();
  for (const verdict of data.verdicts) {
    if (!verdict.findingId || typeof verdict.findingId !== "string") {
      throw new Error("each verdict must include a findingId");
    }
    // Two verdicts on one finding have no deterministic winner.
    if (seen.has(verdict.findingId)) {
      throw new Error(`kualityforge-verification block returns two verdicts for ${verdict.findingId}`);
    }
    seen.add(verdict.findingId);
    if (!VERDICT_STATUSES.includes(verdict.status)) {
      throw new Error(`verdict status must be ${VERDICT_STATUSES.join(", ")}; got: ${verdict.status}`);
    }
  }

  const verdicts = data.verdicts;

  return {
    runnerId: data.runnerId,
    verdicts,
    overallStatus: computeOverallStatus(verdicts),
    verdictCount: verdicts.length,
    confirmedCount: verdicts.filter((v) => v.status === "confirmed").length,
    dismissedCount: verdicts.filter((v) => v.status === "dismissed").length,
    cannotVerifyCount: verdicts.filter((v) => v.status === "cannot_verify").length
  };
}

export function deriveManifestVerification(parsed, findings, options = {}) {
  const currentFindings = Array.isArray(findings) ? findings : [];
  const coveredFindingIds = [];
  const disputedFindings = [];

  for (const verdict of parsed.verdicts) {
    const matches = currentFindings.filter((finding) => finding.id === verdict.findingId);
    if (matches.length !== 1) {
      throw new Error(
        `verification verdict ${verdict.findingId} matches ${matches.length} findings; expected exactly 1`
      );
    }
    coveredFindingIds.push(verdict.findingId);
    if (verdict.status === "dismissed") {
      disputedFindings.push(verdict.findingId);
    }
  }

  const covered = new Set(coveredFindingIds);
  return {
    runnerId: parsed.runnerId,
    status: parsed.overallStatus,
    ...(options.artifact ? { artifact: options.artifact } : {}),
    verdicts: parsed.verdicts,
    verdictCount: parsed.verdictCount,
    confirmedCount: parsed.confirmedCount,
    dismissedCount: parsed.dismissedCount,
    cannotVerifyCount: parsed.cannotVerifyCount,
    coveredFindingIds,
    uncoveredOpenFindingIds: currentFindings
      .filter((finding) => isBlockingStatus(finding.status) && !covered.has(finding.id))
      .map((finding) => finding.id),
    disputedFindings
  };
}

// Purely verdict-derived, and deliberately not a completeness claim: "verified"
// only says nothing was disputed or unverifiable. Whether the verdicts covered
// the open findings is a gate-layer judgement that needs policy.
function computeOverallStatus(verdicts) {
  if (verdicts.some((v) => v.status === "dismissed")) {
    return "disputed";
  }
  if (verdicts.some((v) => v.status === "cannot_verify")) {
    return "partially_verified";
  }
  return "verified";
}
