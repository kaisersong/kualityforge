import assert from "node:assert/strict";
import test from "node:test";
import {
  createKswarmReviewerNodeInput,
  createKswarmRuntimePlan,
  createKswarmScriptPreview,
  mapGateResultToKswarmTerminal
} from "../../../src/core/kswarm-workflow.mjs";

test("createKswarmScriptPreview returns a KSwarm script-generated preview", () => {
  const preview = createKswarmScriptPreview({
    projectId: "proj-qf",
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    requestedBy: "codex",
    createdAt: 1782000000000
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.workflowId, "kualityforge_quality_gate");
  assert.equal(preview.source, "script_generated");
  assert.equal(preview.strategy, "workflow");
  assert.equal(preview.projectId, "proj-qf");
  assert.equal(preview.scope.qualityRunId, "release-1");
  assert.equal(preview.meta.artifactRoot, "docs/quality/release-1");
  assert.deepEqual(preview.meta.reviewers, ["codex:gpt-5", "claude:sonnet"]);
  assert.equal(preview.phases.length, 5);
  assert.match(preview.scriptHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.analysis.parallelCallCount, 1);
  assert.equal(preview.analysis.agentCallCount, 2);
});

test("createKswarmScriptPreview uses stable scriptHash for the same runtime plan", () => {
  const first = createKswarmScriptPreview({
    projectId: "proj-qf",
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    createdAt: 1782000000000
  });
  const second = createKswarmScriptPreview({
    projectId: "proj-qf",
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    createdAt: 1782000000100
  });

  assert.equal(first.scriptHash, second.scriptHash);
});

test("createKswarmRuntimePlan describes reviewer fan-out and artifact writes", () => {
  const plan = createKswarmRuntimePlan({
    projectId: "proj-qf",
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    projectRoot: "/repo",
    docsRoots: ["/docs"],
    qualityPrinciplesPath: "/principles.json",
    changeGoal: "Ship release 1"
  });

  assert.equal(plan.kind, "kualityforge.kswarm-runtime-plan.v1");
  assert.equal(plan.operations.some((operation) => operation.type === "begin_parallel_group"), true);
  assert.equal(plan.operations.filter((operation) => operation.type === "dispatch_reviewer").length, 2);
  assert.equal(plan.operations.find((operation) => operation.type === "write_review_artifact").required, true);
  assert.deepEqual(
    plan.reviewers.map((reviewer) => reviewer.outputArtifact),
    ["reviews/codex-gpt-5.md", "reviews/claude-sonnet.md"]
  );
});

test("createKswarmReviewerNodeInput includes context and review artifact instructions", () => {
  const input = createKswarmReviewerNodeInput({
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    runnerId: "codex:gpt-5",
    target: ".",
    outputArtifact: "reviews/codex-gpt-5.md",
    parallelGroupId: "script-parallel-1"
  });

  assert.equal(input.phaseTitle, "Parallel Review");
  assert.equal(input.label, "KualityForge review: codex:gpt-5");
  assert.equal(input.assignedAgent, "codex:gpt-5");
  assert.equal(input.parallelGroupId, "script-parallel-1");
  assert.equal(input.fanoutItemKey, "reviewer-codex-gpt-5");
  assert.equal(input.required, true);
  assert.equal(input.evidenceRequired, true);
  assert.equal(input.options.outputArtifact, "reviews/codex-gpt-5.md");
  assert.deepEqual(input.options.contextRequired, ["user_quality_principles", "project_brief"]);
  assert.match(input.prompt, /context\/project-brief\.md/);
  assert.match(input.prompt, /```kualityforge-review/);
  assert.match(input.prompt, /contextRead/);
});

test("createKswarmReviewerNodeInput freezes the changeset and forbids self-diff", () => {
  const input = createKswarmReviewerNodeInput({
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    runnerId: "codex:gpt-5",
    target: ".",
    outputArtifact: "reviews/codex-gpt-5.md",
    parallelGroupId: "script-parallel-1"
  });

  assert.match(input.prompt, /context\/changeset\.md/);
  assert.match(input.prompt, /Do NOT run your own git diff/);
  assert.match(input.prompt, /patchTruncated/);
  // Existing context wiring must remain intact.
  assert.match(input.prompt, /context\/project-brief\.md/);
});

test("mapGateResultToKswarmTerminal blocks non-passed gates with artifact evidence", () => {
  const terminal = mapGateResultToKswarmTerminal(
    {
      status: "incomplete",
      exitCode: 2,
      reasons: ["reviewer shortage", "project brief artifact is required"]
    },
    { artifactRoot: "docs/quality/release-1" }
  );

  assert.equal(terminal.status, "blocked");
  assert.match(terminal.reason, /reviewer shortage/);
  assert.deepEqual(terminal.evidenceRefs, [
    "docs/quality/release-1/manifest.json",
    "docs/quality/release-1/summary.md",
    "docs/quality/release-1/verify.md"
  ]);

  const passed = mapGateResultToKswarmTerminal(
    { status: "passed", exitCode: 0, reasons: [] },
    { artifactRoot: "docs/quality/release-1" }
  );
  assert.equal(passed.status, "passed");
});
