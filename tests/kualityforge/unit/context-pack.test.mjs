import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildContextPack } from "../../../src/core/context-pack.mjs";

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
