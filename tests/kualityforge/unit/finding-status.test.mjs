import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FINDING_STATUSES,
  isBlockingStatus,
  isReviewerWritableStatus
} from "../../../src/core/finding-vocabulary.mjs";
import { parseReviewArtifact } from "../../../src/core/review-artifact.mjs";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";
import { parseVerificationArtifact } from "../../../src/core/verification-artifact.mjs";
import { asFullProject } from "../helpers/artifact-fixtures.mjs";

test("the manifest schema and the reducer share one finding status vocabulary", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../../schemas/manifest.schema.json", import.meta.url), "utf8")
  );

  assert.deepEqual(
    schema.properties.findings.items.properties.status.enum,
    [...FINDING_STATUSES]
  );
});

test("only the four terminal or verified statuses stop blocking the gate", () => {
  const nonBlocking = FINDING_STATUSES.filter((status) => !isBlockingStatus(status));

  assert.deepEqual(nonBlocking.sort(), ["dismissed", "risk_accepted", "verified", "wont_fix"]);
});

test("an unknown status blocks, so the vocabulary fails closed", () => {
  assert.ok(isBlockingStatus("some_future_status"));
  assert.ok(!isReviewerWritableStatus("risk_accepted"));
});

test("a reviewer cannot write a disposition status in its review block", () => {
  for (const status of ["risk_accepted", "wont_fix", "dismissed", "verified", "fixed"]) {
    assert.throws(() => parseReviewArtifact(reviewMarkdown(status)), /not writable by a reviewer/, status);
  }
});

test("a reviewer may write open or omit the status entirely", () => {
  assert.equal(parseReviewArtifact(reviewMarkdown("open")).findings[0].status, "open");
  assert.equal(parseReviewArtifact(reviewMarkdown(null)).findings[0].status, "open");
});

test("gate rejects a finding status outside the closed vocabulary", () => {
  const result = gateFor([finding({ status: "pending" })]);

  assert.equal(result.status, "invalid_artifact");
  assert.equal(result.exitCode, 1);
  assert.match(result.reasons.join("\n"), /status/);
});

test("gate blocks every status that is not an explicit release outcome", () => {
  for (const status of ["open", "unchecked", "approved_for_fix", "deferred", "fixed", "verification_failed"]) {
    const result = gateFor([finding({ status })]);
    assert.notEqual(result.status, "passed", status);
  }
});

test("gate lets terminal human dispositions through but records them as warnings", () => {
  for (const status of ["wont_fix", "risk_accepted", "dismissed"]) {
    const result = gateFor([finding({ status })]);
    assert.equal(result.status, "passed", `${status}: ${result.reasons.join("; ")}`);
    assert.match(result.warnings.join("\n"), new RegExp(status), status);
  }
});

test("verification parser rejects two verdicts for the same finding", () => {
  assert.throws(
    () =>
      parseVerificationArtifact(
        verifyMarkdown([
          { findingId: "QF-1", status: "confirmed" },
          { findingId: "QF-1", status: "dismissed" }
        ])
      ),
    /QF-1/
  );
});

test("verification overallStatus is derived from verdicts alone", () => {
  assert.equal(parseVerificationArtifact(verifyMarkdown([])).overallStatus, "verified");
  assert.equal(
    parseVerificationArtifact(verifyMarkdown([{ findingId: "QF-1", status: "confirmed" }]))
      .overallStatus,
    "verified"
  );
  assert.equal(
    parseVerificationArtifact(verifyMarkdown([{ findingId: "QF-1", status: "cannot_verify" }]))
      .overallStatus,
    "partially_verified"
  );
  assert.equal(
    parseVerificationArtifact(verifyMarkdown([{ findingId: "QF-1", status: "dismissed" }]))
      .overallStatus,
    "disputed"
  );
  assert.equal(
    parseVerificationArtifact(
      verifyMarkdown([
        { findingId: "QF-1", status: "dismissed" },
        { findingId: "QF-2", status: "cannot_verify" }
      ])
    ).overallStatus,
    "disputed"
  );
});

