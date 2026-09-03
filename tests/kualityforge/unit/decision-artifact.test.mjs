import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDecisionToFindings,
  computeFindingSetDigest,
  parseDecisionArtifact
} from "../../../src/core/decision-artifact.mjs";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";
import { asFullProject } from "../helpers/artifact-fixtures.mjs";

const FINDINGS = [
  { id: "QF-001", title: "Install script runs unverified payload", severity: "blocker" },
  { id: "QF-002", title: "Docs typo", severity: "info" }
];

test("computeFindingSetDigest is deterministic and order independent", () => {
  const forward = computeFindingSetDigest(FINDINGS);
  const reversed = computeFindingSetDigest([...FINDINGS].reverse());

  assert.match(forward, /^sha256:[0-9a-f]{64}$/);
  assert.equal(forward, reversed);
});

test("computeFindingSetDigest changes when an immutable gate-critical field changes", () => {
  const finding = {
    ...FINDINGS[0],
    type: "quality_principle_violation",
    priority: "must",
    principleId: "QP-001",
    sourceRunnerId: "codex:gpt-5",
    sourceRunnerIds: ["claude:sonnet"]
  };
  const base = computeFindingSetDigest([finding]);

  for (const [field, value] of [
    ["severity", "info"],
    ["title", "Something else entirely"],
    ["type", "code"],
    ["priority", "should"],
    ["principleId", "QP-002"]
  ]) {
    assert.notEqual(computeFindingSetDigest([{ ...finding, [field]: value }]), base, field);
  }
  assert.notEqual(
    computeFindingSetDigest([{ ...finding, sourceRunnerIds: ["claude:sonnet", "xiaok"] }]),
    base,
    "source runner set"
  );
});

test("computeFindingSetDigest normalizes source runners and ignores decision-stage fields", () => {
  const finding = {
    ...FINDINGS[0],
    type: "code",
    priority: null,
    principleId: null,
    sourceRunnerId: "codex:gpt-5",
    sourceRunnerIds: ["xiaok", "claude:sonnet", "codex:gpt-5"]
  };
  const normalized = {
    ...finding,
    sourceRunnerId: "xiaok",
    sourceRunnerIds: ["codex:gpt-5", "claude:sonnet", "xiaok", "xiaok"]
  };

  assert.equal(computeFindingSetDigest([finding]), computeFindingSetDigest([normalized]));
  assert.equal(
    computeFindingSetDigest([finding]),
    computeFindingSetDigest([
      { ...finding, status: "risk_accepted", decisionReason: "accepted for this run" }
    ])
  );
});

test("computeFindingSetDigest is not confused by separators inside field values", () => {
  const a = computeFindingSetDigest([{ id: "QF-1", title: "a", severity: "info" }]);
  const b = computeFindingSetDigest([{ id: "QF-1\u0000a", title: "", severity: "info" }]);

  assert.notEqual(a, b);
});

test("parseDecisionArtifact accepts a complete decision block", () => {
  const decision = parseDecisionArtifact(decisionMarkdown(), {
    findings: FINDINGS,
    owner: "kai"
  });

  assert.equal(decision.runId, "release-1");
  assert.equal(decision.decidedBy, "kai");
  assert.equal(decision.dispositions.length, 2);
});

test("parseDecisionArtifact rejects a disposition outside the vocabulary", () => {
  assert.throws(
    () =>
      parseDecisionArtifact(
        decisionMarkdown({
          findings: [{ id: "QF-001", disposition: "looks_fine", reason: "r" }]
        }),
        { findings: FINDINGS, owner: "kai" }
      ),
    /disposition/
  );
});

test("parseDecisionArtifact requires a reason for every terminal disposition", () => {
  for (const disposition of ["wont_fix", "deferred", "risk_accepted", "dismissed"]) {
    assert.throws(
      () =>
        parseDecisionArtifact(
          decisionMarkdown({ findings: [{ id: "QF-001", disposition }] }),
          { findings: FINDINGS, owner: "kai" }
        ),
      /reason/,
      disposition
    );
  }
});

test("parseDecisionArtifact does not require a reason for approved_for_fix", () => {
  const decision = parseDecisionArtifact(
    decisionMarkdown({ findings: [{ id: "QF-001", disposition: "approved_for_fix" }] }),
    { findings: FINDINGS, owner: "kai" }
  );

  assert.equal(decision.dispositions[0].disposition, "approved_for_fix");
});

test("parseDecisionArtifact rejects a decision whose decidedBy is not the caller owner", () => {
  assert.throws(
    () => parseDecisionArtifact(decisionMarkdown(), { findings: FINDINGS, owner: "someone-else" }),
    /decidedBy/
  );
});

test("parseDecisionArtifact rejects a reference to a finding the manifest does not have", () => {
  assert.throws(
    () =>
      parseDecisionArtifact(
        decisionMarkdown({
          findings: [{ id: "QF-404", disposition: "wont_fix", reason: "r" }]
        }),
        { findings: FINDINGS, owner: "kai" }
      ),
    /QF-404/
  );
});

