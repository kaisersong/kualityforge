import assert from "node:assert/strict";
import test from "node:test";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";
import { normalizePolicy } from "../../../src/core/policy.mjs";

const REVIEW = Object.freeze({
  mode: "quorum",
  requiredReviewers: ["req:1"],
  quorumMembers: ["req:1", "adv:2", "adv:3"],
  advisoryReviewers: ["adv:2", "adv:3"],
  quorumMin: 2
});

function baseManifest(overrides = {}) {
  return {
    runId: "qf-quorum",
    status: "verified",
    reviewPolicy: { ...REVIEW },
    reviewers: [
      { runnerId: "req:1", status: "completed", artifact: "reviews/req1.md" },
      { runnerId: "adv:2", status: "completed", artifact: "reviews/adv2.md" }
    ],
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "dispatch declined" }
    ],
    humanDecision: { artifact: "decision.md" },
    fixer: { runnerId: "codex:fixer" },
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }],
    ...overrides
  };
}

function reduce(manifest, reviewOverride) {
  const policy = normalizePolicy({ review: reviewOverride || { ...REVIEW } });
  return reduceQualityGate(manifest, policy);
}

// --- 正向 ---
test("quorum satisfied with required present passes (A: item 1)", () => {
  const result = reduce(baseManifest());
  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  // adv:3 absent -> warning present
  assert.ok(result.warnings.some((w) => w.includes("adv:3")));
});

