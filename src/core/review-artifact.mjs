const REVIEW_BLOCK_PATTERN = /```kualityforge-review\s*([\s\S]*?)```/m;

export function parseReviewArtifact(markdown) {
  const match = REVIEW_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    throw new Error("review artifact must include a kualityforge-review block");
  }

  const review = JSON.parse(match[1]);
  if (!review.runnerId || typeof review.runnerId !== "string") {
    throw new Error("review runnerId is required");
  }

  if (!Array.isArray(review.findings)) {
    throw new Error("review findings must be an array");
  }

  return {
    runnerId: review.runnerId,
    status: review.status || "completed",
    findings: review.findings.map((finding, index) => {
      return {
        id: finding.id || `QF-${String(index + 1).padStart(3, "0")}`,
        title: finding.title || finding.id || `Finding ${index + 1}`,
        severity: finding.severity || "warning",
        status: finding.status || "open",
        duplicateKey: finding.duplicateKey || normalizeDuplicateKey(finding.title || finding.id),
        sourceRunnerId: review.runnerId
      };
    })
  };
}

export function safeArtifactName(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeDuplicateKey(value) {
  return String(value || "unknown-finding")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
