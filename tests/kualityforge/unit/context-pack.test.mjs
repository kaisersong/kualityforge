import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildContextPack, instructionArtifactName } from "../../../src/core/context-pack.mjs";
import { toProtocolPath } from "../../../src/core/artifact-path-format.mjs";
import { CONTEXT_FILES } from "../../../src/core/context-vocabulary.mjs";
import { applyDeterministicGitEnv } from "../helpers/git-env.mjs";

await applyDeterministicGitEnv();

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
      join(artifactRoot, "context", "instructions", instructionArtifactName("AGENTS.md")),
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

async function buildMinimalPack(prefix, options = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectRoot = join(root, "project");
  const artifactRoot = join(root, "artifacts");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(join(projectRoot, "AGENTS.md"), "# Agent rules\n", "utf8");

  const context = await buildContextPack(artifactRoot, {
    projectRoot,
    changeGoal: "Normalize every artifact path.",
    instructionFiles: ["AGENTS.md"],
    ...options
  });

  return { root, artifactRoot, context };
}

// The literals are spelled with forward slashes on purpose. `path.join` yields
// backslashes on Windows, so a value that skipped normalization would fail here
// rather than producing an artifact root that cannot be replayed on another
// platform.
test("the instruction artifact is the same protocol path everywhere it is consumed", async () => {
  const { root, artifactRoot, context } = await buildMinimalPack("kualityforge-context-paths-");
  try {
    // Produced, not hand-written: a literal key here would keep passing after the
    // naming rule changed underneath it.
    const key = `instructions/${instructionArtifactName("AGENTS.md")}`;
    const reference = `context/${key}`;

    const onDisk = await readFile(join(artifactRoot, "context", ...key.split("/")), "utf8");
    assert.equal(onDisk, "# Agent rules\n");

    assert.ok(context.contextManifest.files[key], Object.keys(context.contextManifest.files).join(","));
    assert.equal(context.contextManifest.files[key].artifact, reference);
    assert.equal(context.projectContext.instructionFiles[0].artifact, reference);

    const projectBrief = await readFile(join(artifactRoot, "context", "project-brief.md"), "utf8");
    assert.ok(
      projectBrief.includes(`-> ${reference}`),
      "the project brief must reference the same protocol path"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Callers that need to know which context files exist previously had to guess from
// the artifacts map; handing the table back keeps that derivation from forking.
test("buildContextPack returns the frozen file table", async () => {
  const { root, context } = await buildMinimalPack("kualityforge-context-files-");
  try {
    assert.deepEqual(context.files, context.contextManifest.files);
    assert.ok(context.files[CONTEXT_FILES.projectBrief]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Asserting the invariant rather than a literal is deliberate: on POSIX a value
// that skipped normalization still looks correct, so the only check that carries
// meaning on every platform is that the value is already its own protocol form.
test("every frozen artifact reference is already in protocol form", async () => {
  const { root, context } = await buildMinimalPack("kualityforge-context-protocol-", {
    enableStructureScan: true
  });
  try {
    for (const [name, entry] of Object.entries(context.files)) {
      assert.equal(toProtocolPath(name), name, `file table key: ${name}`);
      assert.equal(toProtocolPath(entry.artifact), entry.artifact, `artifact: ${entry.artifact}`);
    }
    for (const instruction of context.projectContext.instructionFiles) {
      assert.equal(toProtocolPath(instruction.artifact), instruction.artifact, instruction.artifact);
    }
    for (const reference of Object.values(context.artifacts)) {
      if (reference) {
        assert.equal(toProtocolPath(reference.artifact), reference.artifact, reference.artifact);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every frozen context file name comes from the canonical vocabulary", async () => {
  const { root, context } = await buildMinimalPack("kualityforge-context-names-", {
    enableStructureScan: true
  });
  try {
    const canonical = new Set(Object.values(CONTEXT_FILES));
    const unexpected = Object.keys(context.files).filter(
      (name) => !canonical.has(name) && !name.startsWith("instructions/")
    );

    assert.deepEqual(unexpected, []);
    for (const reference of Object.values(context.artifacts)) {
      if (reference) {
        assert.match(reference.artifact, /^context\//);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the context manifest hash covers the bytes written to disk", async () => {
  const { root, artifactRoot, context } = await buildMinimalPack("kualityforge-context-hash-");
  try {
    const bytes = await readFile(join(artifactRoot, "context", "context-manifest.json"));
    const expected = createHash("sha256").update(bytes).digest("hex");

    assert.equal(context.artifacts.contextManifest.sha256, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one generation time makes repeated context freezes provenance-stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-context-stable-"));
  const projectRoot = join(root, "project");
  const firstArtifactRoot = join(root, "artifacts-first");
  const secondArtifactRoot = join(root, "artifacts-second");
  const generatedAt = "2026-06-03T00:00:00.000Z";
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(firstArtifactRoot, { recursive: true });
    await mkdir(secondArtifactRoot, { recursive: true });
    await initGitRepo(projectRoot);
    await writeFile(join(projectRoot, "keep.js"), "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["add", "keep.js"], { cwd: projectRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: projectRoot });
    await writeFile(join(projectRoot, "keep.js"), "export const value = 2;\n", "utf8");

    const options = { projectRoot, generatedAt, enableStructureScan: true };
    const first = await buildContextPack(firstArtifactRoot, options);
    const second = await buildContextPack(secondArtifactRoot, options);

    assert.equal(first.contextManifest.generatedAt, generatedAt);
    assert.equal(first.changeset.generatedAt, generatedAt);
    assert.equal(first.structureScan.generatedAt, generatedAt);
    assert.equal(first.artifacts.contextManifest.sha256, second.artifacts.contextManifest.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function buildBriefWithChangeset(prefix, options) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectRoot = join(root, "project");
  const artifactRoot = join(root, "artifacts");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await initGitRepo(projectRoot);
  await writeFile(join(projectRoot, "keep.txt"), "line1\n", "utf8");
  await execFileAsync("git", ["add", "keep.txt"], { cwd: projectRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: projectRoot });
  await writeFile(join(projectRoot, "keep.txt"), "line1\nchanged\n", "utf8");

  const context = await buildContextPack(artifactRoot, {
    projectRoot,
    changeGoal: "Scope the review.",
    ...options
  });
  const brief = await readFile(join(artifactRoot, "context", "project-brief.md"), "utf8");
  return { root, context, brief };
}

// The scope token is what gets asserted, not the sentence around it: rewording the
// guidance must stay green, while dropping the mode distinction must go red. The
// brief matters because a reviewer reads it even when the prompt says otherwise.
test("the frozen project brief scopes the review to the changeset by default", async () => {
  const { root, context, brief } = await buildBriefWithChangeset("kualityforge-brief-changeset-", {});
  try {
    assert.equal(context.changeset.available, true);
    assert.match(brief, /^- Review scope: changeset-only$/m);
    assert.doesNotMatch(brief, /^- Review scope: full-project$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the frozen project brief widens the review scope for full-project runs", async () => {
  const { root, context, brief } = await buildBriefWithChangeset("kualityforge-brief-full-", {
    reviewType: "full-project"
  });
  try {
    assert.equal(context.changeset.available, true);
    assert.match(brief, /^- Review scope: full-project$/m);
    assert.doesNotMatch(brief, /^- Review scope: changeset-only$/m);
    assert.doesNotMatch(brief, /Evaluate ONLY/);
    assert.match(brief, /keep\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The digest is appended even to names that need no rewriting. A conditional
// digest would let a file literally named like a digest impersonate another
// name's product, which is the hole the suffix exists to close.
test("instructionArtifactName always appends a 128-bit digest", () => {
  const name = instructionArtifactName("AGENTS.md");
  assert.match(name, /^AGENTS\.md-[a-f0-9]{32}$/);
  assert.notEqual(instructionArtifactName(name), name);
});

test("instructionArtifactName keys the file by path, not by basename", () => {
  assert.notEqual(
    instructionArtifactName("docs/AGENTS.md"),
    instructionArtifactName("src/AGENTS.md")
  );
  assert.equal(
    instructionArtifactName("docs/AGENTS.md"),
    instructionArtifactName("docs/AGENTS.md".normalize("NFD"))
  );
});

test("instructionArtifactName folds unicode normalization forms together", () => {
  assert.equal(
    instructionArtifactName("caf\u00e9.md"),
    instructionArtifactName("cafe\u0301.md")
  );
});

// The monorepo case: the same instruction basename under two packages is a
// legitimate input, and the previous naming rule froze only the second one.
test("two instruction files sharing a basename are both frozen", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-context-monorepo-"));
  const projectRoot = join(root, "project");
  const artifactRoot = join(root, "artifacts");
  try {
    await mkdir(join(projectRoot, "services", "a"), { recursive: true });
    await mkdir(join(projectRoot, "packages", "b"), { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(projectRoot, "services", "a", "AGENTS.md"), "service a\n", "utf8");
    await writeFile(join(projectRoot, "packages", "b", "AGENTS.md"), "package b\n", "utf8");

    const context = await buildContextPack(artifactRoot, {
      projectRoot,
      changeGoal: "Freeze both instruction files.",
      instructionFiles: ["services/a/AGENTS.md", "packages/b/AGENTS.md"]
    });

    const keys = Object.keys(context.files).filter((name) => name.startsWith("instructions/"));
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 2);

    const contents = [];
    for (const instruction of context.projectContext.instructionFiles) {
      contents.push(await readFile(join(artifactRoot, ...instruction.artifact.split("/")), "utf8"));
    }
    assert.deepEqual(contents.sort(), ["package b\n", "service a\n"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Every spelling of one physical file must freeze to one key, or the same repo
// produces different manifests on a machine that passes absolute paths.
test("different spellings of one instruction file freeze to one key", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-context-spelling-"));
  const projectRoot = join(root, "project");
  try {
    await mkdir(join(projectRoot, "docs"), { recursive: true });
    await writeFile(join(projectRoot, "docs", "AGENTS.md"), "rules\n", "utf8");

    // Absolute paths are not in this list: they are rejected outright by the
    // containment check, so they cannot produce a divergent key in the first place.
    const spellings = [join("docs", "AGENTS.md"), "./docs/AGENTS.md", "docs//AGENTS.md"];

    const keys = new Set();
    for (const [index, spelling] of spellings.entries()) {
      const artifactRoot = join(root, `artifacts-${index}`);
      await mkdir(artifactRoot, { recursive: true });
      const context = await buildContextPack(artifactRoot, {
        projectRoot,
        changeGoal: "One file, many spellings.",
        instructionFiles: [spelling]
      });
      keys.add(Object.keys(context.files).find((name) => name.startsWith("instructions/")));
    }

    assert.equal(keys.size, 1, [...keys].join(" | "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
