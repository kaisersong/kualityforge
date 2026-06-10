import assert from "node:assert/strict";
import test from "node:test";
import { parseVerificationArtifact } from "../../../src/core/verification-artifact.mjs";

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

test("parses a block with dismissals and sets verified_with_dismissals", () => {
  const md = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: [
      { findingId: "QF-001", status: "confirmed" },
      { findingId: "QF-002", status: "dismissed", notes: "False positive" }
    ]
  });

  const result = parseVerificationArtifact(md);

  assert.equal(result.overallStatus, "verified_with_dismissals");
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

test("sets cannot_verify when verdicts array is empty", () => {
  const md = makeMarkdown({
    runnerId: "claude:verifier",
    verdicts: []
  });

  const result = parseVerificationArtifact(md);

  assert.equal(result.overallStatus, "cannot_verify");
  assert.equal(result.verdictCount, 0);
});

test("throws when kualityforge-verification block is missing", () => {
  assert.throws(
    () => parseVerificationArtifact("# No block here\n\nJust text."),
    /kualityforge-verification block/
  );
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
  assert.throws(() => parseVerificationArtifact(md), /confirmed, dismissed, or cannot_verify/);
});

test("throws when JSON in block is invalid", () => {
  const bad = "# V\n\n```kualityforge-verification\nnot json\n```\n";
  assert.throws(() => parseVerificationArtifact(bad), /not valid JSON/);
});
