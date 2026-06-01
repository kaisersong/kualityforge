import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = resolve("src/cli/index.mjs");

test("gate --policy applies project-specific reviewer threshold", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-policy-cli-"));
  try {
    const manifestPath = join(root, "manifest.json");
    const policyPath = join(root, ".kualityforge.json");

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          runId: "policy-run",
          status: "verified",
          reviewers: [{ runnerId: "codex", artifact: "reviews/codex.md" }],
          humanDecision: { artifact: "decision.md" },
          verification: { runnerId: "verifier", status: "verified", artifact: "verify.md" },
          findings: [],
          requiredChecks: [{ name: "npm test", status: "passed" }]
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(policyPath, JSON.stringify({ minReviewers: 1 }, null, 2), "utf8");

    const result = spawnSync(
      process.execPath,
      [cliPath, "gate", "--manifest", manifestPath, "--policy", policyPath],
      { cwd: resolve("."), encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
