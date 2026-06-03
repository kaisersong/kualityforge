import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderSummaryMarkdown } from "../../../src/core/synthesis.mjs";

test("clean summary output matches golden snapshot", async () => {
  const expected = await readFile("tests/kualityforge/golden/summary-clean.md", "utf8");
  const actual = renderSummaryMarkdown({ runId: "golden-run", findings: [] });

  assert.equal(actual, expected);
});

test("summary with reviewer scores and induced principles matches golden snapshot", async () => {
  const expected = await readFile("tests/kualityforge/golden/summary-with-scores.md", "utf8");
  const actual = renderSummaryMarkdown({
    runId: "golden-scored-run",
    findings: [
      {
        id: "QF-001",
        title: "Race condition in cache",
        severity: "blocker",
        status: "open",
        duplicateKey: "race-cache",
        sourceRunnerIds: ["claude:r2", "codex:r1"],
        reviewerCount: 2
      }
    ],
    reviewerScores: {
      schemaVersion: 1,
      scores: [
        {
          runnerId: "codex:r1",
          role: "required",
          overall: 92.5,
          stats: { findingCount: 1, corroboratedCount: 1 }
        },
        {
          runnerId: "claude:r2",
          role: "advisory",
          overall: 80,
          stats: { findingCount: 1, corroboratedCount: 1 }
        }
      ],
      ranking: ["codex:r1", "claude:r2"]
    },
    inducedPrinciples: {
      candidates: [
        {
          id: "induced-race-cache",
          priority: "must",
          statement: "Guard shared cache access against concurrent writes."
        }
      ]
    }
  });

  assert.equal(actual, expected);
});

test("clean golden is unaffected by explicit null advisory inputs", async () => {
  const expected = await readFile("tests/kualityforge/golden/summary-clean.md", "utf8");
  const actual = renderSummaryMarkdown({
    runId: "golden-run",
    findings: [],
    reviewerScores: null,
    inducedPrinciples: null
  });

  assert.equal(actual, expected);
});

test("quorum summary with absent advisory matches golden snapshot", async () => {
  const expected = await readFile(
    "tests/kualityforge/golden/summary-quorum-advisory-absent.md",
    "utf8"
  );
  const actual = renderSummaryMarkdown({
    runId: "golden-quorum-run",
    findings: [],
    reviewPolicy: {
      mode: "quorum",
      quorumMin: 2,
      requiredReviewers: ["codex:gpt-5"],
      quorumMembers: ["codex:gpt-5", "claude:sonnet", "gemini:pro"],
      advisoryReviewers: ["claude:sonnet", "gemini:pro"]
    },
    reviewOutcomes: [
      { runnerId: "claude:sonnet", role: "advisory", quorumMember: true, status: "succeeded" },
      { runnerId: "codex:gpt-5", role: "required", quorumMember: true, status: "succeeded" },
      {
        runnerId: "gemini:pro",
        role: "advisory",
        quorumMember: true,
        status: "skipped",
        absenceReason: "node completed but artifact is missing"
      }
    ]
  });

  assert.equal(actual, expected);
});
