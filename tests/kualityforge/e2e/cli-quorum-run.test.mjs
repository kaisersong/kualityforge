import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initializeArtifactRoot } from "../../../src/core/artifact-root.mjs";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";
import { decisionMarkdown, synthesizeReviewFindings, verificationMarkdown } from "../helpers/artifact-fixtures.mjs";
import { applyDeterministicGitEnv, createChangesetProject } from "../helpers/git-env.mjs";

await applyDeterministicGitEnv();

const FINDING_TITLE =
  "Potential issue identified during review requiring further investigation and resolution";

const RAW_FINDING = {
  id: "QF-001",
  title: FINDING_TITLE,
  description: "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
  suggestion: "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
  severity: "info"
};
const SYNTHESIZED_FINDINGS = synthesizeReviewFindings([
  { runnerId: "codex:gpt-5", findings: [RAW_FINDING] },
  { runnerId: "claude:sonnet", findings: [RAW_FINDING] }
]);

const cliPath = resolve("src/cli/index.mjs");

test("e2e offline quorum run passes with required present and one advisory absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-e2e-quorum-"));
  const projectRoot = await createChangesetProject();
  try {
    const artifactRoot = join(root, "artifacts");
    const reviewers = ["codex:gpt-5", "claude:sonnet", "gemini:pro"];
    const workflowOptions = {
      projectId: "proj-qf-e2e-quorum",
      runId: "release-e2e-quorum",
      artifactRoot,
      projectRoot,
      reviewers,
      createdAt: 1782000000000
    };
    const previewPath = join(root, "preview.json");
    const planPath = join(root, "runtime-plan.json");
    const runtimePlan = createKswarmRuntimePlan(workflowOptions);
    await writeFile(previewPath, JSON.stringify(createKswarmScriptPreview(workflowOptions), null, 2), "utf8");
    await writeFile(planPath, JSON.stringify(runtimePlan, null, 2), "utf8");
    const seeded = await initializeArtifactRoot(artifactRoot, {
      runId: runtimePlan.runId,
      profile: runtimePlan.profile || "release",
      context: {
        projectRoot: runtimePlan.projectRoot,
        docsRoots: runtimePlan.docsRoots || [],
        qualityPrinciplesPath: runtimePlan.qualityPrinciplesPath,
        changeGoal: runtimePlan.changeGoal,
        generatedAt: runtimePlan.contextGeneratedAt,
        ...(runtimePlan.changeset ? { changeset: runtimePlan.changeset } : {}),
        enableStructureScan: true,
        ...(runtimePlan.reviewType ? { reviewType: runtimePlan.reviewType } : {})
      }
    });
    const contextManifestHash = seeded.manifest.context.contextManifest.sha256;

    const codexReview = join(root, "codex.md");
    const claudeReview = join(root, "claude.md");
    const decision = join(root, "decision.md");
    const verify = join(root, "verify.md");
    await writeFile(codexReview, reviewMarkdown("codex:gpt-5", contextManifestHash), "utf8");
    await writeFile(claudeReview, reviewMarkdown("claude:sonnet", contextManifestHash), "utf8");
    await writeFile(
      decision,
      decisionMarkdown({ runId: "release-e2e-quorum", findings: SYNTHESIZED_FINDINGS }),
      "utf8"
    );
    await writeFile(verify, verificationMarkdown({ runnerId: "claude:verifier" }), "utf8");

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
        "--owner",
        "kai",
        "--check",
        "npm test=passed",
        "--verify",
        verify,
        "--verifier-runner-id",
        "claude:verifier"
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
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
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function reviewMarkdown(runnerId, contextManifestHash) {
  return `# Review

\`\`\`kualityforge-review
{
  "runnerId": "${runnerId}",
  "status": "completed",
  "contextProvenance": {
    "contextManifestHash": "${contextManifestHash}"
  },
  "findings": [
    {
      "id": "QF-001",
      "title": "${FINDING_TITLE}",
      "description": "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
      "suggestion": "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
      "severity": "info"
    }
  ]
}
\`\`\`
`;
}
