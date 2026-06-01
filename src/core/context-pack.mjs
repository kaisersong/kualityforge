import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

export async function buildContextPack(artifactRoot, options = {}) {
  if (!artifactRoot || typeof artifactRoot !== "string") {
    throw new Error("artifactRoot is required");
  }

  const contextRoot = join(artifactRoot, "context");
  const instructionsRoot = join(contextRoot, "instructions");
  await mkdir(instructionsRoot, { recursive: true });

  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : null;
  const projectRootRealpath = projectRoot ? await realpath(projectRoot) : null;
  const docsRoots = await resolveDocsRoots(options.docsRoots || []);
  const instructionFiles = options.instructionFiles || [];
  const designEntrypoints = options.designEntrypoints || [];

  let qualityPrinciples = null;
  const files = {};

  if (options.qualityPrinciplesPath) {
    const qualityPrinciplesContent = await readFile(options.qualityPrinciplesPath, "utf8");
    qualityPrinciples = JSON.parse(qualityPrinciplesContent);
    await writeContextFile(
      contextRoot,
      "quality-principles.json",
      `${JSON.stringify(qualityPrinciples, null, 2)}\n`,
      files
    );
    await writeContextFile(
      contextRoot,
      "quality-principles.md",
      renderQualityPrinciplesMarkdown(qualityPrinciples),
      files
    );
  }

  const copiedInstructions = [];
  for (const instructionFile of instructionFiles) {
    if (!projectRoot || !projectRootRealpath) {
      throw new Error("projectRoot is required when instructionFiles are provided");
    }

    const source = await resolveProjectFile(projectRootRealpath, instructionFile, "instruction file");
    const content = await readFile(source, "utf8");
    const artifact = join("instructions", basename(instructionFile));
    await writeContextFile(contextRoot, artifact, content, files);
    copiedInstructions.push({
      path: instructionFile,
      artifact: join("context", artifact),
      required: true
    });
  }

  const projectContext = {
    schemaVersion: 1,
    projectRoot,
    projectRootRealpath,
    docsRoots,
    instructionFiles: copiedInstructions,
    designEntrypoints,
    changeGoal: options.changeGoal || "",
    nonGoals: options.nonGoals || [],
    relatedRepos: options.relatedRepos || [],
    requiredChecks: options.requiredChecks || []
  };

  await writeContextFile(
    contextRoot,
    "project-context.json",
    `${JSON.stringify(projectContext, null, 2)}\n`,
    files
  );

  const docsIndex = {
    schemaVersion: 1,
    docsRoots,
    designEntrypoints
  };
  await writeContextFile(
    contextRoot,
    "docs-index.json",
    `${JSON.stringify(docsIndex, null, 2)}\n`,
    files
  );

  await writeContextFile(
    contextRoot,
    "project-brief.md",
    renderProjectBrief({ projectContext, qualityPrinciples }),
    files
  );

  const contextManifest = {
    schemaVersion: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    files
  };
  await writeContextFile(
    contextRoot,
    "context-manifest.json",
    `${JSON.stringify(contextManifest, null, 2)}\n`,
    files
  );

  const contextManifestContent = await readFile(join(contextRoot, "context-manifest.json"), "utf8");
  const contextManifestHash = sha256(contextManifestContent);

  return {
    artifacts: {
      contextManifest: {
        artifact: "context/context-manifest.json",
        sha256: contextManifestHash
      },
      qualityPrinciples: qualityPrinciples
        ? {
            artifact: "context/quality-principles.json",
            sha256: files["quality-principles.json"].sha256
          }
        : null,
      projectContext: {
        artifact: "context/project-context.json",
        sha256: files["project-context.json"].sha256
      },
      projectBrief: {
        artifact: "context/project-brief.md",
        sha256: files["project-brief.md"].sha256
      },
      docsIndex: {
        artifact: "context/docs-index.json",
        sha256: files["docs-index.json"].sha256
      }
    },
    contextManifest,
    projectContext,
    qualityPrinciples
  };
}

async function resolveDocsRoots(docsRoots) {
  const resolved = [];
  for (const docsRoot of docsRoots) {
    const rawPath = resolve(docsRoot);
    const real = await realpath(rawPath);
    const info = await stat(real);
    if (!info.isDirectory()) {
      throw new Error("docs root must be a directory");
    }
    resolved.push({ path: rawPath, realpath: real });
  }
  return resolved;
}

async function resolveProjectFile(projectRootRealpath, filePath, label) {
  if (!isSafeRelativePath(filePath)) {
    throw new Error(`${label} path must stay within project root`);
  }

  const source = resolve(projectRootRealpath, filePath);
  const sourceRealpath = await realpath(source);
  if (!isWithinRoot(projectRootRealpath, sourceRealpath)) {
    throw new Error(`${label} path must stay within project root`);
  }

  const info = await stat(sourceRealpath);
  if (!info.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }

  return sourceRealpath;
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.split(/[\\/]+/).includes("..")
  );
}

function isWithinRoot(root, value) {
  const rel = relative(root, value);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !resolve(rel).startsWith("//"));
}

async function writeContextFile(contextRoot, artifact, content, files) {
  await mkdir(dirname(join(contextRoot, artifact)), { recursive: true });
  await writeFile(join(contextRoot, artifact), content, "utf8");
  files[artifact] = {
    artifact: join("context", artifact),
    sha256: sha256(content)
  };
}

function renderQualityPrinciplesMarkdown(qualityPrinciples) {
  const lines = ["# User Quality Principles", ""];
  for (const principle of qualityPrinciples.principles || []) {
    lines.push(`## ${principle.id}`);
    lines.push("");
    lines.push(principle.statement || "");
    lines.push("");
    lines.push(`Priority: ${principle.priority || "unspecified"}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderProjectBrief({ projectContext, qualityPrinciples }) {
  const lines = ["# KualityForge Project Brief", ""];
  lines.push("## Change Goal", "");
  lines.push(projectContext.changeGoal || "No change goal was provided.");
  lines.push("");
  lines.push("## User Quality Principles", "");
  if (!qualityPrinciples?.principles?.length) {
    lines.push("No user quality principles were provided.");
  } else {
    for (const principle of qualityPrinciples.principles) {
      lines.push(`- ${principle.id}: ${principle.statement || ""}`);
    }
  }
  lines.push("");
  lines.push("## Instruction Files", "");
  if (projectContext.instructionFiles.length === 0) {
    lines.push("No instruction files were frozen.");
  } else {
    for (const instruction of projectContext.instructionFiles) {
      lines.push(`- ${instruction.path} -> ${instruction.artifact}`);
    }
  }
  lines.push("");
  lines.push("## Docs Roots", "");
  if (projectContext.docsRoots.length === 0) {
    lines.push("No docs roots were provided.");
  } else {
    for (const docsRoot of projectContext.docsRoots) {
      lines.push(`- ${docsRoot.path} (${docsRoot.realpath})`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
