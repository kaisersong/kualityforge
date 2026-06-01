import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = resolve("src/cli/index.mjs");

test("init creates an artifact root with a manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-init-"));
  try {
    const result = runCli([
      "init",
      "--artifact-root",
      root,
      "--run-id",
      "release-cli-1",
      "--profile",
      "release"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "initialized");
    assert.equal(output.manifestPath, join(root, "manifest.json"));

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.runId, "release-cli-1");
    assert.equal(manifest.status, "open");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate can read manifest from artifact root", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-gate-"));
  try {
    const init = runCli([
      "init",
      "--artifact-root",
      root,
      "--run-id",
      "release-cli-2",
      "--profile",
      "release"
    ]);
    assert.equal(init.status, 0, init.stderr);

    const gate = runCli(["gate", "--artifact-root", root]);

    assert.equal(gate.status, 2, gate.stderr);
    const output = JSON.parse(gate.stdout);
    assert.equal(output.status, "incomplete");
    assert.match(output.reasons.join("\n"), /reviewer shortage/);
    assert.match(output.reasons.join("\n"), /human decision artifact is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init can freeze project context and user quality principles", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-cli-context-"));
  const projectRoot = join(root, "project");
  const docsRoot = join(root, "docs");
  const artifactRoot = join(root, "artifacts");
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(docsRoot, { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "# Rules\n", "utf8");
    const principlesPath = join(root, "quality-principles.json");
    await writeFile(
      principlesPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          scope: "user",
          required: true,
          principles: [
            {
              id: "independent-verification",
              priority: "must",
              statement: "Verifier must be independent.",
              appliesTo: ["release"],
              failureMode: "self verification cannot pass release",
              evidenceRequired: ["runner_identity"]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const result = runCli([
      "init",
      "--artifact-root",
      artifactRoot,
      "--run-id",
      "release-cli-context",
      "--project-root",
      projectRoot,
      "--docs-root",
      docsRoot,
      "--quality-principles",
      principlesPath,
      "--change-goal",
      "Review with frozen context",
      "--instruction",
      "AGENTS.md"
    ]);

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(artifactRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.context.qualityPrinciples.artifact, "context/quality-principles.json");
    assert.equal(manifest.context.projectBrief.artifact, "context/project-brief.md");
    assert.match(await readFile(join(artifactRoot, "context", "project-brief.md"), "utf8"), /Review with frozen context/);
    assert.equal(
      await readFile(join(artifactRoot, "context", "instructions", "AGENTS.md"), "utf8"),
      "# Rules\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}
