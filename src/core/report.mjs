// Builds a human report (Markdown default, HTML on request) aggregating the
// gate result, frozen changeset, findings, reviewer scores, and induced
// principle candidates. Pure rendering — no IO. Std-lib only.

export const DEFAULT_REPORT_OUT_DIR = "/Users/song/projects/mydocs/kualityforge";

// Resolves the report output directory. Precedence: explicit value, then the
// KUALITYFORGE_REPORT_OUT_DIR environment variable, then the built-in default.
export function resolveReportOutDir(explicit, env = process.env) {
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const fromEnv = env?.KUALITYFORGE_REPORT_OUT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return DEFAULT_REPORT_OUT_DIR;
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

export function renderReportMarkdown(model) {
  const lines = [`# KualityForge Report: ${model.runId}`, ""];
  lines.push(`- Profile: ${model.profile}`);
  lines.push(`- Gate status: ${model.gateStatus}`);
  if (model.gateReasons.length > 0) {
    lines.push("- Gate reasons:");
    for (const reason of model.gateReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  if (model.gateWarnings.length > 0) {
    lines.push("- Gate warnings:");
    for (const warning of model.gateWarnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push("");

  lines.push("## Changeset", "");
  if (!model.changeset || !model.changeset.available) {
    lines.push(
      model.changeset?.reason
        ? `No changeset was frozen (${model.changeset.reason}).`
        : "No changeset was frozen."
    );
  } else {
    lines.push(`- Base: ${model.changeset.base} (${shortSha(model.changeset.baseSha)})`);
    lines.push(`- Head: ${model.changeset.head} (${shortSha(model.changeset.headSha)})`);
    lines.push(`- Files changed: ${model.changeset.fileCount}`);
    if (model.changeset.patchTruncated) {
      lines.push("- NOTE: patch was truncated; some hunks were out of scope.");
    }
    for (const file of model.changeset.files || []) {
      lines.push(`  - ${file.status} ${file.path}`);
    }
  }
  lines.push("");

  lines.push("## Findings", "");
  if (model.findings.length === 0) {
    lines.push("No findings were reported.");
  } else {
    for (const finding of model.findings) {
      const reviewers = (finding.sourceRunnerIds || []).join(", ");
      lines.push(`- ${finding.id} ${finding.title} [${finding.severity}]`);
      lines.push(`  - Status: ${finding.status}`);
      lines.push(`  - Reviewers: ${reviewers || finding.sourceRunnerId || "unknown"}`);
      lines.push(`  - Reviewer count: ${finding.reviewerCount || 0}`);
    }
  }
  lines.push("");

  lines.push("## Reviewer Scores", "");
  if (model.scores.length === 0) {
    lines.push("No reviewer scores were computed.");
  } else {
    lines.push("| Reviewer | Score | Findings | Consensus | Role |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const score of model.scores) {
      const consensusPct = score.stats.findingCount
        ? Math.round((score.stats.corroboratedCount / score.stats.findingCount) * 100)
        : 0;
      lines.push(
        `| ${score.runnerId} | ${score.overall} | ${score.stats.findingCount} | ${consensusPct}% | ${score.role || "-"} |`
      );
    }
    if (model.ranking.length > 0) {
      lines.push("");
      lines.push(`Ranking: ${model.ranking.join(" > ")}`);
    }
  }
  lines.push("");

  lines.push("## Induced Principle Candidates (advisory)", "");
  if (model.inducedCandidates.length === 0) {
    lines.push("No candidate principles were induced.");
  } else {
    for (const candidate of model.inducedCandidates) {
      lines.push(`- ${candidate.id} (${candidate.priority}): ${candidate.statement}`);
    }
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

export function renderReportHtml(model) {
  const parts = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push(`<title>KualityForge Report: ${esc(model.runId)}</title>`);
  parts.push(
    "<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}h2{margin-top:2rem}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}.advisory{color:#8a6d3b}</style>"
  );
  parts.push("</head><body>");
  parts.push(`<h1>KualityForge Report: ${esc(model.runId)}</h1>`);
  parts.push(
    `<p>Profile: <code>${esc(model.profile)}</code> &middot; Gate status: <strong>${esc(model.gateStatus)}</strong></p>`
  );

  if (model.gateReasons.length > 0) {
    parts.push("<p>Gate reasons:</p><ul>");
    for (const reason of model.gateReasons) {
      parts.push(`<li>${esc(reason)}</li>`);
    }
    parts.push("</ul>");
  }
  if (model.gateWarnings.length > 0) {
    parts.push("<p>Gate warnings:</p><ul>");
    for (const warning of model.gateWarnings) {
      parts.push(`<li>${esc(warning)}</li>`);
    }
    parts.push("</ul>");
  }

  parts.push("<h2>Changeset</h2>");
  if (!model.changeset || !model.changeset.available) {
    parts.push(
      `<p>${esc(
        model.changeset?.reason
          ? `No changeset was frozen (${model.changeset.reason}).`
          : "No changeset was frozen."
      )}</p>`
    );
  } else {
    parts.push("<ul>");
    parts.push(`<li>Base: ${esc(model.changeset.base)} (${esc(shortSha(model.changeset.baseSha))})</li>`);
    parts.push(`<li>Head: ${esc(model.changeset.head)} (${esc(shortSha(model.changeset.headSha))})</li>`);
    parts.push(`<li>Files changed: ${esc(String(model.changeset.fileCount))}</li>`);
    if (model.changeset.patchTruncated) {
      parts.push("<li>NOTE: patch was truncated; some hunks were out of scope.</li>");
    }
    parts.push("</ul><ul>");
    for (const file of model.changeset.files || []) {
      parts.push(`<li>${esc(file.status)} ${esc(file.path)}</li>`);
    }
    parts.push("</ul>");
  }

  parts.push("<h2>Findings</h2>");
  if (model.findings.length === 0) {
    parts.push("<p>No findings were reported.</p>");
  } else {
    parts.push("<ul>");
    for (const finding of model.findings) {
      const reviewers = (finding.sourceRunnerIds || []).join(", ") || finding.sourceRunnerId || "unknown";
      parts.push(
        `<li><strong>${esc(finding.id)}</strong> ${esc(finding.title)} [${esc(finding.severity)}] — status ${esc(finding.status)}, reviewers ${esc(reviewers)} (count ${esc(String(finding.reviewerCount || 0))})</li>`
      );
    }
    parts.push("</ul>");
  }

  parts.push("<h2>Reviewer Scores</h2>");
  if (model.scores.length === 0) {
    parts.push("<p>No reviewer scores were computed.</p>");
  } else {
    parts.push("<table><thead><tr><th>Reviewer</th><th>Score</th><th>Findings</th><th>Consensus</th><th>Role</th></tr></thead><tbody>");
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
      parts.push(`<p>Ranking: ${esc(model.ranking.join(" > "))}</p>`);
    }
  }

  parts.push('<h2 class="advisory">Induced Principle Candidates (advisory)</h2>');
  if (model.inducedCandidates.length === 0) {
    parts.push("<p>No candidate principles were induced.</p>");
  } else {
    parts.push("<ul>");
    for (const candidate of model.inducedCandidates) {
      parts.push(
        `<li><strong>${esc(candidate.id)}</strong> (${esc(candidate.priority)}): ${esc(candidate.statement)}</li>`
      );
    }
    parts.push("</ul>");
  }

  parts.push("</body></html>");
  return `${parts.join("\n")}\n`;
}

function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 12) : sha || "unknown";
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
