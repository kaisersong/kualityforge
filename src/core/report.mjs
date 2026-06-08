// Builds a human report (Markdown default, HTML on request) aggregating the
// gate result, frozen changeset, findings, reviewer scores, and induced
// principle candidates. Pure rendering — no IO. Std-lib only.

export const DEFAULT_REPORT_OUT_DIR = "kualityforge-reports";
export const DEFAULT_LANG = "zh";

const LABELS = {
  zh: {
    title: "KualityForge 评审报告",
    field: "字段", value: "值",
    profile: "Profile", gateStatus: "Gate 状态",
    gateReasons: "Gate 原因", gateWarnings: "Gate 警告",
    changeset: "变更集",
    noChangesetFrozen: "未冻结变更集",
    noChangesetReason: (r) => `未冻结变更集（${r}）`,
    base: "Base", head: "Head", filesChanged: "变更文件数",
    patchTruncated: "Patch 截断",
    patchTruncatedYes: "是（部分 hunk 超出范围）", patchTruncatedNo: "否",
    status: "状态", path: "路径",
    findingsTitle: "发现 (F#)",
    noFindings: "未发现问题。",
    fNum: "#", fTitle: "标题", fSeverity: "严重程度", fStatus: "状态", fReviewers: "评审员", fCount: "数量", fId: "Id",
    consensusTitle: "共识发现 (G#)",
    noConsensus: "无共识发现（>=2 名评审员）。",
    scoresTitle: "评审员评分",
    noScores: "未计算评审员评分。",
    sReviewer: "评审员", sScore: "分数", sFindings: "Findings 数", sConsensus: "共识率", sRole: "角色",
    ranking: "排名",
    principlesTitle: "归纳质量原则候选 (P#, 咨询性)",
    noPrinciples: "未归纳候选原则。",
    pNum: "#", pPriority: "优先级", pStatement: "描述", pId: "Id",
    decisionsTitle: "决策与验证",
    gateDecision: "Gate 决策",
    totalFindings: (total, consensus) => `${total} 个，${consensus} 个达成共识`,
    inducedCount: (n) => `${n} 个（咨询性；是否纳入由人工决定）`,
    findingsLabel: "总发现数", inducedLabel: "归纳候选原则",
    reviewType: "评审模式", reviewTypeChangeset: "变更集评审", reviewTypeFullProject: "全量项目评审",
    projectOverviewTitle: "项目概览",
    projectName: "项目名称", projectVersion: "版本", reviewScope: "评审范围",
    techStack: "技术栈", codeScale: "代码规模", reviewerCountLabel: "评审员数",
    reviewerDetailsTitle: "评审员详细分析 (R#)",
    rSubDim: "子维度", rScore: "评分", rFinding: "关键发现",
    rTopIssues: "Top 问题", rSeverity: "严重度", rIssue: "问题", rLocation: "位置",
    rImprovements: "改进建议", rPriority: "优先级", rSuggestion: "建议", rBenefit: "预期收益",
    riskMatrixTitle: "风险矩阵",
    rskName: "风险", rskProb: "概率", rskImpact: "影响", rskScore: "风险分", rskCategory: "类别", rskFindings: "关联 Finding",
    actionPlanTitle: "行动路线",
    actPriority: "优先级", actAction: "行动", actEffort: "预估投入", actFindings: "关联 Finding",
    overallGradeTitle: "综合评级",
    ogDim: "维度", ogScore: "评分", ogReviewer: "评审员",
    ogGrade: "综合评级", ogReason: "评级理由", ogUpgradePath: "升级路径",
    htmlLang: "zh",
  },
  en: {
    title: "KualityForge Report",
    field: "Field", value: "Value",
    profile: "Profile", gateStatus: "Gate status",
    gateReasons: "Gate reasons", gateWarnings: "Gate warnings",
    changeset: "Changeset",
    noChangesetFrozen: "No changeset was frozen.",
    noChangesetReason: (r) => `No changeset was frozen (${r}).`,
    base: "Base", head: "Head", filesChanged: "Files changed",
    patchTruncated: "Patch truncated",
    patchTruncatedYes: "yes (some hunks out of scope)", patchTruncatedNo: "no",
    status: "Status", path: "Path",
    findingsTitle: "Findings (F#)",
    noFindings: "No findings were reported.",
    fNum: "#", fTitle: "Title", fSeverity: "Severity", fStatus: "Status", fReviewers: "Reviewers", fCount: "Count", fId: "Id",
    consensusTitle: "Consensus Findings (G#)",
    noConsensus: "No findings reached consensus (>= 2 reviewers).",
    scoresTitle: "Reviewer Scores",
    noScores: "No reviewer scores were computed.",
    sReviewer: "Reviewer", sScore: "Score", sFindings: "Findings", sConsensus: "Consensus", sRole: "Role",
    ranking: "Ranking",
    principlesTitle: "Induced Principle Candidates (P#, advisory)",
    noPrinciples: "No candidate principles were induced.",
    pNum: "#", pPriority: "Priority", pStatement: "Statement", pId: "Id",
    decisionsTitle: "Decisions & Verification",
    gateDecision: "Gate decision",
    totalFindings: (total, consensus) => `${total} total, ${consensus} at consensus`,
    inducedCount: (n) => `${n} (advisory; human decides adoption)`,
    findingsLabel: "Findings", inducedLabel: "Induced candidates",
    reviewType: "Review type", reviewTypeChangeset: "Changeset review", reviewTypeFullProject: "Full-project review",
    projectOverviewTitle: "Project Overview",
    projectName: "Project", projectVersion: "Version", reviewScope: "Scope",
    techStack: "Tech stack", codeScale: "Code scale", reviewerCountLabel: "Reviewers",
    reviewerDetailsTitle: "Reviewer Details (R#)",
    rSubDim: "Sub-dimension", rScore: "Score", rFinding: "Key findings",
    rTopIssues: "Top issues", rSeverity: "Severity", rIssue: "Issue", rLocation: "Location",
    rImprovements: "Improvements", rPriority: "Priority", rSuggestion: "Suggestion", rBenefit: "Expected benefit",
    riskMatrixTitle: "Risk Matrix",
    rskName: "Risk", rskProb: "Prob", rskImpact: "Impact", rskScore: "Risk score", rskCategory: "Category", rskFindings: "Related findings",
    actionPlanTitle: "Action Plan",
    actPriority: "Priority", actAction: "Action", actEffort: "Effort", actFindings: "Related findings",
    overallGradeTitle: "Overall Grade",
    ogDim: "Dimension", ogScore: "Score", ogReviewer: "Reviewer",
    ogGrade: "Grade", ogReason: "Rationale", ogUpgradePath: "Upgrade path",
    htmlLang: "en",
  }
};

