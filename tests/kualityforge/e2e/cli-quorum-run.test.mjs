import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";

const cliPath = resolve("src/cli/index.mjs");

test("e2e offline quorum run passes with required present and one advisory absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-e2e-quorum-"));
  try {
    const artifactRoot = join(root, "artifacts");
    const reviewers = ["codex:gpt-5", "claude:sonnet", "gemini:pro"];
    const workflowOptions = {
      projectId: "proj-qf-e2e-quorum",
      runId: "release-e2e-quorum",
      artifactRoot,
      reviewers,
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
    await writeFile(decision, "# Decision\n\nApprove.\n", "utf8");
    await writeFile(verify, "# Verify\n\nVerified.\n", "utf8");

    // gemini:pro advisory reviewer intentionally absent (no --review provided).
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
        "--advisory-reviewer",
        "claude:sonnet",
        "--advisory-reviewer",
        "gemini:pro",
        "--quorum-min",
        "2",
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
    assert.ok(
      output.gate.warnings.some((warning) => warning.includes("gemini:pro")),
      `expected advisory absence warning, got ${JSON.stringify(output.gate.warnings)}`
    );

    const summary = await readFile(join(artifactRoot, "summary.md"), "utf8");
    assert.match(summary, /## Quorum Review/);
    assert.match(summary, /gemini:pro: absent/);
    assert.match(summary, /codex:gpt-5: present/);
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
  "findings": [
    {
      "id": "QF-001",
      "title": "Potential issue identified during review requiring further investigation and resolution",
      "description": "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
      "suggestion": "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
      "severity": "info",
      "status": "risk_accepted"
    }
  ]
}
\`\`\`
`;
}
