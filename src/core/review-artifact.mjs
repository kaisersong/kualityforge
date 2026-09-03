import {
  FINDING_PRIORITIES,
  REVIEW_ARTIFACT_STATUSES,
  REVIEWER_WRITABLE_STATUSES,
  SEVERITY_LEVELS,
  isFindingPriority,
  isReviewArtifactStatus,
  isReviewerWritableStatus,
  isSeverityLevel,
  normalizeFindingKey
} from "./finding-vocabulary.mjs";

const REVIEW_BLOCK_PATTERN = /```kualityforge-review\s*([\s\S]*?)```/gm;
const REVIEW_OPEN_PATTERN = /```kualityforge-review\s*/g;
const VACUOUS_THRESHOLD = 200;

// Exported so the replay path applies this mapping instead of reimplementing it:
// two copies would drift, and the gate would then compare a manifest against a
// differently-derived one.
export function mapReviewFindings(runnerId, findings) {
  let findingsTextLength = 0;
  const mapped = findings.map((finding, index) => {
    findingsTextLength +=
      (finding.title?.length || 0) +
      (finding.description?.length || 0) +
      (finding.suggestion?.length || 0);

    const severity = finding.severity ?? "warning";
    if (!isSeverityLevel(severity)) {
      throw new Error(
        `finding severity must be one of ${SEVERITY_LEVELS.join(", ")}; got: ${severity}`
      );
    }
    const priority = finding.priority ?? null;
    if (priority !== null && !isFindingPriority(priority)) {
      throw new Error(
        `finding priority must be one of ${FINDING_PRIORITIES.join(", ")}; got: ${priority}`
      );
    }
    const status = finding.status ?? "open";
    if (!isReviewerWritableStatus(status)) {
      throw new Error(
        `finding status ${status} is not writable by a reviewer; only ${REVIEWER_WRITABLE_STATUSES.join(", ")} is allowed`
      );
    }

    const title = finding.title || finding.id || `Finding ${index + 1}`;
    return {
      id: finding.id || `${runnerId}:QF-${String(index + 1).padStart(3, "0")}`,
      type: finding.type || "code",
      principleId: finding.principleId || null,
      priority,
      title,
      severity,
      status,
      // Derived from the title, never taken from the reviewer: a reviewer-chosen
      // key would let one reviewer address another reviewer's finding.
      duplicateKey: normalizeFindingKey(title),
      sourceRunnerId: runnerId,
      description: finding.description || "",
      suggestion: finding.suggestion || ""
    };
  });

  return {
    findings: mapped,
    findingsTextLength,
    // Computed here rather than at each call site so replay cannot drift from the
    // write path on either disjunct.
    isVacuous: mapped.length === 0 || findingsTextLength < VACUOUS_THRESHOLD
  };
}

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

  if (!isReviewArtifactStatus(review.status)) {
    throw new Error(
      `review status must be one of ${REVIEW_ARTIFACT_STATUSES.join(", ")}; got: ${review.status}`
    );
  }

  const { findings: mappedFindings, isVacuous } = mapReviewFindings(
    review.runnerId,
    review.findings
  );

  return {
    runnerId: review.runnerId,
    status: review.status,
    contextRead: review.contextRead || {},
    contextConfidence: review.contextConfidence || "medium",
    contextGaps: Array.isArray(review.contextGaps) ? review.contextGaps : [],
    contextProvenance: review.contextProvenance || {},
    principleAlignment: review.principleAlignment || {},
    findings: mappedFindings,
    isVacuous
  };
}

export function safeArtifactName(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}
