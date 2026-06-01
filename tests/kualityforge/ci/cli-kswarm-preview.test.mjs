import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = resolve("src/cli/index.mjs");

test("kswarm-preview prints preview and runtime plan", () => {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "kswarm-preview",
      "--project-id",
      "proj-qf",
      "--run-id",
      "release-cli",
      "--artifact-root",
      "docs/quality/release-cli",
      "--reviewer",
      "codex:gpt-5",
      "--reviewer",
      "claude:sonnet",
      "--created-at",
      "1782000000000"
    ],
    { cwd: resolve("."), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.preview.source, "script_generated");
  assert.equal(output.preview.workflowId, "kualityforge_quality_gate");
  assert.equal(output.runtimePlan.reviewers.length, 2);
  assert.equal(output.runtimePlan.operations.some((operation) => operation.type === "dispatch_reviewer"), true);
});
