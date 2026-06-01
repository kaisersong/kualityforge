import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTemplate } from "../../../src/core/workflow-template.mjs";

test("createWorkflowTemplate exposes the expected KualityFore node order", () => {
  const workflow = createWorkflowTemplate({
    runId: "workflow-1",
    artifactRoot: "docs/quality/workflow-1",
    reviewers: ["codex", "claude"]
  });

  assert.deepEqual(
    workflow.nodes.map((node) => node.type),
    [
      "initialize_scope",
      "collect_target_context",
      "reviewer",
      "reviewer",
      "collect_review_artifacts",
      "synthesize_findings",
      "human_decision_gate",
      "fix_approved_items",
      "run_required_checks",
      "independent_verify",
      "reduce_gate_status",
      "publish_manifest"
    ]
  );
});

test("reviewer nodes use distinct artifact paths", () => {
  const workflow = createWorkflowTemplate({
    runId: "workflow-2",
    artifactRoot: "docs/quality/workflow-2",
    reviewers: ["codex:gpt-5", "claude:sonnet"]
  });

  const reviewerArtifacts = workflow.nodes
    .filter((node) => node.type === "reviewer")
    .map((node) => node.outputArtifact);

  assert.deepEqual(reviewerArtifacts, [
    "reviews/codex-gpt-5.md",
    "reviews/claude-sonnet.md"
  ]);
});
