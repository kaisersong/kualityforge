import assert from "node:assert/strict";
import test from "node:test";
import {
  FINDING_PRIORITIES,
  SEVERITY_LEVELS,
  normalizeFindingKey,
  severityRank
} from "../../../src/core/finding-vocabulary.mjs";
import { parseReviewArtifact } from "../../../src/core/review-artifact.mjs";
import { reduceQualityGate, validateManifestShape } from "../../../src/core/gate-reducer.mjs";
import { synthesizeFindings } from "../../../src/core/synthesis.mjs";
import { asFullProject } from "../helpers/artifact-fixtures.mjs";

// P0-17 — severity vocabulary is closed, so severityRank can never silently
// rank an unknown value below info and discard the more severe finding.

test("severity vocabulary is the single source of truth and strictly ordered", () => {
  assert.deepEqual([...SEVERITY_LEVELS], ["blocker", "warning", "info"]);
  assert.ok(severityRank("blocker") > severityRank("warning"));
  assert.ok(severityRank("warning") > severityRank("info"));
  assert.ok(severityRank("info") > 0);
});

test("parseReviewArtifact rejects a severity outside the vocabulary", () => {
  assert.throws(
    () => parseReviewArtifact(reviewMarkdown("codex:gpt-5", [{ id: "QF-1", title: "t", severity: "critical" }])),
    /severity/
  );
});

test("parseReviewArtifact rejects a priority outside the vocabulary", () => {
  assert.deepEqual([...FINDING_PRIORITIES], ["must", "should", "prefer"]);
  assert.throws(
    () => parseReviewArtifact(reviewMarkdown("codex:gpt-5", [{ id: "QF-1", title: "t", priority: "Must" }])),
    /priority/
  );
});

test("validateManifestShape rejects out-of-vocabulary severity and priority", () => {
  const severityErrors = validateManifestShape(
    manifest({ findings: [{ id: "QF-1", status: "open", severity: "critical" }] })
  );
  assert.ok(severityErrors.some((error) => /severity/.test(error)), severityErrors.join("; "));

  const priorityErrors = validateManifestShape(
    manifest({ findings: [{ id: "QF-1", status: "open", severity: "info", priority: "Must" }] })
  );
  assert.ok(priorityErrors.some((error) => /priority/.test(error)), priorityErrors.join("; "));
});

// P0-15 / QS5-B3 — source attribution is validated in the shape layer, so it
// also applies to plain flow, where no review policy is enabled.

