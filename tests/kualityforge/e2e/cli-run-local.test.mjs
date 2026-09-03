import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
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

test("run executes a complete local artifact workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-run-local-"));
  const projectRoot = await createChangesetProject();
  try {
    const codexReview = await writeReview(root, "codex-input.md", "codex:gpt-5");
    const claudeReview = await writeReview(root, "claude-input.md", "claude:sonnet");
    const decision = join(root, "decision-input.md");
    const verify = join(root, "verify-input.md");
    const policy = join(root, "policy.json");
    await writeFile(
      policy,
      JSON.stringify({ context: { requireReviewerContextProvenance: false } }, null, 2),
      "utf8"
    );
    await writeFile(
      decision,
      decisionMarkdown({ runId: "local-run", findings: SYNTHESIZED_FINDINGS }),
      "utf8"
    );
    await writeFile(verify, verificationMarkdown({ runnerId: "claude:verifier" }), "utf8");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--artifact-root",
        join(root, "artifacts"),
        "--run-id",
        "local-run",
        "--profile",
        "release",
        "--policy",
        policy,
        "--project-root",
        projectRoot,
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

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "passed");
    assert.equal(output.gate.status, "passed");

    const manifest = JSON.parse(
      await readFile(join(root, "artifacts", "manifest.json"), "utf8")
    );
    assert.equal(manifest.reviewers.length, 2);
    assert.equal(manifest.requiredChecks[0].status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function writeReview(root, filename, runnerId) {
  const path = join(root, filename);
  await writeFile(
    path,
    `# Review

\`\`\`kualityforge-review
{
  "runnerId": "${runnerId}",
  "status": "completed",
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
`,
    "utf8"
  );
  return path;
}
