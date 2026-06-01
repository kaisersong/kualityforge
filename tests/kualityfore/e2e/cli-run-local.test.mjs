import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = resolve("src/cli/index.mjs");

test("run executes a complete local artifact workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityfore-run-local-"));
  try {
    const codexReview = await writeReview(root, "codex-input.md", "codex:gpt-5");
    const claudeReview = await writeReview(root, "claude-input.md", "claude:sonnet");
    const decision = join(root, "decision-input.md");
    const verify = join(root, "verify-input.md");
    await writeFile(decision, "# Decision\n\nNo findings to approve.\n", "utf8");
    await writeFile(verify, "# Verify\n\nVerified.\n", "utf8");

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
        "--review",
        codexReview,
        "--review",
        claudeReview,
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
    assert.equal(output.gate.status, "passed");

    const manifest = JSON.parse(
      await readFile(join(root, "artifacts", "manifest.json"), "utf8")
    );
    assert.equal(manifest.reviewers.length, 2);
    assert.equal(manifest.requiredChecks[0].status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeReview(root, filename, runnerId) {
  const path = join(root, filename);
  await writeFile(
    path,
    `# Review

\`\`\`kualityfore-review
{
  "runnerId": "${runnerId}",
  "status": "completed",
  "findings": []
}
\`\`\`
`,
    "utf8"
  );
  return path;
}
