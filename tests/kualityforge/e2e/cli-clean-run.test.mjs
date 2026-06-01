import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = resolve("src/cli/index.mjs");

test("CLI can initialize, collect clean reviews, decide, verify, and pass gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-clean-run-"));
  try {
    assert.equal(
      runCli(["init", "--artifact-root", root, "--run-id", "clean-run", "--profile", "release"])
        .status,
      0
    );

    const codexReview = await writeReview(root, "codex.md", "codex:gpt-5");
    const claudeReview = await writeReview(root, "claude.md", "claude:sonnet");

    assert.equal(
      runCli(["write-review", "--artifact-root", root, "--input", codexReview]).status,
      0
    );
    assert.equal(
      runCli(["write-review", "--artifact-root", root, "--input", claudeReview]).status,
      0
    );

    const synthesize = runCli(["synthesize", "--artifact-root", root]);
    assert.equal(synthesize.status, 0, synthesize.stderr);

    const decision = join(root, "decision-input.md");
    await writeFile(decision, "# Decision\n\nNo findings to approve.\n", "utf8");
    assert.equal(runCli(["decide", "--artifact-root", root, "--input", decision]).status, 0);

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
    await writeFile(verify, "# Verify\n\nClean run verified.\n", "utf8");
    assert.equal(
      runCli([
        "verify",
        "--artifact-root",
        root,
        "--runner-id",
        "claude:verifier",
        "--status",
        "verified",
        "--input",
        verify
      ]).status,
      0
    );

    const gate = runCli(["gate", "--artifact-root", root]);
    assert.equal(gate.status, 0, gate.stderr);
    assert.equal(JSON.parse(gate.stdout).status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
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
  "findings": []
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
