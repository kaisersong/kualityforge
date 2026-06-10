const VERIFICATION_BLOCK_PATTERN = /```kualityforge-verification\s*\n([\s\S]*?)\n```/;

export function parseVerificationArtifact(markdown) {
  if (typeof markdown !== "string") {
    throw new Error("verification markdown must be a string");
  }
  const match = VERIFICATION_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    throw new Error("verification artifact must include a kualityforge-verification block");
  }
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
  for (const verdict of data.verdicts) {
    if (!verdict.findingId || typeof verdict.findingId !== "string") {
      throw new Error("each verdict must include a findingId");
    }
    if (!["confirmed", "dismissed", "cannot_verify"].includes(verdict.status)) {
      throw new Error(`verdict status must be confirmed, dismissed, or cannot_verify; got: ${verdict.status}`);
    }
  }

  const verdicts = data.verdicts;
  const overallStatus = computeOverallStatus(verdicts, data.overallStatus);

  return {
    runnerId: data.runnerId,
    verdicts,
    overallStatus,
    verdictCount: verdicts.length,
    confirmedCount: verdicts.filter((v) => v.status === "confirmed").length,
    dismissedCount: verdicts.filter((v) => v.status === "dismissed").length,
    cannotVerifyCount: verdicts.filter((v) => v.status === "cannot_verify").length
  };
}

function computeOverallStatus(verdicts, declared) {
  if (verdicts.length === 0) {
    return "cannot_verify";
  }
  if (verdicts.some((v) => v.status === "cannot_verify")) {
    return "partially_verified";
  }
  if (verdicts.some((v) => v.status === "dismissed")) {
    return "verified_with_dismissals";
  }
  return "verified";
}
