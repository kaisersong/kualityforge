import { DEFAULT_LANG, getLabels } from "./report-labels.mjs";
import { mdCell, shortSha } from "./report-format.mjs";

export function renderReportMarkdown(model, { lang = DEFAULT_LANG } = {}) {
  const L = getLabels(lang);
  const lines = [`# ${L.title}: ${model.runId}`, ""];

  lines.push(`| ${L.field} | ${L.value} |`);
  lines.push("| --- | --- |");
  lines.push(`| ${L.profile} | ${mdCell(model.profile)} |`);
  lines.push(`| ${L.gateStatus} | ${mdCell(model.gateStatus)} |`);
  if (model.gateReasons.length > 0) {
    lines.push(`| ${L.gateReasons} | ${model.gateReasons.map(mdCell).join("<br>")} |`);
  }
  if (model.gateWarnings.length > 0) {
    lines.push(`| ${L.gateWarnings} | ${model.gateWarnings.map(mdCell).join("<br>")} |`);
  }
  lines.push("");

  lines.push(`## ${L.changeset}`, "");
  if (!model.changeset || !model.changeset.available) {
    lines.push(
      model.changeset?.reason
        ? L.noChangesetReason(model.changeset.reason)
        : L.noChangesetFrozen
    );
    lines.push("");
  } else {
    lines.push(`| ${L.field} | ${L.value} |`);
    lines.push("| --- | --- |");
    lines.push(`| ${L.base} | ${mdCell(model.changeset.base)} (${mdCell(shortSha(model.changeset.baseSha))}) |`);
    lines.push(`| ${L.head} | ${mdCell(model.changeset.head)} (${mdCell(shortSha(model.changeset.headSha))}) |`);
    lines.push(`| ${L.filesChanged} | ${mdCell(String(model.changeset.fileCount))} |`);
    lines.push(`| ${L.patchTruncated} | ${model.changeset.patchTruncated ? L.patchTruncatedYes : L.patchTruncatedNo} |`);
    lines.push("");
    const files = model.changeset.files || [];
    if (files.length > 0) {
      lines.push(`| ${L.status} | ${L.path} |`);
      lines.push("| --- | --- |");
      for (const file of files) {
        lines.push(`| ${mdCell(file.status)} | ${mdCell(file.path)} |`);
      }
      lines.push("");
    }
  }

  lines.push(`## ${L.findingsTitle}`, "");
  if (model.findings.length === 0) {
    lines.push(L.noFindings);
  } else {
    lines.push(`| ${L.fNum} | ${L.fTitle} | ${L.fSeverity} | ${L.fStatus} | ${L.fReviewers} | ${L.fCount} |`);
    lines.push("| --- | --- | --- | --- | --- | --- |");
    model.findings.forEach((finding, index) => {
      const reviewers = (finding.sourceRunnerIds || []).join(", ") || finding.sourceRunnerId || "unknown";
      lines.push(
        `| F${index + 1} | ${mdCell(finding.title)} | ${mdCell(finding.severity)} | ${mdCell(finding.status)} | ${mdCell(reviewers)} | ${finding.reviewerCount || 0} |`
      );
    });
    lines.push("");
    model.findings.forEach((finding, index) => {
      if (finding.description || finding.suggestion) {
        lines.push(`### F${index + 1}: ${L.fDescription} & ${L.fSuggestion}`);
        lines.push("");
        if (finding.description) {
          lines.push(`**${L.fDescription}:** ${finding.description}`);
          lines.push("");
        }
        if (finding.suggestion) {
          lines.push(`**${L.fSuggestion}:** ${finding.suggestion}`);
          lines.push("");
        }
      }
    });
  }
  lines.push("");

  const consensusFindings = model.findings.filter((finding) => (finding.reviewerCount || 0) >= 2);
  lines.push(`## ${L.consensusTitle}`, "");
  if (consensusFindings.length === 0) {
    lines.push(L.noConsensus);
  } else {
    lines.push(`| ${L.fNum} | ${L.fTitle} | ${L.fSeverity} | ${L.fReviewers} | ${L.fCount} |`);
    lines.push("| --- | --- | --- | --- | --- |");
    consensusFindings.forEach((finding, index) => {
      const reviewers = (finding.sourceRunnerIds || []).join(", ") || finding.sourceRunnerId || "unknown";
      lines.push(
        `| G${index + 1} | ${mdCell(finding.title)} | ${mdCell(finding.severity)} | ${mdCell(reviewers)} | ${finding.reviewerCount || 0} |`
      );
    });
  }
  lines.push("");

  lines.push(`## ${L.scoresTitle}`, "");
  if (model.scores.length === 0) {
    lines.push(L.noScores);
  } else {
    lines.push(`| ${L.sReviewer} | ${L.sScore} | ${L.sFindings} | ${L.sConsensus} | ${L.sRole} |`);
    lines.push("| --- | --- | --- | --- | --- |");
    for (const score of model.scores) {
      const consensusPct = score.stats.findingCount
        ? Math.round((score.stats.corroboratedCount / score.stats.findingCount) * 100)
        : 0;
      lines.push(
        `| ${mdCell(score.runnerId)} | ${score.overall} | ${score.stats.findingCount} | ${consensusPct}% | ${mdCell(score.role || "-")} |`
      );
    }
    if (model.ranking.length > 0) {
      lines.push("");
      lines.push(`${L.ranking}: ${model.ranking.join(" > ")}`);
    }
  }
  lines.push("");

  lines.push(`## ${L.principlesTitle}`, "");
  if (model.inducedCandidates.length === 0) {
    lines.push(L.noPrinciples);
  } else {
    lines.push(`| ${L.pNum} | ${L.pPriority} | ${L.pStatement} | ${L.pId} |`);
    lines.push("| --- | --- | --- | --- |");
    model.inducedCandidates.forEach((candidate, index) => {
      lines.push(
        `| P${index + 1} | ${mdCell(candidate.priority)} | ${mdCell(candidate.statement)} | ${mdCell(candidate.id)} |`
      );
    });
  }
  lines.push("");

  lines.push(`## ${L.decisionsTitle}`, "");
  lines.push(`| ${L.field} | ${L.value} |`);
  lines.push("| --- | --- |");
  lines.push(`| ${L.gateDecision} | ${mdCell(model.gateStatus)} |`);
  lines.push(`| ${L.findingsLabel} | ${L.totalFindings(model.findings.length, consensusFindings.length)} |`);
  lines.push(`| ${L.inducedLabel} | ${L.inducedCount(model.inducedCandidates.length)} |`);
  lines.push("");

  if (model.reviewType === "full-project") {
    if (model.projectOverview) {
      lines.push(`## ${L.projectOverviewTitle}`, "");
      const po = model.projectOverview;
      lines.push(`| ${L.field} | ${L.value} |`);
      lines.push("| --- | --- |");
      if (po.name) lines.push(`| ${L.projectName} | ${mdCell(po.name)} |`);
      if (po.version) lines.push(`| ${L.projectVersion} | ${mdCell(po.version)} |`);
      if (po.scope) lines.push(`| ${L.reviewScope} | ${mdCell(po.scope)} |`);
      if (po.techStack) lines.push(`| ${L.techStack} | ${mdCell(po.techStack)} |`);
      if (po.codeScale) lines.push(`| ${L.codeScale} | ${mdCell(po.codeScale)} |`);
      if (po.reviewerCount) lines.push(`| ${L.reviewerCountLabel} | ${mdCell(String(po.reviewerCount))} |`);
      lines.push("");
    }

    if (model.reviewerDetails.length > 0) {
      lines.push(`## ${L.reviewerDetailsTitle}`, "");
      model.reviewerDetails.forEach((rd, index) => {
        lines.push(`### R${index + 1}: ${mdCell(rd.runnerId || rd.name)}`, "");
        if (rd.role) lines.push(`**${L.sRole}**: ${mdCell(rd.role)}`, "");
        if (Array.isArray(rd.subDimensions) && rd.subDimensions.length > 0) {
          lines.push(`| ${L.rSubDim} | ${L.rScore} | ${L.rFinding} |`);
          lines.push("| --- | --- | --- |");
          for (const sub of rd.subDimensions) {
            lines.push(`| ${mdCell(sub.name)} | ${sub.score} | ${mdCell(sub.finding || "")} |`);
          }
          lines.push("");
        }
        if (Array.isArray(rd.topIssues) && rd.topIssues.length > 0) {
          lines.push(`**${L.rTopIssues}**:`, "");
          lines.push(`| ${L.rSeverity} | ${L.rIssue} | ${L.rLocation} |`);
          lines.push("| --- | --- | --- |");
          for (const issue of rd.topIssues) {
            lines.push(`| ${mdCell(issue.severity)} | ${mdCell(issue.issue)} | ${mdCell(issue.location || "")} |`);
          }
          lines.push("");
        }
        if (Array.isArray(rd.improvements) && rd.improvements.length > 0) {
          lines.push(`**${L.rImprovements}**:`, "");
          lines.push(`| ${L.rPriority} | ${L.rSuggestion} | ${L.rBenefit} |`);
          lines.push("| --- | --- | --- |");
          for (const imp of rd.improvements) {
            lines.push(`| ${mdCell(imp.priority)} | ${mdCell(imp.suggestion)} | ${mdCell(imp.benefit || "")} |`);
          }
          lines.push("");
        }
      });
    }

    if (model.riskMatrix.length > 0) {
      lines.push(`## ${L.riskMatrixTitle}`, "");
      lines.push(`| ${L.rskName} | ${L.rskProb} | ${L.rskImpact} | ${L.rskScore} | ${L.rskFindings} |`);
      lines.push("| --- | --- | --- | --- | --- |");
      for (const risk of model.riskMatrix) {
        const findings = Array.isArray(risk.findings) ? risk.findings.join(", ") : (risk.findings || "");
        lines.push(`| ${mdCell(risk.name)} | ${risk.probability} | ${risk.impact} | **${risk.probability * risk.impact}** | ${mdCell(findings)} |`);
      }
      lines.push("");
    }

    if (model.actionPlan.length > 0) {
      lines.push(`## ${L.actionPlanTitle}`, "");
      lines.push(`| ${L.actPriority} | ${L.actAction} | ${L.actEffort} | ${L.actFindings} |`);
      lines.push("| --- | --- | --- | --- |");
      for (const action of model.actionPlan) {
        const findings = Array.isArray(action.findings) ? action.findings.join(", ") : (action.findings || "");
        lines.push(`| ${mdCell(action.priority)} | ${mdCell(action.action)} | ${mdCell(action.effort || "")} | ${mdCell(findings)} |`);
      }
      lines.push("");
    }

    if (model.overallGrade) {
      const og = model.overallGrade;
      lines.push(`## ${L.overallGradeTitle}`, "");
      if (Array.isArray(og.dimensions) && og.dimensions.length > 0) {
        lines.push(`| ${L.ogDim} | ${L.ogScore} | ${L.ogReviewer} |`);
        lines.push("| --- | --- | --- |");
        for (const dim of og.dimensions) {
          lines.push(`| ${mdCell(dim.name)} | ${dim.score} | ${mdCell(dim.reviewer || "")} |`);
        }
        lines.push("");
      }
      if (og.grade) lines.push(`**${L.ogGrade}**: ${mdCell(og.grade)}`, "");
      if (og.reason) lines.push(`**${L.ogReason}**: ${mdCell(og.reason)}`, "");
      if (og.upgradePath) lines.push(`**${L.ogUpgradePath}**: ${mdCell(og.upgradePath)}`, "");
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}
