import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveManifestVerification,
  parseVerificationArtifact
} from "../../../src/core/verification-artifact.mjs";

function makeMarkdown(block) {
  return `# Verification\n\n\`\`\`kualityforge-verification\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
}

test("parses a fully confirmed verification block", () => {
  const md = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: [
      { findingId: "QF-001", status: "confirmed", notes: "Valid finding" },
      { findingId: "QF-002", status: "confirmed", notes: "Also valid" }
    ]
  });

  const result = parseVerificationArtifact(md);

  assert.equal(result.runnerId, "claude:verifier");
  assert.equal(result.overallStatus, "verified");
  assert.equal(result.verdictCount, 2);
  assert.equal(result.confirmedCount, 2);
  assert.equal(result.dismissedCount, 0);
  assert.equal(result.cannotVerifyCount, 0);
});

test("reports a dismissal as a dispute the verifier cannot settle alone", () => {
  const md = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: [
      { findingId: "QF-001", status: "confirmed" },
      { findingId: "QF-002", status: "dismissed", notes: "False positive" }
    ]
  });

  const result = parseVerificationArtifact(md);

  assert.equal(result.overallStatus, "disputed");
  assert.equal(result.dismissedCount, 1);
  assert.equal(result.confirmedCount, 1);
});

test("sets partially_verified when any verdict is cannot_verify", () => {
  const md = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: [
      { findingId: "QF-001", status: "confirmed" },
      { findingId: "QF-002", status: "cannot_verify", notes: "No access" }
    ]
  });

  const result = parseVerificationArtifact(md);

  assert.equal(result.overallStatus, "partially_verified");
  assert.equal(result.cannotVerifyCount, 1);
});

test("an empty verdicts array is not itself a verification failure", () => {
  const md = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: []
  });

  const result = parseVerificationArtifact(md);

  assert.equal(result.overallStatus, "verified");
  assert.equal(result.verdictCount, 0);
});

test("throws when kualityforge-verification block is missing", () => {
  assert.throws(
    () => parseVerificationArtifact("# No block here\n\nJust text."),
    /kualityforge-verification block/
  );
});

test("throws when multiple kualityforge-verification blocks are present", () => {
  const first = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: [{ findingId: "QF-001", status: "confirmed" }]
  });
  const second = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: [{ findingId: "QF-001", status: "dismissed" }]
  });

  assert.throws(() => parseVerificationArtifact(`${first}\n${second}`), /exactly one/);
});

test("throws when runnerId is missing", () => {
  const md = makeMarkdown({ verdicts: [{ findingId: "QF-001", status: "confirmed" }] });
  assert.throws(() => parseVerificationArtifact(md), /runnerId/);
});

test("throws when verdicts is not an array", () => {
  const md = makeMarkdown({ runnerId: "claude:verifier", verdicts: null });
  assert.throws(() => parseVerificationArtifact(md), /verdicts array/);
});

test("throws when a verdict has invalid status", () => {
  const md = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: [{ findingId: "QF-001", status: "unknown_status" }]
  });
  assert.throws(() => parseVerificationArtifact(md), /confirmed, dismissed, cannot_verify/);
});

test("throws when JSON in block is invalid", () => {
  const bad = "# V\n\n```kualityforge-verification\nnot json\n```\n";
  assert.throws(() => parseVerificationArtifact(bad), /not valid JSON/);
});

test("deriveManifestVerification projects verdicts against current blocking findings", () => {
  const parsed = parseVerificationArtifact(
    makeMarkdown({
      runnerId: "claude:verifier",
      verdicts: [
        { findingId: "QF-001", status: "confirmed" },
        { findingId: "QF-002", status: "dismissed" }
      ]
    })
  );
  const findings = [
    { id: "QF-001", status: "approved_for_fix" },
    { id: "QF-002", status: "risk_accepted" },
    { id: "QF-003", status: "open" },
    { id: "QF-004", status: "wont_fix" }
  ];

  assert.deepEqual(deriveManifestVerification(parsed, findings, { artifact: "verify.md" }), {
    runnerId: "claude:verifier",
    status: "disputed",
    artifact: "verify.md",
    verdicts: parsed.verdicts,
    verdictCount: 2,
    confirmedCount: 1,
    dismissedCount: 1,
    cannotVerifyCount: 0,
    coveredFindingIds: ["QF-001", "QF-002"],
    uncoveredOpenFindingIds: ["QF-003"],
    disputedFindings: ["QF-002"]
  });
});

test("deriveManifestVerification requires each verdict id to match exactly one current finding", () => {
  const parsed = parseVerificationArtifact(
    makeMarkdown({
      runnerId: "claude:verifier",
      verdicts: [{ findingId: "QF-001", status: "confirmed" }]
    })
  );

  assert.throws(() => deriveManifestVerification(parsed, [], { artifact: "verify.md" }), /matches 0/);
  assert.throws(
    () =>
      deriveManifestVerification(
        parsed,
        [
          { id: "QF-001", status: "open" },
          { id: "QF-001", status: "approved_for_fix" }
        ],
        { artifact: "verify.md" }
      ),
    /matches 2/
  );
});
