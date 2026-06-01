import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderSummaryMarkdown } from "../../../src/core/synthesis.mjs";

test("clean summary output matches golden snapshot", async () => {
  const expected = await readFile("tests/kualityfore/golden/summary-clean.md", "utf8");
  const actual = renderSummaryMarkdown({ runId: "golden-run", findings: [] });

  assert.equal(actual, expected);
});