test("quorum over-satisfied passes (item 2)", () => {
  const manifest = baseManifest({
    reviewers: [
      { runnerId: "req:1", status: "completed", artifact: "r1.md" },
      { runnerId: "adv:2", status: "completed", artifact: "r2.md" },
      { runnerId: "adv:3", status: "completed", artifact: "r3.md" }
    ],
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:3", status: "succeeded" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.warnings, []);
});

test("required_all unchanged when review policy absent (item 3)", () => {
  const result = reduceQualityGate(
    {
      runId: "legacy",
      status: "verified",
      reviewers: [
        { runnerId: "a", artifact: "a.md" },
        { runnerId: "b", artifact: "b.md" }
      ],
      humanDecision: { artifact: "d.md" },
      fixer: { runnerId: "f" },
      verification: { runnerId: "v", status: "verified", artifact: "v.md" },
      findings: [],
      requiredChecks: [{ name: "t", status: "passed" }]
    },
    normalizePolicy({})
  );
  assert.equal(result.status, "passed");
});

// --- required 不可豁免 ---
test("quorum satisfied but required absent -> incomplete (item 4)", () => {
  const manifest = baseManifest({
    reviewers: [
      { runnerId: "adv:2", status: "completed", artifact: "r2.md" },
      { runnerId: "adv:3", status: "completed", artifact: "r3.md" }
    ],
    reviewOutcomes: [
      { runnerId: "req:1", status: "skipped", absenceReason: "no dispatch" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:3", status: "succeeded" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /required reviewer missing: req:1/);
});

// --- policy 强校验 fail closed ---
test("quorumMin non-integer -> invalid_artifact (item 10)", () => {
  for (const bad of ["2", 2.5, 0, -1, Number.NaN, undefined]) {
    const result = reduce(baseManifest(), { ...REVIEW, quorumMin: bad });
    assert.equal(result.status, "invalid_artifact", `quorumMin=${String(bad)}`);
    assert.equal(result.exitCode, 1);
  }
});

test("quorumMin > members -> invalid_artifact (item 11)", () => {
  const result = reduce(baseManifest(), { ...REVIEW, quorumMin: 4 });
  assert.equal(result.status, "invalid_artifact");
});

test("quorumMin < required count -> invalid_artifact (item 12)", () => {
  const review = {
    mode: "quorum",
    requiredReviewers: ["req:1", "adv:2"],
    quorumMembers: ["req:1", "adv:2", "adv:3"],
    advisoryReviewers: ["adv:3"],
    quorumMin: 1
  };
  const manifest = baseManifest({ reviewPolicy: { ...review } });
  const result = reduce(manifest, review);
  assert.equal(result.status, "invalid_artifact");
});

test("invalid mode -> invalid_artifact (item 13)", () => {
  const result = reduce(baseManifest({ reviewPolicy: { ...REVIEW, mode: "x" } }), {
    ...REVIEW,
    mode: "x"
  });
  assert.equal(result.status, "invalid_artifact");
});

test("legacy minReviewers conflicts with quorum -> invalid_artifact (item 14)", () => {
  const policy = normalizePolicy({ minReviewers: 5, review: { ...REVIEW } });
  const result = reduceQualityGate(baseManifest(), policy);
  assert.equal(result.status, "invalid_artifact");
});

// --- identity set 语义 ---
test("duplicate reviewer runnerId -> invalid_artifact (item 15)", () => {
  const manifest = baseManifest({
    reviewers: [
      { runnerId: "req:1", status: "completed", artifact: "a.md" },
      { runnerId: "req:1", status: "completed", artifact: "b.md" },
      { runnerId: "adv:2", status: "completed", artifact: "c.md" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("duplicate quorum members -> invalid_artifact (item 16)", () => {
  const review = { ...REVIEW, quorumMembers: ["req:1", "adv:2", "adv:2"] };
  const result = reduce(baseManifest({ reviewPolicy: { ...review } }), review);
  assert.equal(result.status, "invalid_artifact");
});

test("required not subset of quorum -> invalid_artifact (item 17)", () => {
  const review = {
    mode: "quorum",
    requiredReviewers: ["req:1"],
    quorumMembers: ["adv:2", "adv:3"],
    advisoryReviewers: ["req:1", "adv:2", "adv:3"],
    quorumMin: 2
  };
  const result = reduce(baseManifest({ reviewPolicy: { ...review } }), review);
  assert.equal(result.status, "invalid_artifact");
});

test("required/advisory overlap -> invalid_artifact (item 18)", () => {
  const review = { ...REVIEW, advisoryReviewers: ["req:1", "adv:2", "adv:3"] };
  const result = reduce(baseManifest({ reviewPolicy: { ...review } }), review);
  assert.equal(result.status, "invalid_artifact");
});

test("quorum member unknown -> invalid_artifact (item 19)", () => {
  const review = { ...REVIEW, quorumMembers: ["req:1", "adv:2", "ghost"] };
  const result = reduce(baseManifest({ reviewPolicy: { ...review } }), review);
  assert.equal(result.status, "invalid_artifact");
});

test("unknown reviewer in manifest -> invalid_artifact (item 20)", () => {
  const manifest = baseManifest({
    reviewers: [
      { runnerId: "req:1", status: "completed", artifact: "a.md" },
      { runnerId: "ghost", status: "completed", artifact: "g.md" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

// --- drift ---
test("manifest reviewPolicy drift -> invalid_artifact (item 7/8)", () => {
  const manifest = baseManifest({
    reviewPolicy: { ...REVIEW, requiredReviewers: [] }
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("manifest reviewPolicy quorumMin drift -> invalid_artifact (item 9)", () => {
  const manifest = baseManifest({ reviewPolicy: { ...REVIEW, quorumMin: 3 } });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

// --- advisory 缺席 / warnings ---
test("advisory non-member absence does not block, warning emitted (item 21)", () => {
  const review = {
    mode: "quorum",
    requiredReviewers: ["req:1"],
    quorumMembers: ["req:1", "adv:2"],
    advisoryReviewers: ["adv:2", "adv:9"],
    quorumMin: 2
  };
  const manifest = baseManifest({
    reviewPolicy: { ...review },
    reviewers: [
      { runnerId: "req:1", status: "completed", artifact: "a.md" },
      { runnerId: "adv:2", status: "completed", artifact: "b.md" }
    ],
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:9", status: "skipped", absenceReason: "not scheduled" }
    ]
  });
  const result = reduce(manifest, review);
  assert.equal(result.status, "passed");
  assert.ok(result.warnings.some((w) => w.includes("adv:9")));
});

test("advisory quorum member absence causing shortage -> incomplete (item 22)", () => {
  const manifest = baseManifest({
    reviewers: [{ runnerId: "req:1", status: "completed", artifact: "a.md" }],
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "skipped", absenceReason: "x" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "y" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /quorum shortage/);
});

test("gate result always includes warnings array (item 23)", () => {
  const result = reduce(baseManifest());
  assert.ok(Array.isArray(result.warnings));
});

// --- evidence 来源纯净 ---
test("node summary is never evidence (item 25)", () => {
  const manifest = baseManifest({
    reviewers: [{ runnerId: "req:1", status: "completed", artifact: "a.md" }],
    nodeSummary: "all reviews passed",
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "skipped", absenceReason: "x" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "y" }
    ]
  });
  const result = reduce(manifest);
  // only req:1 succeeded -> quorum 1 < 2
  assert.equal(result.status, "incomplete");
  assert.match(result.reasons.join("\n"), /quorum shortage/);
});

// --- advisory finding 语义 (B2/A8) ---
test("advisory finding does not block, becomes warning (item 26)", () => {
  const manifest = baseManifest({
    reviewers: [
      { runnerId: "req:1", status: "completed", artifact: "a.md" },
      { runnerId: "adv:2", status: "completed", artifact: "b.md" }
    ],
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "x" }
    ],
    findings: [{ id: "F-1", status: "open", sourceRunnerId: "adv:2" }]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "passed");
  assert.ok(result.warnings.some((w) => w.includes("F-1")));
});

test("required reviewer must violation still blocks (item 28)", () => {
  const manifest = baseManifest({
    reviewers: [
      { runnerId: "req:1", status: "completed", artifact: "a.md" },
      { runnerId: "adv:2", status: "completed", artifact: "b.md" }
    ],
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "x" }
    ],
    findings: [
      {
        id: "F-must",
        type: "quality_principle_violation",
        priority: "must",
        status: "open",
        sourceRunnerId: "req:1"
      }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "incomplete");
});

// --- role spoof (B2) ---
test("required finding self-declared advisory -> invalid_artifact (28a)", () => {
  const manifest = baseManifest({
    findings: [
      { id: "F-x", status: "open", sourceRunnerId: "req:1", sourceReviewerRole: "advisory" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("required reviewer self-declared advisory role -> invalid_artifact (28b)", () => {
  const manifest = baseManifest({
    reviewers: [
      { runnerId: "req:1", status: "completed", artifact: "a.md", role: "advisory" },
      { runnerId: "adv:2", status: "completed", artifact: "b.md" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("advisory outcome self-declared required role -> invalid_artifact (28c)", () => {
  const manifest = baseManifest({
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded", role: "required" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "x" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("unknown finding sourceRunnerId -> invalid_artifact (28d)", () => {
  const manifest = baseManifest({
    findings: [{ id: "F-u", status: "verified", sourceRunnerId: "ghost" }]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

// --- reviewOutcomes 一致性 (B3) ---
test("missing outcome for expected reviewer -> invalid_artifact (28f)", () => {
  const manifest = baseManifest({
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("duplicate outcome -> invalid_artifact (28g)", () => {
  const manifest = baseManifest({
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "x" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("unknown outcome runnerId -> invalid_artifact (28h)", () => {
  const manifest = baseManifest({
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "x" },
      { runnerId: "ghost", status: "succeeded" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("succeeded outcome but reviewer not registered -> invalid_artifact (28i)", () => {
  const manifest = baseManifest({
    reviewers: [{ runnerId: "req:1", status: "completed", artifact: "a.md" }],
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "x" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("registered reviewer but outcome failed -> invalid_artifact (28j)", () => {
  const manifest = baseManifest({
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "failed", absenceReason: "x" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "y" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

test("failed outcome missing absenceReason -> invalid_artifact (28k)", () => {
  const manifest = baseManifest({
    reviewers: [{ runnerId: "req:1", status: "completed", artifact: "a.md" }],
    reviewOutcomes: [
      { runnerId: "req:1", status: "succeeded" },
      { runnerId: "adv:2", status: "failed" },
      { runnerId: "adv:3", status: "skipped", absenceReason: "y" }
    ]
  });
  const result = reduce(manifest);
  assert.equal(result.status, "invalid_artifact");
});

// --- 确定性 (A11) ---
test("deterministic output regardless of input order (item 29/30)", () => {
  const a = reduce(baseManifest());
  const shuffled = baseManifest({
    reviewers: [
      { runnerId: "adv:2", status: "completed", artifact: "reviews/adv2.md" },
      { runnerId: "req:1", status: "completed", artifact: "reviews/req1.md" }
    ],
    reviewOutcomes: [
      { runnerId: "adv:3", status: "skipped", absenceReason: "dispatch declined" },
      { runnerId: "adv:2", status: "succeeded" },
      { runnerId: "req:1", status: "succeeded" }
    ]
  });
  const b = reduce(shuffled);
  assert.deepEqual(a, b);
});
