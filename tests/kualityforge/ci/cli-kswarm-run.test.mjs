import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";

const cliPath = resolve("src/cli/index.mjs");

test("kswarm-run --offline executes a runtime plan from local artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-kswarm-run-"));
  try {
    const artifactRoot = join(root, "artifacts");
    const workflowOptions = {
      projectId: "proj-qf-cli-runtime",
      runId: "release-cli-runtime",
      artifactRoot,
      reviewers: ["codex:gpt-5", "claude:sonnet"],
      createdAt: 1782000000000
    };
    const previewPath = join(root, "preview.json");
    const planPath = join(root, "runtime-plan.json");
    await writeFile(previewPath, JSON.stringify(createKswarmScriptPreview(workflowOptions), null, 2), "utf8");
    await writeFile(planPath, JSON.stringify(createKswarmRuntimePlan(workflowOptions), null, 2), "utf8");

    const codexReview = join(root, "codex.md");
    const claudeReview = join(root, "claude.md");
    const decision = join(root, "decision.md");
    const verify = join(root, "verify.md");
    await writeFile(codexReview, reviewMarkdown("codex:gpt-5"), "utf8");
    await writeFile(claudeReview, reviewMarkdown("claude:sonnet"), "utf8");
    await writeFile(decision, "# Decision\n\nNo findings to approve.\n", "utf8");
    await writeFile(verify, "# Verify\n\nVerified.\n", "utf8");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "kswarm-run",
        "--offline",
        "--preview",
        previewPath,
        "--plan",
        planPath,
        "--review",
        `codex:gpt-5=${codexReview}`,
        "--review",
        `claude:sonnet=${claudeReview}`,
        "--decision",
        decision,
        "--check",
        "npm test=passed",
        "--verify",
        verify,
        "--verifier-runner-id",
        "claude:verifier"
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "passed");
    assert.equal(output.terminal.status, "passed");
    assert.equal(output.offlineKswarm.calls.at(-1).type, "complete_run");

    const manifest = JSON.parse(await readFile(join(artifactRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.reviewers.length, 2);
    assert.equal(manifest.verification.runnerId, "claude:verifier");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function reviewMarkdown(runnerId) {
  return `# Review

\`\`\`kualityforge-review
{
  "runnerId": "${runnerId}",
  "status": "completed",
  "findings": []
}
\`\`\`
`;
}
