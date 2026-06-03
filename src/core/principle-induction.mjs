import { safeArtifactName } from "./review-artifact.mjs";

// Deterministic, advisory induction of candidate quality principles from the
// merged findings of one review round. Output matches the quality-principles
// schema item shape so a human can review and, if approved, add them to the
// principle set. Never auto-applied and never affects the gate.

const SEVERITY_RANK = new Map([
  ["blocker", 3],
  ["warning", 2],
  ["info", 1]
]);

const SEVERITY_TO_PRIORITY = new Map([
  ["blocker", "must"],
  ["warning", "should"],
  ["info", "prefer"]
]);

export function inducePrinciples({
  synthesizedFindings = [],
  reviewers = [],
  existingPrinciples = []
} = {}) {
  const existingIds = new Set(
    (Array.isArray(existingPrinciples) ? existingPrinciples : [])
      .map((principle) => principle?.id)
      .filter(Boolean)
  );

  const clustersMap = new Map();
  for (const finding of synthesizedFindings) {
    const key = clusterKey(finding);
    if (!clustersMap.has(key)) {
      clustersMap.set(key, {
        key,
        findingIds: [],
        reviewerCount: 0,
        maxSeverity: "info",
        titles: [],
        matchedExistingPrincipleId: null
      });
    }
    const cluster = clustersMap.get(key);
    cluster.findingIds.push(finding.id);
    cluster.reviewerCount = Math.max(cluster.reviewerCount, finding.reviewerCount || 0);
    if (severityRank(finding.severity) > severityRank(cluster.maxSeverity)) {
      cluster.maxSeverity = finding.severity;
    }
    if (finding.title && !cluster.titles.includes(finding.title)) {
      cluster.titles.push(finding.title);
    }
    if (finding.principleId && existingIds.has(finding.principleId)) {
      cluster.matchedExistingPrincipleId = finding.principleId;
    }
  }

  const clusters = [...clustersMap.values()].sort((a, b) => a.key.localeCompare(b.key));

  const candidates = clusters
    .filter((cluster) => !cluster.matchedExistingPrincipleId)
    .map((cluster) => buildCandidate(cluster))
    .filter((candidate) => !existingIds.has(candidate.id));

  const takenIds = new Set(existingIds);
  for (const candidate of candidates) {
    const baseId = candidate.id;
    let resolvedId = baseId;
    let suffix = 1;
    while (takenIds.has(resolvedId)) {
      suffix += 1;
      resolvedId = `${baseId}-${suffix}`;
    }
    candidate.id = resolvedId;
    takenIds.add(resolvedId);
  }

  candidates.sort((a, b) => {
    const priorityDelta = priorityRank(b.priority) - priorityRank(a.priority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return a.id.localeCompare(b.id);
  });

  return {
    schemaVersion: 1,
    scope: "induced",
    candidates,
    clusters: clusters.map((cluster) => ({
      key: cluster.key,
      findingIds: cluster.findingIds,
      reviewerCount: cluster.reviewerCount,
      maxSeverity: cluster.maxSeverity,
      matchedExistingPrincipleId: cluster.matchedExistingPrincipleId
    }))
  };
}

export function renderInducedPrinciplesMarkdown(result) {
  const candidates = result?.candidates || [];
  const lines = ["# Induced Principle Candidates (advisory)", ""];
  if (candidates.length === 0) {
    lines.push("No candidate principles were induced from this review round.", "");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "These are advisory suggestions derived from this round's findings. They are NOT applied automatically; review and add to your quality principles if appropriate.",
    ""
  );
  for (const candidate of candidates) {
    lines.push(`## ${candidate.id}`);
    lines.push("");
    lines.push(`- Priority: ${candidate.priority}`);
    lines.push(`- Statement: ${candidate.statement}`);
    lines.push(`- Applies to: ${candidate.appliesTo.join(", ")}`);
    lines.push(`- Failure mode: ${candidate.failureMode}`);
    lines.push(`- Evidence required: ${candidate.evidenceRequired.join(", ")}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function buildCandidate(cluster) {
  const priority = SEVERITY_TO_PRIORITY.get(cluster.maxSeverity) || "prefer";
  const label = cluster.titles[0] || cluster.key;
  const findingCount = cluster.findingIds.length;
  const reviewerCount = cluster.reviewerCount || 0;
  const evidenceRequired = ["review_finding"];
  if (reviewerCount >= 2) {
    evidenceRequired.push("consensus");
  }
  return {
    id: `induced-${safeArtifactName(cluster.key) || "finding"}`,
    priority,
    statement: `Changes should avoid "${label}" (observed in ${findingCount} finding(s) across ${reviewerCount} reviewer(s)).`,
    appliesTo: ["change"],
    failureMode: `Recurring issue: ${cluster.titles.slice(0, 3).join("; ") || label}.`,
    evidenceRequired
  };
}

function clusterKey(finding) {
  if (finding.principleId) {
    return String(finding.principleId);
  }
  const type = finding.type || "code";
  const duplicate = finding.duplicateKey || finding.title || finding.id || "unknown";
  return `${type}:${duplicate}`;
}

function severityRank(severity) {
  return SEVERITY_RANK.get(severity) || 0;
}

function priorityRank(priority) {
  switch (priority) {
    case "must":
      return 3;
    case "should":
      return 2;
    case "prefer":
      return 1;
    default:
      return 0;
  }
}
