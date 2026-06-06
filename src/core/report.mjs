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
  gate = null
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
    summaryMarkdown
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
