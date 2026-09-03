import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATE_MARKERS } from "../../../src/core/gate-markers.mjs";
import { reduceQualityGate } from "../../../src/core/gate-reducer.mjs";
import {
  recordVerificationMarkdown,
  writeReviewMarkdownToArtifactRoot
} from "../../../src/core/artifact-operations.mjs";
import { initializeArtifactRoot } from "../../../src/core/artifact-root.mjs";
import { asFullProject, bindDecision, reviewMarkdown } from "../helpers/artifact-fixtures.mjs";

// Declared full-project once for the whole file: diagnostic markers are orthogonal to the
// frozen changeset, and this mode's own context requirements are supplied by the shared
// reducer fixture builder.
function baseManifest(overrides = {}) {
  return asFullProject({
    runId: "qf-markers",
    status: "verified",
    reviewers: [
      { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/codex-gpt-5.md" },
      { runnerId: "claude:sonnet", status: "completed", artifact: "reviews/claude-sonnet.md" }
    ],
    findings: [],
    requiredChecks: [{ name: "npm test", status: "passed" }],
    verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
    ...overrides
  });
}

const GATE_CASES = [
  {
    marker: GATE_MARKERS.ARTIFACT_PATH_DUPLICATE,
    manifest: baseManifest({
      reviewers: [
        { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/shared.md" },
        { runnerId: "claude:sonnet", status: "completed", artifact: "reviews/shared.md" }
      ]
    })
  },
  {
    marker: GATE_MARKERS.ARTIFACT_NAME_COLLISION,
    manifest: baseManifest({
      reviewers: [
        { runnerId: "codex:gpt-5", status: "completed", artifact: "reviews/a.md" },
        { runnerId: "codex/gpt-5", status: "completed", artifact: "reviews/b.md" }
      ]
    })
  },
  {
    marker: GATE_MARKERS.UNKNOWN_FINDING_STATUS,
    manifest: baseManifest({ findings: [{ id: "QF-001", status: "probably_fine" }] })
  },
  {
    marker: GATE_MARKERS.FINDING_ID_DUPLICATE,
    manifest: baseManifest({
      findings: [
        { id: "QF-001", status: "open" },
        { id: "QF-001", status: "open" }
      ]
    })
  },
  {
    marker: GATE_MARKERS.SOURCE_RUNNER_UNDECLARED,
    manifest: baseManifest({
      findings: [{ id: "QF-001", status: "open", sourceRunnerId: "ghost:runner" }]
    })
  },
  {
    marker: GATE_MARKERS.DECISION_OWNER_MISSING,
    manifest: baseManifest({
      humanDecision: { artifact: "decision.md", status: "unparsed" }
    })
  },
  {
    marker: GATE_MARKERS.DECISION_UNPARSED,
    manifest: baseManifest({
      humanDecision: { artifact: "decision.md", owner: "kai", status: "unparsed" }
    })
  },
  {
    marker: GATE_MARKERS.DECISION_DIGEST_MISMATCH,
    manifest: (() => {
      const manifest = bindDecision(
        baseManifest({ findings: [{ id: "QF-001", status: "verified", sourceRunnerId: "codex:gpt-5" }] })
      );
      manifest.humanDecision.findingSetDigest = `sha256:${"0".repeat(64)}`;
      return manifest;
    })()
  },
  {
    marker: GATE_MARKERS.VERDICT_COVERAGE_INCOMPLETE,
    manifest: baseManifest({
      findings: [{ id: "QF-001", status: "open", sourceRunnerId: "codex:gpt-5" }],
      verification: {
        runnerId: "claude:verifier",
        status: "verified",
        artifact: "verify.md",
        uncoveredOpenFindingIds: ["QF-001"]
      }
    })
  }
];

for (const { marker, manifest } of GATE_CASES) {
  test(`gate reports ${marker} as a diagnostic`, () => {
    const result = reduceQualityGate(manifest);
    const markers = result.diagnostics.map((entry) => entry.marker);
    assert.ok(
      markers.includes(marker),
      `expected ${marker} among:\n${markers.join("\n")}\nreasons:\n${result.reasons.join("\n")}`
    );
  });
}

test("every diagnostic message appears verbatim in reasons", () => {
  for (const { manifest } of GATE_CASES) {
    const result = reduceQualityGate(manifest);
    for (const entry of result.diagnostics) {
      assert.ok(
        result.reasons.includes(entry.message),
        `diagnostic "${entry.message}" is not among reasons:\n${result.reasons.join("\n")}`
      );
    }
  }
});

test("a passing gate carries no diagnostics", () => {
  const result = reduceQualityGate(
    bindDecision(
      baseManifest({
        findings: [{ id: "QF-001", status: "verified", sourceRunnerId: "codex:gpt-5" }],
        fixer: { runnerId: "codex:fixer", artifact: "fix-plan.md" }
      })
    )
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.diagnostics, []);
});

test("write boundary tags a runnerId mismatch with a marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-marker-"));
  try {
    await initializeArtifactRoot(root, { runId: "marker-run" });
    const error = await writeReviewMarkdownToArtifactRoot(
      root,
      reviewMarkdown({ runnerId: "codex:gpt-5" }),
      { expectedRunnerId: "claude:sonnet" }
    ).then(
      () => null,
      (thrown) => thrown
    );

    assert.ok(error, "expected the write to be rejected");
    assert.equal(error.marker, GATE_MARKERS.RUNNER_ID_MISMATCH);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write boundary tags an unparseable verification artifact with a marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-marker-verify-"));
  try {
    await initializeArtifactRoot(root, { runId: "marker-run" });
    const error = await recordVerificationMarkdown(root, "# Verification\n\nno block here\n", {
      runnerId: "claude:verifier"
    }).then(
      () => null,
      (thrown) => thrown
    );

    assert.ok(error, "expected the write to be rejected");
    assert.equal(error.marker, GATE_MARKERS.VERIFICATION_UNPARSED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write boundary tags an artifact name collision with a marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-marker-collision-"));
  try {
    await initializeArtifactRoot(root, { runId: "marker-run" });
    await mkdir(join(root, "reviews"), { recursive: true });
    await writeFile(join(root, "keep.md"), "placeholder", "utf8");

    await writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }), {
      expectedRunnerId: "codex:gpt-5"
    });

    const error = await writeReviewMarkdownToArtifactRoot(
      root,
      reviewMarkdown({ runnerId: "codex/gpt-5" }),
      { expectedRunnerId: "codex/gpt-5" }
    ).then(
      () => null,
      (thrown) => thrown
    );

    assert.ok(error, "expected the colliding write to be rejected");
    assert.equal(error.marker, GATE_MARKERS.ARTIFACT_NAME_COLLISION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A marker nobody emits is a promise to downstream consumers that the code does
// not keep, so the vocabulary and the producers are asserted to match exactly.
test("every declared marker has at least one producer", async () => {
  const produced = new Set();

  for (const { manifest } of GATE_CASES) {
    for (const entry of reduceQualityGate(manifest).diagnostics) {
      produced.add(entry.marker);
    }
  }

  const root = await mkdtemp(join(tmpdir(), "kualityforge-marker-coverage-"));
  try {
    await initializeArtifactRoot(root, { runId: "marker-run" });

    const mismatch = await writeReviewMarkdownToArtifactRoot(
      root,
      reviewMarkdown({ runnerId: "codex:gpt-5" }),
      { expectedRunnerId: "claude:sonnet" }
    ).catch((error) => error);
    produced.add(mismatch.marker);

    const unparsed = await recordVerificationMarkdown(root, "not a verification artifact", {
      runnerId: "claude:verifier"
    }).catch((error) => error);
    produced.add(unparsed.marker);

    await writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }), {
      expectedRunnerId: "codex:gpt-5"
    });
    const collision = await writeReviewMarkdownToArtifactRoot(
      root,
      reviewMarkdown({ runnerId: "codex/gpt-5" }),
      { expectedRunnerId: "codex/gpt-5" }
    ).catch((error) => error);
    produced.add(collision.marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.deepEqual([...produced].sort(), Object.keys(GATE_MARKERS).sort());
});

test("marker keys and values are identical so serialized output is self-describing", () => {
  for (const [key, value] of Object.entries(GATE_MARKERS)) {
    assert.equal(key, value);
  }
});
