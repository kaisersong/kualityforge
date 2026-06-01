import assert from "node:assert/strict";
import test from "node:test";
import { createReviewTask } from "../../../src/core/runner-task.mjs";

test("createReviewTask defines a runner-agnostic review handoff", () => {
  const task = createReviewTask({
    runId: "run-1",
    artifactRoot: "docs/quality/run-1",
    runnerId: "codex:gpt-5",
    target: "/repo"
  });

  assert.equal(task.kind, "kualityforge.review");
  assert.equal(task.runId, "run-1");
  assert.equal(task.runnerId, "codex:gpt-5");
  assert.equal(task.role, "reviewer");
  assert.equal(task.target, "/repo");
  assert.equal(task.outputArtifact, "reviews/codex-gpt-5.md");
});
