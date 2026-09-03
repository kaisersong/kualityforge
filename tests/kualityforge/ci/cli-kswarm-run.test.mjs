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

test("kswarm-run --offline executes a runtime plan from local artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-kswarm-run-"));
  const projectRoot = await createChangesetProject();
  try {
    const artifactRoot = join(root, "artifacts");
    const workflowOptions = {
      projectId: "proj-qf-cli-runtime",
      runId: "release-cli-runtime",
      artifactRoot,
      projectRoot,
      reviewers: ["codex:gpt-5", "claude:sonnet"],
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
      decisionMarkdown({ runId: "release-cli-runtime", findings: SYNTHESIZED_FINDINGS }),
      "utf8"
    );
    await writeFile(verify, verificationMarkdown({ runnerId: "claude:verifier" }), "utf8");

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
    assert.equal(output.terminal.status, "passed");
    assert.equal(output.offlineKswarm.calls.at(-1).type, "complete_run");

    const manifest = JSON.parse(await readFile(join(artifactRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.reviewers.length, 2);
    assert.equal(manifest.verification.runnerId, "claude:verifier");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("kswarm-run requires an explicit mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-kswarm-mode-"));
  try {
    const { previewPath, planPath, decision } = await writeRunFixtures(root);
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "kswarm-run",
        "--preview",
        previewPath,
        "--plan",
        planPath,
        "--decision",
        decision,
        "--owner",
        "kai"
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires --offline or --mode brokered/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kswarm-run --mode brokered rejects --review", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-kswarm-brokered-"));
  try {
    const { previewPath, planPath, decision } = await writeRunFixtures(root);
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "kswarm-run",
        "--mode",
        "brokered",
        "--kswarm-url",
        "http://127.0.0.1:4319",
        "--preview",
        previewPath,
        "--plan",
        planPath,
        "--decision",
        decision,
        "--owner",
        "kai",
        "--review",
        "codex:gpt-5=/tmp/x.md"
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only valid in offline mode/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeRunFixtures(root) {
  const artifactRoot = join(root, "artifacts");
  const workflowOptions = {
    projectId: "proj-qf-cli-mode",
    runId: "release-cli-mode",
    artifactRoot,
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    createdAt: 1782000000000
  };
  const previewPath = join(root, "preview.json");
  const planPath = join(root, "runtime-plan.json");
  const decision = join(root, "decision.md");
  await writeFile(previewPath, JSON.stringify(createKswarmScriptPreview(workflowOptions), null, 2), "utf8");
  await writeFile(planPath, JSON.stringify(createKswarmRuntimePlan(workflowOptions), null, 2), "utf8");
  await writeFile(
    decision,
    decisionMarkdown({ runId: "release-cli-mode", findings: SYNTHESIZED_FINDINGS }),
    "utf8"
  );
  return { previewPath, planPath, decision };
}

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
