import { DEFAULT_LANG, getLabels } from "./report-labels.mjs";
import { esc, shortSha } from "./report-format.mjs";

export function renderReportHtml(model, { lang = DEFAULT_LANG } = {}) {
  const L = getLabels(lang);
  const parts = [];
  parts.push("<!doctype html>");
  parts.push(`<html lang="${L.htmlLang}"><head><meta charset="utf-8">`);
  parts.push(`<title>${esc(L.title)}: ${esc(model.runId)}</title>`);
  parts.push(
    "<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}h2{margin-top:2rem}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}.advisory{color:#8a6d3b}</style>"
  );
  parts.push("</head><body>");
  parts.push(`<h1>${esc(L.title)}: ${esc(model.runId)}</h1>`);
  parts.push(
    `<p>${esc(L.profile)}: <code>${esc(model.profile)}</code> &middot; ${esc(L.gateStatus)}: <strong>${esc(model.gateStatus)}</strong></p>`
  );

  if (model.gateReasons.length > 0) {
    parts.push(`<p>${esc(L.gateReasons)}:</p><ul>`);
    for (const reason of model.gateReasons) {
      parts.push(`<li>${esc(reason)}</li>`);
    }
    parts.push("</ul>");
  }
  if (model.gateWarnings.length > 0) {
    parts.push(`<p>${esc(L.gateWarnings)}:</p><ul>`);
    for (const warning of model.gateWarnings) {
      parts.push(`<li>${esc(warning)}</li>`);
    }
    parts.push("</ul>");
  }

  parts.push(`<h2>${esc(L.changeset)}</h2>`);
  if (!model.changeset || !model.changeset.available) {
    parts.push(
      `<p>${esc(
        model.changeset?.reason
          ? L.noChangesetReason(model.changeset.reason)
          : L.noChangesetFrozen
      )}</p>`
    );
  } else {
    parts.push("<table><tbody>");
    parts.push(`<tr><th>${esc(L.base)}</th><td>${esc(model.changeset.base)} (${esc(shortSha(model.changeset.baseSha))})</td></tr>`);
    parts.push(`<tr><th>${esc(L.head)}</th><td>${esc(model.changeset.head)} (${esc(shortSha(model.changeset.headSha))})</td></tr>`);
    parts.push(`<tr><th>${esc(L.filesChanged)}</th><td>${esc(String(model.changeset.fileCount))}</td></tr>`);
    parts.push(
      `<tr><th>${esc(L.patchTruncated)}</th><td>${model.changeset.patchTruncated ? esc(L.patchTruncatedYes) : esc(L.patchTruncatedNo)}</td></tr>`
    );
    parts.push("</tbody></table>");
    const files = model.changeset.files || [];
    if (files.length > 0) {
      parts.push(`<table><thead><tr><th>${esc(L.status)}</th><th>${esc(L.path)}</th></tr></thead><tbody>`);
      for (const file of files) {
        parts.push(`<tr><td>${esc(file.status)}</td><td>${esc(file.path)}</td></tr>`);
      }
      parts.push("</tbody></table>");
    }
  }

  parts.push(`<h2>${esc(L.findingsTitle)}</h2>`);
  if (model.findings.length === 0) {
    parts.push(`<p>${esc(L.noFindings)}</p>`);
  } else {
    parts.push(
      `<table><thead><tr><th>${esc(L.fNum)}</th><th>${esc(L.fTitle)}</th><th>${esc(L.fSeverity)}</th><th>${esc(L.fStatus)}</th><th>${esc(L.fReviewers)}</th><th>${esc(L.fCount)}</th></tr></thead><tbody>`
    );
    model.findings.forEach((finding, index) => {
      const reviewers = (finding.sourceRunnerIds || []).join(", ") || finding.sourceRunnerId || "unknown";
      parts.push(
        `<tr><td>F${index + 1}</td><td>${esc(finding.title)}</td><td>${esc(finding.severity)}</td><td>${esc(finding.status)}</td><td>${esc(reviewers)}</td><td>${esc(String(finding.reviewerCount || 0))}</td></tr>`
      );
    });
    parts.push("</tbody></table>");
    model.findings.forEach((finding, index) => {
      if (finding.description || finding.suggestion) {
        parts.push(`<details><summary>F${index + 1}: ${esc(L.fDescription)} & ${esc(L.fSuggestion)}</summary>`);
        if (finding.description) {
          parts.push(`<p><strong>${esc(L.fDescription)}:</strong> ${esc(finding.description)}</p>`);
        }
        if (finding.suggestion) {
          parts.push(`<p><strong>${esc(L.fSuggestion)}:</strong> ${esc(finding.suggestion)}</p>`);
        }
        parts.push(`</details>`);
      }
    });
  }
  const consensusFindings = model.findings.filter((finding) => (finding.reviewerCount || 0) >= 2);
  parts.push(`<h2>${esc(L.consensusTitle)}</h2>`);
  if (consensusFindings.length === 0) {
    parts.push(`<p>${esc(L.noConsensus)}</p>`);
  } else {
    parts.push(
      `<table><thead><tr><th>${esc(L.fNum)}</th><th>${esc(L.fTitle)}</th><th>${esc(L.fSeverity)}</th><th>${esc(L.fReviewers)}</th><th>${esc(L.fCount)}</th></tr></thead><tbody>`
    );
    consensusFindings.forEach((finding, index) => {
      const reviewers = (finding.sourceRunnerIds || []).join(", ") || finding.sourceRunnerId || "unknown";
      parts.push(
        `<tr><td>G${index + 1}</td><td>${esc(finding.title)}</td><td>${esc(finding.severity)}</td><td>${esc(reviewers)}</td><td>${esc(String(finding.reviewerCount || 0))}</td></tr>`
      );
    });
    parts.push("</tbody></table>");
  }

  parts.push(`<h2>${esc(L.scoresTitle)}</h2>`);
  if (model.scores.length === 0) {
    parts.push(`<p>${esc(L.noScores)}</p>`);
  } else {
    parts.push(`<table><thead><tr><th>${esc(L.sReviewer)}</th><th>${esc(L.sScore)}</th><th>${esc(L.sFindings)}</th><th>${esc(L.sConsensus)}</th><th>${esc(L.sRole)}</th></tr></thead><tbody>`);
    for (const score of model.scores) {
      const consensusPct = score.stats.findingCount
        ? Math.round((score.stats.corroboratedCount / score.stats.findingCount) * 100)
        : 0;
      parts.push(
        `<tr><td>${esc(score.runnerId)}</td><td>${esc(String(score.overall))}</td><td>${esc(String(score.stats.findingCount))}</td><td>${esc(String(consensusPct))}%</td><td>${esc(score.role || "-")}</td></tr>`
      );
    }
    parts.push("</tbody></table>");
    if (model.ranking.length > 0) {
      parts.push(`<p>${esc(L.ranking)}: ${esc(model.ranking.join(" > "))}</p>`);
    }
  }

  parts.push(`<h2 class="advisory">${esc(L.principlesTitle)}</h2>`);
  if (model.inducedCandidates.length === 0) {
    parts.push(`<p>${esc(L.noPrinciples)}</p>`);
  } else {
    parts.push(
      `<table><thead><tr><th>${esc(L.pNum)}</th><th>${esc(L.pPriority)}</th><th>${esc(L.pStatement)}</th><th>${esc(L.pId)}</th></tr></thead><tbody>`
    );
    model.inducedCandidates.forEach((candidate, index) => {
      parts.push(
        `<tr><td>P${index + 1}</td><td>${esc(candidate.priority)}</td><td>${esc(candidate.statement)}</td><td><code>${esc(candidate.id)}</code></td></tr>`
      );
    });
    parts.push("</tbody></table>");
  }

  parts.push(`<h2>${esc(L.decisionsTitle)}</h2><ul>`);
  parts.push(`<li>${esc(L.gateDecision)}: ${esc(model.gateStatus)}</li>`);
  parts.push(`<li>${esc(L.findingsLabel)}: ${esc(L.totalFindings(model.findings.length, consensusFindings.length))}</li>`);
  parts.push(`<li>${esc(L.inducedLabel)}: ${esc(L.inducedCount(model.inducedCandidates.length))}</li>`);
  parts.push("</ul>");

  if (model.reviewType === "full-project") {
    if (model.projectOverview) {
      parts.push(`<h2>${esc(L.projectOverviewTitle)}</h2>`);
      const po = model.projectOverview;
      parts.push("<table><tbody>");
      if (po.name) parts.push(`<tr><th>${esc(L.projectName)}</th><td>${esc(po.name)}</td></tr>`);
      if (po.version) parts.push(`<tr><th>${esc(L.projectVersion)}</th><td>${esc(po.version)}</td></tr>`);
      if (po.scope) parts.push(`<tr><th>${esc(L.reviewScope)}</th><td>${esc(po.scope)}</td></tr>`);
      if (po.techStack) parts.push(`<tr><th>${esc(L.techStack)}</th><td>${esc(po.techStack)}</td></tr>`);
      if (po.codeScale) parts.push(`<tr><th>${esc(L.codeScale)}</th><td>${esc(po.codeScale)}</td></tr>`);
      if (po.reviewerCount) parts.push(`<tr><th>${esc(L.reviewerCountLabel)}</th><td>${esc(String(po.reviewerCount))}</td></tr>`);
      parts.push("</tbody></table>");
    }

    if (model.reviewerDetails.length > 0) {
      parts.push(`<h2>${esc(L.reviewerDetailsTitle)}</h2>`);
      model.reviewerDetails.forEach((rd, index) => {
        const label = `R${index + 1}: ${rd.runnerId || rd.name}`;
        parts.push(`<details><summary>${esc(label)}</summary>`);
        if (rd.role) parts.push(`<p><strong>${esc(L.sRole)}</strong>: ${esc(rd.role)}</p>`);
        if (Array.isArray(rd.subDimensions) && rd.subDimensions.length > 0) {
          parts.push(`<table><thead><tr><th>${esc(L.rSubDim)}</th><th>${esc(L.rScore)}</th><th>${esc(L.rFinding)}</th></tr></thead><tbody>`);
          for (const sub of rd.subDimensions) {
            parts.push(`<tr><td>${esc(sub.name)}</td><td>${esc(String(sub.score))}</td><td>${esc(sub.finding || "")}</td></tr>`);
          }
          parts.push("</tbody></table>");
        }
        if (Array.isArray(rd.topIssues) && rd.topIssues.length > 0) {
          parts.push(`<p><strong>${esc(L.rTopIssues)}</strong></p>`);
          parts.push(`<table><thead><tr><th>${esc(L.rSeverity)}</th><th>${esc(L.rIssue)}</th><th>${esc(L.rLocation)}</th></tr></thead><tbody>`);
          for (const issue of rd.topIssues) {
            parts.push(`<tr><td>${esc(issue.severity)}</td><td>${esc(issue.issue)}</td><td>${esc(issue.location || "")}</td></tr>`);
          }
          parts.push("</tbody></table>");
        }
        if (Array.isArray(rd.improvements) && rd.improvements.length > 0) {
          parts.push(`<p><strong>${esc(L.rImprovements)}</strong></p>`);
          parts.push(`<table><thead><tr><th>${esc(L.rPriority)}</th><th>${esc(L.rSuggestion)}</th><th>${esc(L.rBenefit)}</th></tr></thead><tbody>`);
          for (const imp of rd.improvements) {
            parts.push(`<tr><td>${esc(imp.priority)}</td><td>${esc(imp.suggestion)}</td><td>${esc(imp.benefit || "")}</td></tr>`);
          }
          parts.push("</tbody></table>");
        }
        parts.push("</details>");
      });
    }

    if (model.riskMatrix.length > 0) {
      parts.push(`<h2>${esc(L.riskMatrixTitle)}</h2>`);
      parts.push(`<table><thead><tr><th>${esc(L.rskName)}</th><th>${esc(L.rskProb)}</th><th>${esc(L.rskImpact)}</th><th>${esc(L.rskScore)}</th><th>${esc(L.rskFindings)}</th></tr></thead><tbody>`);
      for (const risk of model.riskMatrix) {
        const findings = Array.isArray(risk.findings) ? risk.findings.join(", ") : (risk.findings || "");
        parts.push(`<tr><td>${esc(risk.name)}</td><td>${esc(String(risk.probability))}</td><td>${esc(String(risk.impact))}</td><td><strong>${esc(String(risk.probability * risk.impact))}</strong></td><td>${esc(findings)}</td></tr>`);
      }
      parts.push("</tbody></table>");
    }

    if (model.actionPlan.length > 0) {
      parts.push(`<h2>${esc(L.actionPlanTitle)}</h2>`);
      parts.push(`<table><thead><tr><th>${esc(L.actPriority)}</th><th>${esc(L.actAction)}</th><th>${esc(L.actEffort)}</th><th>${esc(L.actFindings)}</th></tr></thead><tbody>`);
      for (const action of model.actionPlan) {
        const findings = Array.isArray(action.findings) ? action.findings.join(", ") : (action.findings || "");
        parts.push(`<tr><td>${esc(action.priority)}</td><td>${esc(action.action)}</td><td>${esc(action.effort || "")}</td><td>${esc(findings)}</td></tr>`);
      }
      parts.push("</tbody></table>");
    }

    if (model.overallGrade) {
      const og = model.overallGrade;
      parts.push(`<h2>${esc(L.overallGradeTitle)}</h2>`);
      if (Array.isArray(og.dimensions) && og.dimensions.length > 0) {
        parts.push(`<table><thead><tr><th>${esc(L.ogDim)}</th><th>${esc(L.ogScore)}</th><th>${esc(L.ogReviewer)}</th></tr></thead><tbody>`);
        for (const dim of og.dimensions) {
          parts.push(`<tr><td>${esc(dim.name)}</td><td>${esc(String(dim.score))}</td><td>${esc(dim.reviewer || "")}</td></tr>`);
        }
        parts.push("</tbody></table>");
      }
      if (og.grade) parts.push(`<p><strong>${esc(L.ogGrade)}</strong>: ${esc(og.grade)}</p>`);
      if (og.reason) parts.push(`<p><strong>${esc(L.ogReason)}</strong>: ${esc(og.reason)}</p>`);
      if (og.upgradePath) parts.push(`<p><strong>${esc(L.ogUpgradePath)}</strong>: ${esc(og.upgradePath)}</p>`);
    }
  }

  parts.push("</body></html>");
  return `${parts.join("\n")}\n`;
}
