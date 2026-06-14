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
