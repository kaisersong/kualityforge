import { createReviewTask } from "./runner-task.mjs";

const STATIC_NODE_TYPES = [
  "initialize_scope",
  "collect_target_context",
  "collect_review_artifacts",
  "synthesize_findings",
  "human_decision_gate",
  "fix_approved_items",
  "run_required_checks",
  "independent_verify",
  "reduce_gate_status",
  "publish_manifest"
];

export function createWorkflowTemplate({ runId, artifactRoot, reviewers, target = "." }) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error("reviewers must be a non-empty array");
  }

  const reviewerNodes = reviewers.map((runnerId, index) => {
    const task = createReviewTask({ runId, artifactRoot, runnerId, target });
    return {
      id: `reviewer-${index + 1}`,
      type: "reviewer",
      runnerId,
      outputArtifact: task.outputArtifact,
      task
    };
  });

  return {
    kind: "kualityforge.workflow-template",
    runId,
    artifactRoot,
    nodes: [
      node("initialize_scope"),
      node("collect_target_context"),
      ...reviewerNodes,
      ...STATIC_NODE_TYPES.slice(2).map(node)
    ]
  };
}

function node(type) {
  return {
    id: type,
    type
  };
}