test("validateManifestShape rejects a sourceRunnerId that no declared reviewer owns", () => {
  const errors = validateManifestShape(
    manifest({
      reviewers: [{ runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex.md" }],
      findings: [{ id: "QF-1", status: "open", severity: "info", sourceRunnerId: "ghost:model" }]
    })
  );
  assert.ok(errors.some((error) => /ghost:model/.test(error)), errors.join("; "));
});

test("validateManifestShape rejects a sourceRunnerIds element that no declared reviewer owns", () => {
  const errors = validateManifestShape(
    manifest({
      reviewers: [{ runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex.md" }],
      findings: [
        {
          id: "QF-1",
          status: "open",
          severity: "info",
          sourceRunnerIds: ["codex:gpt-5", "ghost:model"]
        }
      ]
    })
  );
  assert.ok(errors.some((error) => /ghost:model/.test(error)), errors.join("; "));
});

// The singular field had no type branch at all, so an empty or non-string value
// left findingSources returning nothing and the undeclared-source loop below it
// running zero times.
test("validateManifestShape rejects a sourceRunnerId that is present but not a non-empty string", () => {
  for (const sourceRunnerId of ["", 42, null, {}]) {
    const errors = validateManifestShape(
      manifest({ findings: [{ id: "QF-1", status: "open", severity: "info", sourceRunnerId }] })
    );
    assert.ok(
      errors.some((error) => /sourceRunnerId/.test(error)),
      `${JSON.stringify(sourceRunnerId)}: ${errors.join("; ")}`
    );
  }
});

// The type check alone cannot see this case: an absent field triggers no type
// branch, and a finding nobody claims is exactly what the source-attribution
// checks exist to refuse.
test("validateManifestShape rejects a finding that names no source runner at all", () => {
  const errors = validateManifestShape(
    manifest({ findings: [{ id: "QF-1", status: "open", severity: "info" }] })
  );
  assert.ok(errors.some((error) => /no source runner/.test(error)), errors.join("; "));
});

test("validateManifestShape rejects a finding whose sourceRunnerIds array is empty", () => {
  const errors = validateManifestShape(
    manifest({ findings: [{ id: "QF-1", status: "open", severity: "info", sourceRunnerIds: [] }] })
  );
  assert.ok(errors.some((error) => /no source runner/.test(error)), errors.join("; "));
});

test("plain flow gate rejects a finding with no source attribution as invalid_artifact", () => {
  const result = reduceQualityGate(
    manifest({
      reviewers: [
        { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex.md" },
        { runnerId: "claude:sonnet", status: "completed", artifact: "reviews/claude.md" }
      ],
      findings: [{ id: "QF-1", status: "open", severity: "info" }]
    }),
    { minReviewers: 2, requireHumanDecision: false, requireRequiredChecks: false }
  );

  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
});

test("plain flow gate rejects forged source attribution as invalid_artifact", () => {
  const result = reduceQualityGate(
    manifest({
      reviewers: [
        { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex.md" },
        { runnerId: "claude:sonnet", status: "completed", artifact: "reviews/claude.md" }
      ],
      findings: [{ id: "QF-1", status: "open", severity: "info", sourceRunnerId: "ghost:model" }]
    }),
    // No review policy: this is the plain flow that used to skip source checks.
    { minReviewers: 2, requireHumanDecision: false, requireRequiredChecks: false }
  );

  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
});

// P0-19 — the merge key is a Unicode-aware normalization of the title, not a
// reviewer-supplied duplicateKey.

test("normalizeFindingKey keeps CJK titles distinguishable instead of collapsing to an empty key", () => {
  const first = normalizeFindingKey("输入未校验");
  const second = normalizeFindingKey("缺少测试覆盖");

  assert.notEqual(first, "");
  assert.notEqual(second, "");
  assert.notEqual(first, second);
  assert.equal(normalizeFindingKey("输入未校验"), first);
});

test("synthesizeFindings merges CJK titles that are actually the same title", () => {
  const findings = synthesizeFindings([
    finding({ id: "codex:gpt-5:QF-001", title: "输入未校验", sourceRunnerId: "codex:gpt-5" }),
    finding({ id: "claude:sonnet:QF-001", title: "输入未校验", sourceRunnerId: "claude:sonnet" })
  ]);

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].sourceRunnerIds, ["claude:sonnet", "codex:gpt-5"]);
});

test("synthesizeFindings ignores a reviewer-supplied duplicateKey as the merge key", () => {
  const findings = synthesizeFindings([
    finding({
      id: "QF-1",
      title: "输入未校验",
      severity: "blocker",
      sourceRunnerId: "codex:gpt-5",
      duplicateKey: "shared"
    }),
    finding({
      id: "QF-2",
      title: "缺少测试覆盖",
      severity: "info",
      sourceRunnerId: "codex:gpt-5",
      duplicateKey: "shared"
    })
  ]);

  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((item) => item.severity),
    ["blocker", "info"]
  );
});

// P0-16 — findings that disagree on the fields the gate reads are never merged,
// so a merge can no longer destroy gate-relevant evidence.

test("synthesizeFindings does not merge findings that disagree on gate-relevant classification", () => {
  const findings = synthesizeFindings([
    finding({
      id: "codex:gpt-5:QF-001",
      title: "输入未校验",
      type: "quality_principle_violation",
      priority: "must",
      status: "open",
      sourceRunnerId: "codex:gpt-5"
    }),
    finding({
      id: "claude:sonnet:QF-001",
      title: "输入未校验",
      type: "code",
      priority: "should",
      status: "risk_accepted",
      sourceRunnerId: "claude:sonnet"
    })
  ]);

  assert.equal(findings.length, 2);
  assert.ok(findings.some((item) => item.priority === "must" && item.status === "open"));
  assert.ok(findings.some((item) => item.priority === "should" && item.status === "risk_accepted"));
});

// QS5-B2 — synthesizeFindings is deterministic: the same set of findings in a
// different order must produce an identical result.

test("synthesizeFindings output does not depend on input order", () => {
  const a = finding({
    id: "codex:gpt-5:QF-001",
    title: "输入未校验",
    severity: "blocker",
    sourceRunnerId: "codex:gpt-5",
    description: "codex 描述",
    suggestion: "codex 建议"
  });
  const b = finding({
    id: "claude:sonnet:QF-007",
    title: "输入未校验",
    severity: "info",
    sourceRunnerId: "claude:sonnet",
    description: "claude 描述",
    suggestion: "claude 建议"
  });

  assert.deepEqual(synthesizeFindings([a, b]), synthesizeFindings([b, a]));
});

test("synthesizeFindings keeps the most severe severity regardless of input order", () => {
  const severe = finding({
    id: "codex:gpt-5:QF-001",
    title: "输入未校验",
    severity: "blocker",
    sourceRunnerId: "codex:gpt-5"
  });
  const mild = finding({
    id: "claude:sonnet:QF-001",
    title: "输入未校验",
    severity: "info",
    sourceRunnerId: "claude:sonnet"
  });

  assert.equal(synthesizeFindings([severe, mild])[0].severity, "blocker");
  assert.equal(synthesizeFindings([mild, severe])[0].severity, "blocker");
});

// P0-18 — a must-priority finding blocks the gate while it is unresolved, and
// the blocking condition keys on priority so a misspelled type cannot bypass it.

test("gate blocks an unresolved must-priority finding even when its type is misspelled", () => {
  const result = gateFor([
    {
      id: "QF-1",
      status: "deferred",
      severity: "blocker",
      type: "quality_principle_violations",
      priority: "must",
      sourceRunnerId: "codex:gpt-5"
    }
  ]);

  assert.equal(result.status, "incomplete");
  assert.ok(
    result.reasons.some((reason) => /must/.test(reason)),
    result.reasons.join("; ")
  );
});

test("gate keeps blocking a must-priority finding that a human merely waived", () => {
  for (const status of ["risk_accepted", "wont_fix", "deferred"]) {
    const result = gateFor([
      {
        id: "QF-1",
        status,
        severity: "blocker",
        type: "quality_principle_violation",
        priority: "must",
        sourceRunnerId: "codex:gpt-5"
      }
    ]);
    assert.notEqual(result.status, "passed", `${status} must not clear a must finding`);
    assert.match(result.reasons.join("\n"), /must/);
  }
});

test("gate clears a must-priority finding the verifier dismissed", () => {
  const result = gateFor([
    {
      id: "QF-1",
      status: "dismissed",
      severity: "blocker",
      type: "quality_principle_violation",
      priority: "must",
      sourceRunnerId: "codex:gpt-5"
    }
  ]);

  assert.equal(result.status, "passed", result.reasons.join("; "));
});

function gateFor(findings) {
  return reduceQualityGate(
    manifest({
      reviewers: [
        { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex.md" },
        { runnerId: "claude:sonnet", status: "completed", artifact: "reviews/claude.md" }
      ],
      findings
    }),
    { minReviewers: 2, requireHumanDecision: false, requireRequiredChecks: false }
  );
}

// Declared full-project once for the whole file: finding identity is orthogonal to the
// frozen changeset, and this mode's own context requirements are declared below.
function manifest(overrides = {}) {
  return asFullProject({
    runId: "run-1",
    status: "open",
    reviewers: [{ runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex.md" }],
    findings: [],
    requiredChecks: [],
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    ...overrides
  });
}

function finding(overrides = {}) {
  return {
    id: "QF-1",
    type: "code",
    priority: null,
    title: "Finding",
    severity: "warning",
    status: "open",
    description: "",
    suggestion: "",
    ...overrides
  };
}

function reviewMarkdown(runnerId, findings) {
  return `# Review\n\n\`\`\`kualityforge-review\n${JSON.stringify({
    runnerId,
    status: "completed",
    findings
  })}\n\`\`\`\n`;
}
