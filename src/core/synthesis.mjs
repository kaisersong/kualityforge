import { renderScoresMarkdown } from "./reviewer-scoring.mjs";

const SEVERITY_RANK = new Map([
  ["blocker", 3],
  ["warning", 2],
  ["info", 1]
]);


export function synthesizeFindings(findings) {
  const groups = new Map();

  for (const finding of findings) {
    const key = finding.duplicateKey || finding.title || finding.id;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...finding,
        reviewerCount: finding.sourceRunnerId ? 1 : 0,
        sourceRunnerIds: finding.sourceRunnerId ? [finding.sourceRunnerId] : []
      });
      continue;
    }

    if (severityRank(finding.severity) > severityRank(existing.severity)) {
      existing.severity = finding.severity;
    }
    if (finding.sourceRunnerId && !existing.sourceRunnerIds.includes(finding.sourceRunnerId)) {
      existing.sourceRunnerIds.push(finding.sourceRunnerId);
      existing.sourceRunnerIds.sort();
      existing.reviewerCount = existing.sourceRunnerIds.length;
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return a.id.localeCompare(b.id);
  });
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

function severityRank(severity) {
  return SEVERITY_RANK.get(severity) || 0;
}