test("parseDecisionArtifact rejects the same finding id twice", () => {
  assert.throws(
    () =>
      parseDecisionArtifact(
        decisionMarkdown({
          findings: [
            { id: "QF-001", disposition: "wont_fix", reason: "r" },
            { id: "QF-001", disposition: "approved_for_fix" }
          ]
        }),
        { findings: FINDINGS, owner: "kai" }
      ),
    /QF-001/
  );
});

test("parseDecisionArtifact rejects a wrong schemaVersion", () => {
  assert.throws(
    () =>
      parseDecisionArtifact(decisionMarkdown({ schemaVersion: "kualityforge.decision.v2" }), {
        findings: FINDINGS,
        owner: "kai"
      }),
    /schemaVersion/
  );
});

test("parseDecisionArtifact reports a missing block as unparsable rather than throwing", () => {
  assert.equal(parseDecisionArtifact("# Decision\n\nfree text\n", { findings: FINDINGS, owner: "kai" }), null);
  assert.equal(
    parseDecisionArtifact("```kualityforge-decision\nnot json\n```\n", {
      findings: FINDINGS,
      owner: "kai"
    }),
    null
  );
});

test("applyDecisionToFindings maps dispositions and marks silence as unchecked", () => {
  const decision = parseDecisionArtifact(
    decisionMarkdown({
      findings: [{ id: "QF-001", disposition: "risk_accepted", reason: "accepted in policy" }]
    }),
    { findings: FINDINGS, owner: "kai" }
  );

  const findings = applyDecisionToFindings(FINDINGS, decision);

  assert.equal(findings[0].status, "risk_accepted");
  assert.equal(findings[0].decisionReason, "accepted in policy");
  assert.equal(findings[1].status, "unchecked");
});

test("gate accepts a decision bound to this run and this finding set", () => {
  const result = gateWith({
    artifact: "decision.md",
    owner: "kai",
    status: "parsed",
    runId: "release-1",
    findingSetDigest: computeFindingSetDigest(FINDINGS),
    decidedAt: "2026-08-30T10:00:00Z"
  });

  assert.equal(result.status, "passed", result.reasons.join("; "));
});

test("gate blocks a decision artifact with no machine-readable block", () => {
  const result = gateWith({ artifact: "decision.md", owner: "kai", status: "unparsed" });

  assert.notEqual(result.status, "passed");
  assert.match(result.reasons.join("\n"), /decision/);
});

test("gate blocks a decision made against a different run", () => {
  const result = gateWith({
    artifact: "decision.md",
    owner: "kai",
    status: "parsed",
    runId: "release-0",
    findingSetDigest: computeFindingSetDigest(FINDINGS),
    decidedAt: "2026-08-30T10:00:00Z"
  });

  assert.notEqual(result.status, "passed");
  assert.match(result.reasons.join("\n"), /runId/);
});

test("gate blocks a decision whose finding set changed after it was made", () => {
  const result = gateWith({
    artifact: "decision.md",
    owner: "kai",
    status: "parsed",
    runId: "release-1",
    findingSetDigest: computeFindingSetDigest([FINDINGS[0]]),
    decidedAt: "2026-08-30T10:00:00Z"
  });

  assert.notEqual(result.status, "passed");
  assert.match(result.reasons.join("\n"), /findingSetDigest/);
});

// Declared full-project once for the whole file: the decision artifact is orthogonal to
// the frozen changeset, and this mode's own context requirements are declared below.
function gateWith(humanDecision) {
  const findings = FINDINGS.map((finding) => ({
    ...finding,
    status: "risk_accepted",
    sourceRunnerId: "codex:gpt-5"
  }));
  const boundDecision =
    humanDecision?.findingSetDigest === computeFindingSetDigest(FINDINGS)
      ? { ...humanDecision, findingSetDigest: computeFindingSetDigest(findings) }
      : humanDecision;
  return reduceQualityGate(
    asFullProject({
      runId: "release-1",
      status: "open",
      reviewers: [
        { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex.md" },
        { runnerId: "claude:sonnet", status: "completed", artifact: "reviews/claude.md" }
      ],
      findings,
      requiredChecks: [{ name: "npm test", status: "passed" }],
      humanDecision: boundDecision,
      verification: {
        runnerId: "claude:verifier",
        status: "verified",
        artifact: "verify.md",
        coveredFindingIds: ["QF-001", "QF-002"],
        uncoveredOpenFindingIds: []
      }
    }),
    { minReviewers: 2, requireHumanDecision: true, requireRequiredChecks: true }
  );
}

function decisionMarkdown(overrides = {}) {
  const body = {
    schemaVersion: "kualityforge.decision.v1",
    runId: "release-1",
    findingSetDigest: computeFindingSetDigest(FINDINGS),
    decidedBy: "kai",
    decidedAt: "2026-08-30T10:00:00Z",
    findings: [
      { id: "QF-001", disposition: "risk_accepted", reason: "accepted in policy" },
      { id: "QF-002", disposition: "wont_fix", reason: "cosmetic" }
    ],
    ...overrides
  };
  return `# Human Decision\n\n\`\`\`kualityforge-decision\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}
