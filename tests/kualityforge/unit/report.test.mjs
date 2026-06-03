import assert from "node:assert/strict";
import test from "node:test";
import {
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
  const md = renderReportMarkdown(sampleModel());
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
  const html = renderReportHtml(sampleModel());
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
  const md = renderReportMarkdown(model);
  assert.match(md, /No findings reached consensus \(>= 2 reviewers\)\./);
  assert.match(md, /No candidate principles were induced\./);
});
