// Builds a human report (Markdown default, HTML on request) aggregating the
// gate result, frozen changeset, findings, reviewer scores, and induced
// principle candidates. Pure rendering — no IO. Std-lib only.

export const DEFAULT_REPORT_OUT_DIR = "kualityforge-reports";

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

export function renderReportMarkdown(model) {
  const lines = [`# KualityForge Report: ${model.runId}`, ""];

  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Profile | ${mdCell(model.profile)} |`);
  lines.push(`| Gate status | ${mdCell(model.gateStatus)} |`);
  if (model.gateReasons.length > 0) {
    lines.push(`| Gate reasons | ${model.gateReasons.map(mdCell).join("<br>")} |`);
  }
  if (model.gateWarnings.length > 0) {
    lines.push(`| Gate warnings | ${model.gateWarnings.map(mdCell).join("<br>")} |`);
  }
  lines.push("");

  lines.push("## Changeset", "");
  if (!model.changeset || !model.changeset.available) {
    lines.push(
      model.changeset?.reason
        ? `No changeset was frozen (${model.changeset.reason}).`
        : "No changeset was frozen."
    );
    lines.push("");
  } else {
    lines.push("| Field | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Base | ${mdCell(model.changeset.base)} (${mdCell(shortSha(model.changeset.baseSha))}) |`);
    lines.push(`| Head | ${mdCell(model.changeset.head)} (${mdCell(shortSha(model.changeset.headSha))}) |`);
    lines.push(`| Files changed | ${mdCell(String(model.changeset.fileCount))} |`);
    lines.push(`| Patch truncated | ${model.changeset.patchTruncated ? "yes (some hunks out of scope)" : "no"} |`);
    lines.push("");
    const files = model.changeset.files || [];
    if (files.length > 0) {
      lines.push("| Status | Path |");
      lines.push("| --- | --- |");
      for (const file of files) {
        lines.push(`| ${mdCell(file.status)} | ${mdCell(file.path)} |`);
      }
      lines.push("");
    }
  }

  lines.push("## Findings (F#)", "");
  if (model.findings.length === 0) {
    lines.push("No findings were reported.");
  } else {
    lines.push("| # | Title | Severity | Status | Reviewers | Count |");
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
  lines.push("## Consensus Findings (G#)", "");
  if (consensusFindings.length === 0) {
    lines.push("No findings reached consensus (>= 2 reviewers).");
  } else {
    lines.push("| # | Title | Severity | Reviewers | Count |");
    lines.push("| --- | --- | --- | --- | --- |");
    consensusFindings.forEach((finding, index) => {
      const reviewers = (finding.sourceRunnerIds || []).join(", ") || finding.sourceRunnerId || "unknown";
      lines.push(
        `| G${index + 1} | ${mdCell(finding.title)} | ${mdCell(finding.severity)} | ${mdCell(reviewers)} | ${finding.reviewerCount || 0} |`
      );
    });
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
        `| ${mdCell(score.runnerId)} | ${score.overall} | ${score.stats.findingCount} | ${consensusPct}% | ${mdCell(score.role || "-")} |`
      );
    }
    if (model.ranking.length > 0) {
      lines.push("");
      lines.push(`Ranking: ${model.ranking.join(" > ")}`);
    }
  }
  lines.push("");

  lines.push("## Induced Principle Candidates (P#, advisory)", "");
  if (model.inducedCandidates.length === 0) {
    lines.push("No candidate principles were induced.");
  } else {
    lines.push("| # | Priority | Statement | Id |");
    lines.push("| --- | --- | --- | --- |");
    model.inducedCandidates.forEach((candidate, index) => {
      lines.push(
        `| P${index + 1} | ${mdCell(candidate.priority)} | ${mdCell(candidate.statement)} | ${mdCell(candidate.id)} |`
      );
    });
  }
  lines.push("");

  lines.push("## Decisions & Verification", "");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Gate decision | ${mdCell(model.gateStatus)} |`);
  lines.push(`| Findings | ${model.findings.length} total, ${consensusFindings.length} at consensus |`);
  lines.push(
    `| Induced candidates | ${model.inducedCandidates.length} (advisory; human decides adoption) |`
  );
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
    parts.push("<table><tbody>");
    parts.push(`<tr><th>Base</th><td>${esc(model.changeset.base)} (${esc(shortSha(model.changeset.baseSha))})</td></tr>`);
    parts.push(`<tr><th>Head</th><td>${esc(model.changeset.head)} (${esc(shortSha(model.changeset.headSha))})</td></tr>`);
    parts.push(`<tr><th>Files changed</th><td>${esc(String(model.changeset.fileCount))}</td></tr>`);
    parts.push(
      `<tr><th>Patch truncated</th><td>${model.changeset.patchTruncated ? "yes (some hunks out of scope)" : "no"}</td></tr>`
    );
    parts.push("</tbody></table>");
    const files = model.changeset.files || [];
    if (files.length > 0) {
      parts.push("<table><thead><tr><th>Status</th><th>Path</th></tr></thead><tbody>");
      for (const file of files) {
        parts.push(`<tr><td>${esc(file.status)}</td><td>${esc(file.path)}</td></tr>`);
      }
      parts.push("</tbody></table>");
    }
  }

  parts.push("<h2>Findings (F#)</h2>");
  if (model.findings.length === 0) {
    parts.push("<p>No findings were reported.</p>");
  } else {
    parts.push(
      "<table><thead><tr><th>#</th><th>Title</th><th>Severity</th><th>Status</th><th>Reviewers</th><th>Count</th><th>Id</th></tr></thead><tbody>"
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
  parts.push("<h2>Consensus Findings (G#)</h2>");
  if (consensusFindings.length === 0) {
    parts.push("<p>No findings reached consensus (&gt;= 2 reviewers).</p>");
  } else {
    parts.push(
      "<table><thead><tr><th>#</th><th>Title</th><th>Severity</th><th>Reviewers</th><th>Count</th></tr></thead><tbody>"
    );
    consensusFindings.forEach((finding, index) => {
      const reviewers = (finding.sourceRunnerIds || []).join(", ") || finding.sourceRunnerId || "unknown";
      parts.push(
        `<tr><td>G${index + 1}</td><td>${esc(finding.title)}</td><td>${esc(finding.severity)}</td><td>${esc(reviewers)}</td><td>${esc(String(finding.reviewerCount || 0))}</td></tr>`
      );
    });
    parts.push("</tbody></table>");
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

  parts.push('<h2 class="advisory">Induced Principle Candidates (P#, advisory)</h2>');
  if (model.inducedCandidates.length === 0) {
    parts.push("<p>No candidate principles were induced.</p>");
  } else {
    parts.push(
      "<table><thead><tr><th>#</th><th>Priority</th><th>Statement</th><th>Id</th></tr></thead><tbody>"
    );
    model.inducedCandidates.forEach((candidate, index) => {
      parts.push(
        `<tr><td>P${index + 1}</td><td>${esc(candidate.priority)}</td><td>${esc(candidate.statement)}</td><td><code>${esc(candidate.id)}</code></td></tr>`
      );
    });
    parts.push("</tbody></table>");
  }

  parts.push("<h2>Decisions &amp; Verification</h2><ul>");
  parts.push(`<li>Gate decision: ${esc(model.gateStatus)}</li>`);
  parts.push(`<li>Findings: ${esc(String(model.findings.length))} total, ${esc(String(consensusFindings.length))} at consensus.</li>`);
  parts.push(
    `<li>Induced principle candidates: ${esc(String(model.inducedCandidates.length))} (advisory; human decides adoption).</li>`
  );
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
