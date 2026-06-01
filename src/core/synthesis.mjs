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

export function renderSummaryMarkdown({ runId, findings }) {
  const lines = [`# KualityFore Summary: ${runId}`, ""];

  if (findings.length === 0) {
    lines.push("No findings were reported by required reviewers.", "");
    return `${lines.join("\n")}\n`;
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

  return `${lines.join("\n")}\n`;
}

function severityRank(severity) {
  return SEVERITY_RANK.get(severity) || 0;
}
