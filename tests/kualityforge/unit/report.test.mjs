import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LANG,
  DEFAULT_REPORT_OUT_DIR,
  buildReportModel,
  renderReportHtml,
  renderReportMarkdown,
  resolveReportOutDir
} from "../../../src/core/report.mjs";

const sampleManifest = {
  runId: "run-1",
  profile: "default",
  status: "passed",
  findings: [
    { id: "qf-a", title: "Alpha", severity: "warning", status: "open", reviewerCount: 2, sourceRunnerIds: ["x", "y"] },
    { id: "qf-b", title: "Beta", severity: "info", status: "open", reviewerCount: 1, sourceRunnerIds: ["x"] }
  ],
  reviewers: [],
  reviewOutcomes: []
};

function sampleModel() {
  return buildReportModel({
    manifest: sampleManifest,
    scores: {
      scores: [
        { runnerId: "x", overall: 80, role: "reviewer", stats: { findingCount: 2, corroboratedCount: 1 } }
      ],
      ranking: ["x"]
    },
    inducedPrinciples: {
      candidates: [{ id: "induced-alpha", priority: "should", statement: "Avoid Alpha." }]
    },
    gate: { status: "passed", reasons: [], warnings: [] }
  });
}

test("resolveReportOutDir prefers the explicit value", () => {
  const result = resolveReportOutDir("  /custom/out  ", {
    KUALITYFORGE_REPORT_OUT_DIR: "/env/out"
  });
  assert.equal(result, "/custom/out");
});

test("resolveReportOutDir falls back to the environment variable", () => {
  const result = resolveReportOutDir(undefined, {
    KUALITYFORGE_REPORT_OUT_DIR: "/env/out"
  });
  assert.equal(result, "/env/out");
});

test("resolveReportOutDir falls back to the built-in default", () => {
  assert.equal(resolveReportOutDir(undefined, {}), DEFAULT_REPORT_OUT_DIR);
  assert.equal(resolveReportOutDir("   ", {}), DEFAULT_REPORT_OUT_DIR);
  assert.equal(DEFAULT_REPORT_OUT_DIR, "kualityforge-reports");
});

test("resolveReportOutDir honors an explicit fallback over the built-in default", () => {
  assert.equal(resolveReportOutDir(undefined, {}, "/artifact/reports"), "/artifact/reports");
  assert.equal(
    resolveReportOutDir(undefined, { KUALITYFORGE_REPORT_OUT_DIR: "/env/out" }, "/artifact/reports"),
    "/env/out"
  );
});