test("verification parser no longer reports an overall status the caller can declare", () => {
  const parsed = parseVerificationArtifact(
    verifyMarkdown([{ findingId: "QF-1", status: "cannot_verify" }], { overallStatus: "verified" })
  );

  assert.equal(parsed.overallStatus, "partially_verified");
});

test("gate blocks a non-advisory open finding that no verdict covered", () => {
  const result = gateFor([finding({ id: "QF-9", status: "open" })], {
    verification: {
      runnerId: "claude:verifier",
      status: "verified",
      artifact: "verify.md",
      coveredFindingIds: [],
      uncoveredOpenFindingIds: ["QF-9"]
    }
  });

  assert.notEqual(result.status, "passed");
  assert.match(result.reasons.join("\n"), /QF-9/);
});

test("gate does not demand verdict coverage when nothing is open", () => {
  const result = gateFor([finding({ status: "risk_accepted" })], {
    verification: {
      runnerId: "claude:verifier",
      status: "verified",
      artifact: "verify.md",
      coveredFindingIds: [],
      uncoveredOpenFindingIds: []
    }
  });

  assert.equal(result.status, "passed", result.reasons.join("; "));
});

test("gate blocks when the verifier disputes a finding that is still open", () => {
  const result = gateFor([finding({ id: "QF-3", status: "open" })], {
    verification: {
      runnerId: "claude:verifier",
      status: "disputed",
      artifact: "verify.md",
      coveredFindingIds: ["QF-3"],
      uncoveredOpenFindingIds: [],
      disputedFindings: ["QF-3"]
    }
  });

  assert.notEqual(result.status, "passed");
  assert.match(result.reasons.join("\n"), /QF-3/);
});

test("gate downgrades a dispute to a warning once a human ruled on the finding", () => {
  const result = gateFor([finding({ id: "QF-3", status: "wont_fix" })], {
    verification: {
      runnerId: "claude:verifier",
      status: "disputed",
      artifact: "verify.md",
      coveredFindingIds: ["QF-3"],
      uncoveredOpenFindingIds: [],
      disputedFindings: ["QF-3"]
    }
  });

  assert.equal(result.status, "passed", result.reasons.join("; "));
  assert.match(result.warnings.join("\n"), /QF-3/);
});

// Declared full-project once for the whole file: status vocabulary is orthogonal to the
// frozen changeset, and this mode's own context requirements are declared below.
function gateFor(findings, overrides = {}) {
  return reduceQualityGate(
    asFullProject({
      runId: "run-1",
      status: "open",
      reviewers: [
        { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex.md" },
        { runnerId: "claude:sonnet", status: "completed", artifact: "reviews/claude.md" }
      ],
      findings,
      requiredChecks: [{ name: "npm test", status: "passed" }],
      verification: {
        runnerId: "claude:verifier",
        status: "verified",
        artifact: "verify.md",
        coveredFindingIds: findings.map((item) => item.id),
        uncoveredOpenFindingIds: []
      },
      ...overrides
    }),
    { minReviewers: 2, requireHumanDecision: false, requireRequiredChecks: true }
  );
}

function finding(overrides = {}) {
  return {
    id: "QF-1",
    title: "t",
    severity: "warning",
    status: "open",
    sourceRunnerId: "codex:gpt-5",
    ...overrides
  };
}

function reviewMarkdown(status) {
  const body = {
    runnerId: "codex:gpt-5",
    status: "completed",
    findings: [
      {
        id: "QF-001",
        title: "Install script executes an unverified remote payload from a mutable mirror",
        description: "x".repeat(120),
        suggestion: "y".repeat(120),
        severity: "blocker",
        ...(status === null ? {} : { status })
      }
    ]
  };
  return `# Review\n\n\`\`\`kualityforge-review\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

function verifyMarkdown(verdicts, extra = {}) {
  const body = { runnerId: "claude:verifier", verdicts, ...extra };
  return `# Verify\n\n\`\`\`kualityforge-verification\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}
