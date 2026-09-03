import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { asFullProject, bindDecision } from "../helpers/artifact-fixtures.mjs";

const cliPath = resolve("src/cli/index.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: resolve("."), encoding: "utf8" });
}

// Declared full-project once for the whole file: none of these cases is about the frozen
// changeset, and validate reads only the manifest, so the mode's reference set is the
// entire cost of declaring it.
function validManifest(overrides = {}) {
  return asFullProject(
    bindDecision({
      runId: "validate-run",
      status: "verified",
      reviewers: [
        { runnerId: "codex:gpt-5", artifact: "reviews/codex.md", status: "completed" },
        { runnerId: "claude:sonnet", artifact: "reviews/claude.md", status: "completed" }
      ],
      verification: { runnerId: "claude:verifier", status: "verified", artifact: "verify.md" },
      findings: [],
      requiredChecks: [{ name: "npm test", status: "passed" }],
      ...overrides
    })
  );
}

async function writeManifest(root, manifest) {
  const path = join(root, "manifest.json");
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
  return path;
}

test("gate no longer accepts --manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-validate-gate-"));
  try {
    const manifestPath = await writeManifest(root, validManifest());
    const result = runCli(["gate", "--manifest", manifestPath]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /gate requires --artifact-root/);
    assert.match(result.stderr, /validate --manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate accepts a structurally sound manifest and never answers the gate question", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-validate-ok-"));
  try {
    const manifestPath = await writeManifest(root, validManifest());
    const result = runCli(["validate", "--manifest", manifestPath]);
    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout);
    assert.equal(output.valid, true);
    assert.deepEqual(output.errors, []);
    assert.deepEqual(output.warnings, []);
    assert.ok(!("status" in output), `validate output must not carry a status key: ${result.stdout}`);
    assert.ok(!("exitCode" in output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate reports shape errors with exit 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-validate-bad-"));
  try {
    const manifestPath = await writeManifest(root, validManifest({ reviewers: [{}, {}] }));
    const result = runCli(["validate", "--manifest", manifestPath]);
    assert.equal(result.status, 1);

    const output = JSON.parse(result.stdout);
    assert.equal(output.valid, false);
    assert.ok(
      output.errors.includes("reviewers[0].runnerId must be a non-empty string"),
      result.stdout
    );
    assert.ok(!("status" in output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate warns instead of failing when a manifest is merely incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-validate-warn-"));
  try {
    const manifest = validManifest();
    delete manifest.verification;
    const manifestPath = await writeManifest(root, manifest);
    const result = runCli(["validate", "--manifest", manifestPath]);
    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout);
    assert.equal(output.valid, true);
    assert.match(output.warnings.join("\n"), /validate does not evaluate the quality gate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate treats unreadable input as a process fault", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-validate-io-"));
  try {
    const missing = runCli(["validate", "--manifest", join(root, "absent.json")]);
    assert.equal(missing.status, 64);

    const brokenPath = join(root, "broken.json");
    await writeFile(brokenPath, "{ not json", "utf8");
    const broken = runCli(["validate", "--manifest", brokenPath]);
    assert.equal(broken.status, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate rejects --policy so it cannot be mistaken for a gate run", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-validate-policy-"));
  try {
    const manifestPath = await writeManifest(root, validManifest());
    const policyPath = join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({ minReviewers: 1 }), "utf8");
    const result = runCli(["validate", "--manifest", manifestPath, "--policy", policyPath]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /validate does not accept --policy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("help states that validate cannot replace gate", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /validate --manifest/);
  assert.match(result.stdout, /cannot replace `gate`/);
});