function getLabels(lang) {
  return LABELS[lang] || LABELS[DEFAULT_LANG];
}

// Resolves the report output directory. Precedence: explicit value, then the
// KUALITYFORGE_REPORT_OUT_DIR environment variable, then the supplied fallback
// (which defaults to the portable, relative DEFAULT_REPORT_OUT_DIR).
export function resolveReportOutDir(explicit, env = process.env, fallback = DEFAULT_REPORT_OUT_DIR) {
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const fromEnv = env?.KUALITYFORGE_REPORT_OUT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return fallback;
}

export function buildReportModel({
  manifest = {},
  summaryMarkdown = "",
  scores = null,
  inducedPrinciples = null,
  changeset = null,
  gate = null,
  reviewType = "changeset",
  projectOverview = null,
  reviewerDetails = null,
  riskMatrix = null,
  actionPlan = null,
  overallGrade = null
} = {}) {
  return {
    runId: manifest.runId || "unknown-run",
    profile: manifest.profile || "default",
    gateStatus: gate?.status || manifest.status || "unknown",
    gateReasons: Array.isArray(gate?.reasons) ? gate.reasons : [],
    gateWarnings: Array.isArray(gate?.warnings) ? gate.warnings : [],
    changeset,
    findings: Array.isArray(manifest.findings) ? manifest.findings : [],
    reviewers: Array.isArray(manifest.reviewers) ? manifest.reviewers : [],
    reviewOutcomes: Array.isArray(manifest.reviewOutcomes) ? manifest.reviewOutcomes : [],
    scores: scores?.scores || [],
    ranking: scores?.ranking || [],
    inducedCandidates: inducedPrinciples?.candidates || [],
    summaryMarkdown,
    reviewType,
    projectOverview,
    reviewerDetails: Array.isArray(reviewerDetails) ? reviewerDetails : [],
    riskMatrix: Array.isArray(riskMatrix) ? riskMatrix : [],
    actionPlan: Array.isArray(actionPlan) ? actionPlan : [],
    overallGrade
  };
}

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
      `<table><thead><tr><th>${esc(L.fNum)}</th><th>${esc(L.fTitle)}</th><th>${esc(L.fSeverity)}</th><th>${esc(L.fStatus)}</th><th>${esc(L.fReviewers)}</th><th>${esc(L.fCount)}</th><th>${esc(L.fId)}</th></tr></thead><tbody>`
    );
    model.findings.forEach((finding, index) => {
      const reviewers = (finding.sourceRunnerIds || []).join(", ") || finding.sourceRunnerId || "unknown";
      parts.push(
        `<tr><td>F${index + 1}</td><td>${esc(finding.title)}</td><td>${esc(finding.severity)}</td><td>${esc(finding.status)}</td><td>${esc(reviewers)}</td><td>${esc(String(finding.reviewerCount || 0))}</td><td><code>${esc(finding.id)}</code></td></tr>`
      );
    });
    parts.push("</tbody></table>");
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

function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 12) : sha || "unknown";
}

function mdCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
