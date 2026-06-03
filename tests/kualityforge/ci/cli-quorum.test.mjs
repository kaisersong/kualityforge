import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";

const cliPath = resolve("src/cli/index.mjs");

test("kswarm-run --offline threads quorum policy and passes with advisory absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-quorum-"));
  try {
    const artifactRoot = join(root, "artifacts");
    const reviewers = ["codex:gpt-5", "claude:sonnet", "gemini:pro"];
    const { previewPath, planPath } = await writeRunFixtures(root, artifactRoot, reviewers);

    const codexReview = join(root, "codex.md");
    const claudeReview = join(root, "claude.md");
    const decision = join(root, "decision.md");
    const verify = join(root, "verify.md");
    await writeFile(codexReview, reviewMarkdown("codex:gpt-5"), "utf8");
    await writeFile(claudeReview, reviewMarkdown("claude:sonnet"), "utf8");
    await writeFile(decision, "# Decision\n\nApprove.\n", "utf8");
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

    const manifest = JSON.parse(await readFile(join(artifactRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.reviewPolicy.mode, "quorum");
    assert.equal(manifest.reviewPolicy.quorumMin, 2);
    assert.equal(manifest.reviewOutcomes.length, 3);
    const gemini = manifest.reviewOutcomes.find((entry) => entry.runnerId === "gemini:pro");
    assert.equal(gemini.status, "skipped");
    assert.ok(gemini.absenceReason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kswarm-preview rejects advisory reviewer that downgrades a required reviewer", () => {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "kswarm-preview",
      "--project-id",
      "p",
      "--run-id",
      "r",
      "--artifact-root",
      "/tmp/qf-ar",
      "--reviewer",
      "codex:gpt-5",
      "--advisory-reviewer",
      "codex:gpt-5",
      "--quorum-min",
      "1"
    ],
    { cwd: resolve("."), encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot downgrade a required reviewer/);
});

test("kswarm-run exits non-zero on contradictory quorum policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-quorum-bad-"));
  try {
    const artifactRoot = join(root, "artifacts");
    const reviewers = ["codex:gpt-5", "claude:sonnet"];
    const { previewPath, planPath } = await writeRunFixtures(root, artifactRoot, reviewers);
    const decision = join(root, "decision.md");
    await writeFile(decision, "# Decision\n\nApprove.\n", "utf8");

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
        "--quorum-min",
        "5",
        "--decision",
        decision
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("help text documents quorum usage and advisory limits", () => {
  const result = spawnSync(process.execPath, [cliPath, "help"], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--advisory-reviewer/);
  assert.match(result.stdout, /--quorum-min/);
  assert.match(result.stdout, /cannot downgrade a runner already declared as --reviewer/);
});

async function writeRunFixtures(root, artifactRoot, reviewers) {
  const workflowOptions = {
    projectId: "proj-qf-cli-quorum",
    runId: "release-cli-quorum",
    artifactRoot,
    reviewers,
    createdAt: 1782000000000
  };
  const previewPath = join(root, "preview.json");
  const planPath = join(root, "runtime-plan.json");
  await writeFile(previewPath, JSON.stringify(createKswarmScriptPreview(workflowOptions), null, 2), "utf8");
  await writeFile(planPath, JSON.stringify(createKswarmRuntimePlan(workflowOptions), null, 2), "utf8");
  return { previewPath, planPath };
}

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
