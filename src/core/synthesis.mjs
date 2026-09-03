import { renderScoresMarkdown } from "./reviewer-scoring.mjs";
import { normalizeFindingKey, severityRank } from "./finding-vocabulary.mjs";

export function synthesizeFindings(findings) {
  const groups = new Map();

  for (const finding of findings) {
    const key = mergeKey(finding);
    const group = groups.get(key);
    if (group) {
      group.push(finding);
    } else {
      groups.set(key, [finding]);
    }
  }

  const merged = Array.from(groups.values())
    .map(mergeGroup)
    .sort((a, b) => {
      const severityDelta = severityRank(b.severity) - severityRank(a.severity);
      if (severityDelta !== 0) {
        return severityDelta;
      }
      return a.id.localeCompare(b.id);
    });

  // Decisions and verdicts address findings by id. Two unmerged findings under one
  // id would make that addressing ambiguous, so it fails at the write boundary
  // rather than becoming a manifest the gate has to guess about.
  const seenIds = new Set();
  for (const finding of merged) {
    if (seenIds.has(finding.id)) {
      throw new Error(`duplicate finding id ${finding.id} across distinct findings`);
    }
    seenIds.add(finding.id);
  }

  return merged;
}

// The key derives from the title rather than a reviewer-supplied duplicateKey,
// which reviewers could otherwise use to swallow each other's findings. It also
// carries every field the gate reads, so findings that disagree on
// classification stay separate and a merge cannot destroy gate evidence.
function mergeKey(finding) {
  return JSON.stringify([
    normalizeFindingKey(finding.title || finding.id),
    finding.status ?? null,
    finding.type ?? null,
    finding.priority ?? null
  ]);
}

function mergeGroup(members) {
  const ordered = [...members].sort(
    (a, b) =>
      String(a.id ?? "").localeCompare(String(b.id ?? "")) ||
      String(a.sourceRunnerId ?? "").localeCompare(String(b.sourceRunnerId ?? ""))
  );

  const sourceRunnerIds = [
    ...new Set(ordered.map((item) => item.sourceRunnerId).filter(isNonEmptyString))
  ].sort();

  const merged = {
    ...ordered[0],
    severity: ordered.reduce(
      (worst, item) => (severityRank(item.severity) > severityRank(worst) ? item.severity : worst),
      ordered[0].severity
    ),
    reviewerCount: sourceRunnerIds.length,
    sourceRunnerIds
  };

  const description = joinDistinct(ordered.map((item) => item.description));
  if (description) {
    merged.description = description;
  }
  const suggestion = joinDistinct(ordered.map((item) => item.suggestion));
  if (suggestion) {
    merged.suggestion = suggestion;
  }

  return merged;
}

function joinDistinct(values) {
  return [...new Set(values.filter(isNonEmptyString))].join("\n\n");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function renderSummaryMarkdown({ runId, findings, contextGaps = [], reviewPolicy = null, reviewOutcomes = [], reviewerScores = null, inducedPrinciples = null, reviewers = [] }) {
  const lines = [`# KualityForge Summary: ${runId}`, ""];

  if (contextGaps.length > 0) {
    lines.push("## Context Gaps", "");
    for (const item of contextGaps) {
      for (const gap of item.gaps || []) {
        lines.push(`- ${item.runnerId}: ${gap}`);
      }
    }
    lines.push("");
  }

  if (reviewPolicy && typeof reviewPolicy === "object") {
    const outcomes = Array.isArray(reviewOutcomes) ? reviewOutcomes : [];
    const outcomeByRunner = new Map(outcomes.map((outcome) => [outcome.runnerId, outcome]));
    const completedReviewers = new Set(
      (Array.isArray(reviewers) ? reviewers : [])
        .filter((reviewer) => reviewer.status === "completed")
        .map((reviewer) => reviewer.runnerId)
    );
    const succeeded = (runnerId) => {
      const outcome = outcomeByRunner.get(runnerId);
      if (outcome) {
        return outcome.status === "succeeded";
      }
      // No explicit outcome (e.g. required_all without reviewOutcomes): fall back
      // to whether the reviewer completed so completed reviewers aren't shown absent.
      return completedReviewers.has(runnerId);
    };
    const required = [...(reviewPolicy.requiredReviewers || [])].sort();
    const advisory = [...(reviewPolicy.advisoryReviewers || [])].sort();

    lines.push("## Quorum Review", "");
    lines.push(`- Mode: ${reviewPolicy.mode || "unknown"}`);
    if (reviewPolicy.quorumMin !== undefined && reviewPolicy.quorumMin !== null) {
      lines.push(`- Quorum minimum: ${reviewPolicy.quorumMin}`);
    }

    lines.push("- Required reviewers:");
    if (required.length === 0) {
      lines.push("  - (none)");
    } else {
      for (const runnerId of required) {
        lines.push(`  - ${runnerId}: ${succeeded(runnerId) ? "present" : "absent"}`);
      }
    }

    lines.push("- Advisory reviewers:");
    if (advisory.length === 0) {
      lines.push("  - (none)");
    } else {
      for (const runnerId of advisory) {
        if (succeeded(runnerId)) {
          lines.push(`  - ${runnerId}: present`);
        } else {
          const reason = outcomeByRunner.get(runnerId)?.absenceReason || "absent";
          lines.push(`  - ${runnerId}: absent (${reason})`);
        }
      }
    }
    lines.push("");
  }

  const scoresMarkdown = reviewerScores ? renderScoresMarkdown(reviewerScores) : "";
  if (scoresMarkdown) {
    for (const line of scoresMarkdown.replace(/\n+$/, "").split("\n")) {
      lines.push(line);
    }
    lines.push("");
  }

  if (findings.length === 0) {
    lines.push("No findings were reported by required reviewers.", "");
    return `${lines.join("\n")}\n`;
  }

  const principleViolations = findings.filter(
    (finding) => finding.type === "quality_principle_violation"
  );
  if (principleViolations.length > 0) {
    lines.push("## Quality Principle Violations", "");
    for (const finding of principleViolations) {
      lines.push(`- ${finding.id} ${finding.title}`);
      lines.push(`  - Principle: ${finding.principleId || "unknown"}`);
      lines.push(`  - Priority: ${finding.priority || "unspecified"}`);
      lines.push(`  - Severity: ${finding.severity}`);
      lines.push(`  - Status: ${finding.status}`);
    }
    lines.push("");
  }

  lines.push("## Findings", "");
  for (const finding of findings) {
    lines.push(`- [ ] ${finding.id} ${finding.title}`);
    lines.push(`  - Severity: ${finding.severity}`);
    lines.push(`  - Status: ${finding.status}`);
    lines.push(`  - Reviewers: ${(finding.sourceRunnerIds || []).join(", ")}`);
    lines.push(`  - Reviewer count: ${finding.reviewerCount || 0}`);
    if (finding.description) {
      lines.push(`  - Description: ${finding.description}`);
    }
    if (finding.suggestion) {
      lines.push(`  - Suggestion: ${finding.suggestion}`);
    }
  }
  lines.push("");

  if (inducedPrinciples?.candidates?.length) {
    lines.push("## Induced Principle Candidates (advisory)", "");
    for (const candidate of inducedPrinciples.candidates) {
      lines.push(`- ${candidate.id} (${candidate.priority}): ${candidate.statement}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
