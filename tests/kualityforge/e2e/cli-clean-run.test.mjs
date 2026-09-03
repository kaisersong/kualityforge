import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { decisionMarkdown, synthesizeReviewFindings, verificationMarkdown } from "../helpers/artifact-fixtures.mjs";
import { applyDeterministicGitEnv, createChangesetProject } from "../helpers/git-env.mjs";

// The CLI runs in a child process that inherits this env, and init spawns git to freeze
// the changeset, so the host git config has to be shut out here rather than at the seam.
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

test("CLI can initialize, collect clean reviews, decide, verify, and pass gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-clean-run-"));
  // A real repository with real uncommitted work: the gate requires a usable frozen
  // changeset, and this run earns one the same way a production run does.
  const projectRoot = await createChangesetProject();
  try {
    assert.equal(
      runCli([
        "init",
        "--artifact-root",
        root,
        "--run-id",
        "clean-run",
        "--profile",
        "release",
        "--project-root",
        projectRoot
      ]).status,
      0
    );

    const initializedManifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    const contextManifestHash = initializedManifest.context.contextManifest.sha256;
    const codexReview = await writeReview(
      root,
      "codex.md",
      "codex:gpt-5",
      contextManifestHash
    );
    const claudeReview = await writeReview(
      root,
      "claude.md",
      "claude:sonnet",
      contextManifestHash
    );

    assert.equal(
      runCli([
        "write-review",
        "--artifact-root",
        root,
        "--input",
        codexReview,
        "--expected-runner-id",
        "codex:gpt-5"
      ]).status,
      0
    );
    assert.equal(
      runCli([
        "write-review",
        "--artifact-root",
        root,
        "--input",
        claudeReview,
        "--expected-runner-id",
        "claude:sonnet"
      ]).status,
      0
    );

    const synthesize = runCli(["synthesize", "--artifact-root", root]);
    assert.equal(synthesize.status, 0, synthesize.stderr);

    await access(join(root, "scores.json"));
    await access(join(root, "induced-principles.json"));
    const manifestAfterSynthesis = JSON.parse(
      await readFile(join(root, "manifest.json"), "utf8")
    );
    assert.equal(manifestAfterSynthesis.reviewerScores.artifact, "scores.json");
    assert.ok(Array.isArray(manifestAfterSynthesis.reviewerScores.scores));
    assert.equal(manifestAfterSynthesis.inducedPrinciples.artifact, "induced-principles.json");

    const decision = join(root, "decision-input.md");
    await writeFile(
      decision,
      decisionMarkdown({ runId: "clean-run", findings: SYNTHESIZED_FINDINGS }),
      "utf8"
    );
    const decide = runCli([
      "decide",
      "--artifact-root",
      root,
      "--input",
      decision,
      "--owner",
      "kai"
    ]);
    assert.equal(decide.status, 0, decide.stderr);

    assert.equal(
      runCli([
        "record-check",
        "--artifact-root",
        root,
        "--name",
        "npm test",
        "--status",
        "passed"
      ]).status,
      0
    );

    const verify = join(root, "verify-input.md");
    await writeFile(verify, verificationMarkdown({ runnerId: "claude:verifier" }), "utf8");
    const verified = runCli([
      "verify",
      "--artifact-root",
      root,
      "--runner-id",
      "claude:verifier",
      "--input",
      verify
    ]);
    assert.equal(verified.status, 0, verified.stderr);

    const gate = runCli(["gate", "--artifact-root", root]);
    assert.equal(gate.status, 0, gate.stderr);
    assert.equal(JSON.parse(gate.stdout).status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function writeReview(root, filename, runnerId, contextManifestHash) {
  const path = join(root, filename);
  await writeFile(
    path,
    `# Review

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
`,
    "utf8"
  );
  return path;
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}