test("renderReportMarkdown numbers findings, consensus, and principles", () => {
  const md = renderReportMarkdown(sampleModel(), { lang: "en" });
  assert.match(md, /## Findings \(F#\)/);
  assert.match(md, /\| F1 \| Alpha \| warning \| open \| x, y \| 2 \|/);
  assert.match(md, /\| F2 \| Beta \| info \| open \| x \| 1 \|/);
  assert.match(md, /## Consensus Findings \(G#\)/);
  assert.match(md, /\| G1 \| Alpha \| warning \| x, y \| 2 \|/);
  assert.doesNotMatch(md, /\| G2 \|/);
  assert.match(md, /## Induced Principle Candidates \(P#, advisory\)/);
  assert.match(md, /\| P1 \| should \| Avoid Alpha\. \| induced-alpha \|/);
  assert.match(md, /## Decisions & Verification/);
  assert.match(md, /\| Findings \| 2 total, 1 at consensus \|/);
});

test("renderReportHtml numbers findings, consensus, and principles", () => {
  const html = renderReportHtml(sampleModel(), { lang: "en" });
  assert.match(html, /<h2>Findings \(F#\)<\/h2>/);
  assert.match(html, /<td>F1<\/td><td>Alpha<\/td>/);
  assert.match(html, /<h2>Consensus Findings \(G#\)<\/h2>/);
  assert.match(html, /<td>G1<\/td><td>Alpha<\/td>/);
  assert.match(html, /Induced Principle Candidates \(P#, advisory\)/);
  assert.match(html, /<td>P1<\/td>/);
  assert.match(html, /Decisions &amp; Verification/);
});

test("renderReportMarkdown reports absence of consensus and principles", () => {
  const model = buildReportModel({
    manifest: { runId: "r", findings: [{ id: "qf-x", title: "Solo", severity: "info", status: "open", reviewerCount: 1 }] },
    gate: { status: "passed" }
  });
  const md = renderReportMarkdown(model, { lang: "en" });
  assert.match(md, /No findings reached consensus \(>= 2 reviewers\)\./);
  assert.match(md, /No candidate principles were induced\./);
});

test("DEFAULT_LANG is zh and default render uses Chinese labels", () => {
  assert.equal(DEFAULT_LANG, "zh");
  const model = buildReportModel({ manifest: { runId: "t" }, gate: { status: "open" } });
  const md = renderReportMarkdown(model);
  assert.match(md, /# KualityForge 评审报告: t/);
  assert.match(md, /## 变更集/);
  assert.match(md, /未冻结变更集/);
  const html = renderReportHtml(model);
  assert.match(html, /lang="zh"/);
  assert.match(html, /评审报告/);
});

test("full-project mode renders project overview, reviewer details, risk matrix, action plan, and grade", () => {
  const model = buildReportModel({
    manifest: { runId: "fp-1", findings: [] },
    gate: { status: "blocked" },
    reviewType: "full-project",
    projectOverview: { name: "TestProj", version: "1.0", techStack: "Node", codeScale: "10k LOC", reviewerCount: 2 },
    reviewerDetails: [{
      runnerId: "alice", role: "security",
      subDimensions: [{ name: "auth", score: 7, finding: "weak tokens" }],
      topIssues: [{ severity: "blocker", issue: "TLS bypass", location: "main.ts" }],
      improvements: [{ priority: "P0", suggestion: "enable TLS", benefit: "fix CVE" }]
    }],
    riskMatrix: [{ name: "Electron CVE", probability: 5, impact: 5, findings: ["F1"] }],
    actionPlan: [{ priority: "P0", action: "upgrade Electron", effort: "30d", findings: ["F1", "F2"] }],
    overallGrade: { dimensions: [{ name: "security", score: 3, reviewer: "alice" }], grade: "C+", reason: "3 blockers" }
  });

  const md = renderReportMarkdown(model, { lang: "en" });
  assert.match(md, /## Project Overview/);
  assert.match(md, /TestProj/);
  assert.match(md, /## Reviewer Details \(R#\)/);
  assert.match(md, /### R1: alice/);
  assert.match(md, /## Risk Matrix/);
  assert.match(md, /Electron CVE/);
  assert.match(md, /\*\*25\*\*/);
  assert.match(md, /## Action Plan/);
  assert.match(md, /upgrade Electron/);
  assert.match(md, /## Overall Grade/);
  assert.match(md, /C\+/);

  const html = renderReportHtml(model, { lang: "en" });
  assert.match(html, /<h2>Project Overview<\/h2>/);
  assert.match(html, /<details><summary>R1: alice<\/summary>/);
  assert.match(html, /<h2>Risk Matrix<\/h2>/);
  assert.match(html, /<h2>Action Plan<\/h2>/);
  assert.match(html, /<h2>Overall Grade<\/h2>/);
});

test("changeset mode does not render full-project sections", () => {
  const model = buildReportModel({
    manifest: { runId: "cs-1", findings: [] },
    gate: { status: "passed" },
    projectOverview: { name: "Hidden" },
    riskMatrix: [{ name: "Hidden", probability: 1, impact: 1 }]
  });
  const md = renderReportMarkdown(model, { lang: "en" });
  assert.doesNotMatch(md, /Project Overview/);
  assert.doesNotMatch(md, /Risk Matrix/);
});

test("renderReportMarkdown uses plain markdown sections for finding details", () => {
  const model = buildReportModel({
    manifest: {
      runId: "desc-1",
      findings: [
        {
          id: "qf-desc",
          title: "Missing validation",
          severity: "blocker",
          status: "open",
          reviewerCount: 1,
          sourceRunnerIds: ["x"],
          description: "Input not validated",
          suggestion: "Add validation"
        }
      ]
    },
    gate: { status: "passed" }
  });
  const md = renderReportMarkdown(model, { lang: "en" });
  assert.doesNotMatch(md, /<details>/);
  assert.doesNotMatch(md, /<summary>/);
  assert.match(md, /### F1: Description & Suggestion/);
  assert.match(md, /Input not validated/);
  assert.match(md, /Add validation/);
});

test("renderReportHtml includes <details> with description and suggestion for findings", () => {
  const model = buildReportModel({
    manifest: {
      runId: "desc-html",
      findings: [
        {
          id: "qf-html",
          title: "Missing validation",
          severity: "blocker",
          status: "open",
          reviewerCount: 1,
          sourceRunnerIds: ["x"],
          description: "Input not validated",
          suggestion: "Add validation"
        }
      ]
    },
    gate: { status: "passed" }
  });
  const html = renderReportHtml(model, { lang: "en" });
  assert.match(html, /<details>/);
  assert.match(html, /Input not validated/);
  assert.match(html, /Add validation/);
});

test("renderReportMarkdown omits finding detail section when description and suggestion are empty", () => {
  const model = buildReportModel({
    manifest: {
      runId: "no-desc",
      findings: [
        {
          id: "qf-nodesc",
          title: "Short finding",
          severity: "info",
          status: "open",
          reviewerCount: 1,
          sourceRunnerIds: ["x"]
        }
      ]
    },
    gate: { status: "passed" }
  });
  const md = renderReportMarkdown(model, { lang: "en" });
  assert.doesNotMatch(md, /<details>/);
  assert.doesNotMatch(md, /### F1: Description & Suggestion/);
});
