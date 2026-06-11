const REVIEW_BLOCK_PATTERN = /```kualityforge-review\s*([\s\S]*?)```/gm;
const REVIEW_OPEN_PATTERN = /```kualityforge-review\s*/g;
const VACUOUS_THRESHOLD = 200;

export function parseReviewArtifact(markdown) {
  // The KSwarm handoff transcript may contain many kualityforge-review fences from
  // diffs, search results, and embedded context. Use the last block whose content
  // is valid JSON with a runnerId field.
  let match = null;
  let m;
  while ((m = REVIEW_BLOCK_PATTERN.exec(markdown)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && typeof parsed.runnerId === "string") {
        match = m;
      }
    } catch {
      // not valid JSON — skip
    }
  }
  REVIEW_BLOCK_PATTERN.lastIndex = 0;

  if (!match) {
    // Fallback: agent may have omitted the closing fence.
    // Find the last opening fence and take everything after it.
    let openMatch = null;
    let om;
    while ((om = REVIEW_OPEN_PATTERN.exec(markdown)) !== null) {
      openMatch = om;
    }
    REVIEW_OPEN_PATTERN.lastIndex = 0;
    if (!openMatch) {
      throw new Error("review artifact must include a kualityforge-review block");
    }
    const content = markdown.slice(openMatch.index + openMatch[0].length);
    match = [null, content];
  }

  const review = JSON.parse(match[1]);
  if (!review.runnerId || typeof review.runnerId !== "string") {
    throw new Error("review runnerId is required");
  }

  if (!Array.isArray(review.findings)) {
    throw new Error("review findings must be an array");
  }

  let findingsTextLength = 0;
  const mappedFindings = review.findings.map((finding, index) => {
    findingsTextLength +=
      (finding.title?.length || 0) +
      (finding.description?.length || 0) +
      (finding.suggestion?.length || 0);
    return {
      id: finding.id || `QF-${String(index + 1).padStart(3, "0")}`,
      type: finding.type || "code",
      principleId: finding.principleId || null,
      priority: finding.priority || null,
      title: finding.title || finding.id || `Finding ${index + 1}`,
      severity: finding.severity || "warning",
      status: finding.status || "open",
      duplicateKey: finding.duplicateKey || normalizeDuplicateKey(finding.title || finding.id),
      sourceRunnerId: review.runnerId,
      description: finding.description || "",
      suggestion: finding.suggestion || ""
    };
  });

  return {
    runnerId: review.runnerId,
    status: review.status || "completed",
    contextRead: review.contextRead || {},
    contextConfidence: review.contextConfidence || "medium",
    contextGaps: Array.isArray(review.contextGaps) ? review.contextGaps : [],
    contextProvenance: review.contextProvenance || {},
    principleAlignment: review.principleAlignment || {},
    findings: mappedFindings,
    isVacuous: mappedFindings.length === 0 || findingsTextLength < VACUOUS_THRESHOLD
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
