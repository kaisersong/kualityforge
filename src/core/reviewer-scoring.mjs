// Deterministic, advisory per-reviewer scoring. Pure functions over manifest
// data — no IO, no Date.now() inside the formula. Scores never affect the gate
// decision; they surface in summary.md and the report only.

export const SEVERITY_WEIGHTS = Object.freeze({ blocker: 3, warning: 2, info: 1 });
export const SUBSTANCE_TARGET = 6;
export const WEIGHTS = Object.freeze({
  protocolCompliance: 0.25,
  contextConfidence: 0.2,
  contextRead: 0.1,
  contextGapPenalty: 0.1,
  findingSubstance: 0.15,
  consensusRate: 0.2
});

export function scoreReviewers({
  reviewers = [],
  findings = [],
  synthesizedFindings = [],
  reviewOutcomes = []
} = {}) {
  const outcomeByRunner = new Map(
    (Array.isArray(reviewOutcomes) ? reviewOutcomes : []).map((outcome) => [outcome.runnerId, outcome])
  );

  const corroboratedKeys = new Set();
  for (const group of synthesizedFindings) {
    if ((group.reviewerCount || 0) >= 2) {
      corroboratedKeys.add(groupKey(group));
    }
  }

  const findingsByRunner = new Map();
  for (const finding of findings) {
    const runnerId = finding.sourceRunnerId;
    if (!runnerId) {
      continue;
    }
    if (!findingsByRunner.has(runnerId)) {
      findingsByRunner.set(runnerId, []);
    }
    findingsByRunner.get(runnerId).push(finding);
  }

  const scores = reviewers.map((reviewer) => {
    const runnerId = reviewer.runnerId;
    const ownFindings = findingsByRunner.get(runnerId) || [];
    const outcome = outcomeByRunner.get(runnerId) || null;

    const dimensions = {
      protocolCompliance: scoreProtocol(reviewer, outcome),
      contextConfidence: scoreConfidence(reviewer.contextConfidence),
      contextRead: scoreContextRead(reviewer.contextRead, reviewer.contextRequired),
      contextGapPenalty: scoreContextGaps(reviewer.contextGaps),
      findingSubstance: scoreSubstance(ownFindings),
      consensusRate: scoreConsensus(ownFindings, corroboratedKeys)
    };

    const overall = round1(
      100 *
        Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + weight * dimensions[key], 0)
    );

    const corroboratedCount = ownFindings.filter((finding) =>
      corroboratedKeys.has(findingKey(finding))
    ).length;

    return {
      runnerId,
      role: outcome?.role || reviewer.role || null,
      overall,
      dimensions,
      stats: {
        findingCount: ownFindings.length,
        corroboratedCount,
        severityCounts: severityCounts(ownFindings),
        contextConfidence: reviewer.contextConfidence || "missing",
        contextGaps: Array.isArray(reviewer.contextGaps) ? reviewer.contextGaps.length : 0
      }
    };
  });

  scores.sort((a, b) => {
    if (b.overall !== a.overall) {
      return b.overall - a.overall;
    }
    return a.runnerId.localeCompare(b.runnerId);
  });

  return {
    schemaVersion: 1,
    weights: { ...WEIGHTS },
    scores,
    ranking: scores.map((score) => score.runnerId)
  };
}

export function renderScoresMarkdown(scoresResult) {
  const scores = scoresResult?.scores || [];
  if (scores.length === 0) {
    return "";
  }
  const lines = ["## Reviewer Scores", ""];
  for (const score of scores) {
    const role = score.role ? `, ${score.role}` : "";
    const consensusPct = score.stats.findingCount
      ? Math.round((score.stats.corroboratedCount / score.stats.findingCount) * 100)
      : 0;
    lines.push(
      `- ${score.runnerId}: ${score.overall} (findings ${score.stats.findingCount}, consensus ${consensusPct}%${role})`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function scoreProtocol(reviewer, outcome) {
  if (outcome && (outcome.status === "failed" || outcome.status === "skipped")) {
    return 0;
  }
  const hasFields =
    reviewer.contextRead !== undefined &&
    reviewer.contextConfidence !== undefined &&
    reviewer.contextConfidence !== null;
  if (reviewer.status === "completed" && hasFields) {
    return 1;
  }
  return 0.5;
}

function scoreConfidence(confidence) {
  switch (confidence) {
    case "high":
      return 1;
    case "medium":
      return 0.6;
    case "low":
      return 0.2;
    default:
      return 0.4;
  }
}

function scoreContextRead(contextRead, requiredKeys) {
  const read = contextRead && typeof contextRead === "object" ? contextRead : {};
  const required = Array.isArray(requiredKeys) ? requiredKeys : [];
  const keys = new Set([...Object.keys(read), ...required]);
  if (keys.size === 0) {
    return 0;
  }
  let trueCount = 0;
  for (const key of keys) {
    if (read[key] === true) {
      trueCount += 1;
    }
  }
  return trueCount / keys.size;
}

function scoreContextGaps(contextGaps) {
  const count = Array.isArray(contextGaps) ? contextGaps.length : 0;
  return Math.max(0, 1 - 0.25 * count);
}

function scoreSubstance(ownFindings) {
  const weighted = ownFindings.reduce(
    (sum, finding) => sum + (SEVERITY_WEIGHTS[finding.severity] || 0),
    0
  );
  return Math.min(1, weighted / SUBSTANCE_TARGET);
}

function scoreConsensus(ownFindings, corroboratedKeys) {
  if (ownFindings.length === 0) {
    return 0.5;
  }
  const corroborated = ownFindings.filter((finding) => corroboratedKeys.has(findingKey(finding)))
    .length;
  return corroborated / ownFindings.length;
}

function severityCounts(ownFindings) {
  const counts = { blocker: 0, warning: 0, info: 0 };
  for (const finding of ownFindings) {
    if (counts[finding.severity] !== undefined) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

function groupKey(group) {
  return group.duplicateKey || group.title || group.id || "";
}

function findingKey(finding) {
  return finding.duplicateKey || finding.title || finding.id || "";
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
