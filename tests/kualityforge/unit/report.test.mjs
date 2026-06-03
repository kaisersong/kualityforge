import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_REPORT_OUT_DIR, resolveReportOutDir } from "../../../src/core/report.mjs";

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
});
