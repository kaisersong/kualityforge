// Builds a human report (Markdown default, HTML on request) aggregating the
// gate result, frozen changeset, findings, reviewer scores, and induced
// principle candidates. Pure rendering — no IO. Std-lib only.

export const DEFAULT_REPORT_OUT_DIR = "kualityforge-reports";

export { DEFAULT_LANG } from "./report-labels.mjs";
export { buildReportModel } from "./report-model.mjs";
export { renderReportMarkdown } from "./report-markdown.mjs";
export { renderReportHtml } from "./report-html.mjs";

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
