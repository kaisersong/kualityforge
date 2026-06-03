import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildContextPack } from "../../../src/core/context-pack.mjs";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir) {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

test("buildContextPack freezes quality principles and project context artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-context-"));
  const projectRoot = join(root, "project");
  const docsRoot = join(root, "docs");
  const artifactRoot = join(root, "artifacts");
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(docsRoot, { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "# Agent rules\n", "utf8");
    await writeFile(join(projectRoot, "README.md"), "# Project\n", "utf8");
    await writeFile(join(docsRoot, "README.md"), "# Docs\n", "utf8");
    const principlesPath = join(root, "quality-principles.json");
    await writeFile(
      principlesPath,
      `${JSON.stringify({
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
      })}\n`,
      "utf8"
    );

    const context = await buildContextPack(artifactRoot, {
      projectRoot,
      docsRoots: [docsRoot],
      qualityPrinciplesPath: principlesPath,
      changeGoal: "Ship the context-aware gate.",
      instructionFiles: ["AGENTS.md", "README.md"],
      designEntrypoints: ["README.md"],
      requiredChecks: ["npm test"]
    });

    assert.equal(context.projectContext.changeGoal, "Ship the context-aware gate.");
    assert.equal(context.qualityPrinciples.required, true);
    assert.match(context.contextManifest.files["quality-principles.json"].sha256, /^[a-f0-9]{64}$/);

    const projectBrief = await readFile(join(artifactRoot, "context", "project-brief.md"), "utf8");
    assert.match(projectBrief, /Ship the context-aware gate/);
    assert.match(projectBrief, /User Quality Principles/);

    const copiedAgents = await readFile(
      join(artifactRoot, "context", "instructions", "AGENTS.md"),
      "utf8"
    );
    assert.equal(copiedAgents, "# Agent rules\n");

    const docsIndex = JSON.parse(await readFile(join(artifactRoot, "context", "docs-index.json"), "utf8"));
    assert.equal(docsIndex.docsRoots.length, 1);
    assert.equal(docsIndex.designEntrypoints[0], "README.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildContextPack rejects instruction path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-context-escape-"));
  const projectRoot = join(root, "project");
  const artifactRoot = join(root, "artifacts");
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(root, "secret.md"), "secret\n", "utf8");

    await assert.rejects(
      () =>
        buildContextPack(artifactRoot, {
          projectRoot,
          instructionFiles: ["../secret.md"]
        }),
      /instruction file path must stay within project root/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildContextPack freezes the git changeset for all reviewers", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-context-changeset-"));
  const projectRoot = join(root, "project");
  const artifactRoot = join(root, "artifacts");
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await initGitRepo(projectRoot);
    await writeFile(join(projectRoot, "keep.txt"), "line1\nline2\n", "utf8");
    await execFileAsync("git", ["add", "keep.txt"], { cwd: projectRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: projectRoot });
    await writeFile(join(projectRoot, "keep.txt"), "line1\nchanged\n", "utf8");

    const context = await buildContextPack(artifactRoot, {
      projectRoot,
      changeGoal: "Freeze the changeset."
    });

    const changesetJson = JSON.parse(
      await readFile(join(artifactRoot, "context", "changeset.json"), "utf8")
    );
    assert.equal(changesetJson.available, true);
    assert.ok(changesetJson.files.some((file) => file.path === "keep.txt"));

    const changesetMd = await readFile(join(artifactRoot, "context", "changeset.md"), "utf8");
    assert.match(changesetMd, /Frozen Changeset/);

    const projectBrief = await readFile(join(artifactRoot, "context", "project-brief.md"), "utf8");
    assert.match(projectBrief, /## Changeset/);
    assert.match(projectBrief, /keep\.txt/);

    assert.match(context.changeset.available ? "available" : "x", /available/);
    assert.match(
      context.contextManifest.files["changeset.json"].sha256,
      /^[a-f0-9]{64}$/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildContextPack degrades gracefully when project is not a git repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-context-nogit-"));
  const projectRoot = join(root, "project");
  const artifactRoot = join(root, "artifacts");
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(projectRoot, "file.txt"), "content\n", "utf8");

    const context = await buildContextPack(artifactRoot, {
      projectRoot,
      changeGoal: "No git here."
    });

    const changesetJson = JSON.parse(
      await readFile(join(artifactRoot, "context", "changeset.json"), "utf8")
    );
    assert.equal(changesetJson.available, false);
    assert.ok(typeof changesetJson.reason === "string" && changesetJson.reason.length > 0);

    const projectBrief = await readFile(join(artifactRoot, "context", "project-brief.md"), "utf8");
    assert.match(projectBrief, /No changeset was frozen/);
    assert.equal(context.changeset.available, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
