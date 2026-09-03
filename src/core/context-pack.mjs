import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative, resolve } from "node:path";
import { buildChangesetJson, computeChangeset, renderChangesetMarkdown } from "./changeset.mjs";
import { toProtocolPath } from "./artifact-path-format.mjs";
import { CONTEXT_DIR, CONTEXT_FILES, contextArtifactPath } from "./context-vocabulary.mjs";
import { resolveDeterministicGitEnv } from "./git-env.mjs";
import { computeSuspiciousPatterns } from "./suspicious-patterns.mjs";

const execFileAsync = promisify(execFile);

// The frozen name of one instruction file. The digest is unconditional: making it
// conditional lets a file literally named like an already-digested product collide
// with the product of a different name. The input is the file's path relative to the
// project root, not its basename, so the same basename under two packages stays
// distinct and the same file written five different ways stays identical.
export function instructionArtifactName(projectRelativePath) {
  const nfc = String(projectRelativePath).normalize("NFC");
  const digest = createHash("sha256").update(Buffer.from(nfc, "utf8")).digest("hex").slice(0, 32);
  const stem = nfc
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, 80);
  return `${stem === "" ? "file" : stem}-${digest}`;
}

export async function buildContextPack(artifactRoot, options = {}) {
  if (!artifactRoot || typeof artifactRoot !== "string") {
    throw new Error("artifactRoot is required");
  }

  const generatedAt = options.generatedAt || new Date().toISOString();
  const contextRoot = join(artifactRoot, CONTEXT_DIR);
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
      CONTEXT_FILES.qualityPrinciplesJson,
      `${JSON.stringify(qualityPrinciples, null, 2)}\n`,
      files
    );
    await writeContextFile(
      contextRoot,
      CONTEXT_FILES.qualityPrinciplesMarkdown,
      renderQualityPrinciplesMarkdown(qualityPrinciples),
      files
    );
  }

  const copiedInstructions = [];
  const plannedInstructions = [];
  const claimedArtifacts = new Map();
  for (const instructionFile of instructionFiles) {
    if (!projectRoot || !projectRootRealpath) {
      throw new Error("projectRoot is required when instructionFiles are provided");
    }

    const source = await resolveProjectFile(projectRootRealpath, instructionFile, "instruction file");
    const projectRelativePath = toProtocolPath(relative(projectRootRealpath, source));
    // Computed once, here, and handed to every consumer below. Normalizing inside
    // writeContextFile could not reach this local, so on Windows the same artifact
    // would end up with one spelling in the file table and another in the brief.
    const artifact = toProtocolPath(join("instructions", instructionArtifactName(projectRelativePath)));

    const claimedBy = claimedArtifacts.get(artifact);
    if (claimedBy !== undefined && claimedBy !== projectRelativePath) {
      throw new Error(
        `instruction files ${claimedBy} and ${projectRelativePath} map to the same artifact ${artifact}`
      );
    }
    claimedArtifacts.set(artifact, projectRelativePath);
    plannedInstructions.push({ instructionFile, source, artifact });
  }

  for (const planned of plannedInstructions) {
    const content = await readFile(planned.source, "utf8");
    await writeContextFile(contextRoot, planned.artifact, content, files);
    copiedInstructions.push({
      path: planned.instructionFile,
      artifact: contextArtifactPath(planned.artifact),
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
    reviewType: options.reviewType === "full-project" ? "full-project" : "changeset",
    changeGoal: options.changeGoal || "",
    nonGoals: options.nonGoals || [],
    relatedRepos: options.relatedRepos || [],
    requiredChecks: options.requiredChecks || []
  };

  await writeContextFile(
    contextRoot,
    CONTEXT_FILES.projectContext,
    `${JSON.stringify(projectContext, null, 2)}\n`,
    files
  );

  let changeset = null;
  if (projectRootRealpath) {
    const changesetOptions = options.changeset || {};
    changeset = await computeChangeset({
      projectRoot: projectRootRealpath,
      base: changesetOptions.base,
      head: changesetOptions.head,
      maxPatchBytes: changesetOptions.maxPatchBytes,
      generatedAt
    });
    await writeContextFile(
      contextRoot,
      CONTEXT_FILES.changesetJson,
      `${JSON.stringify(buildChangesetJson(changeset), null, 2)}\n`,
      files
    );
    await writeContextFile(
      contextRoot,
      CONTEXT_FILES.changesetMarkdown,
      renderChangesetMarkdown(changeset),
      files
    );
  }

  let structureScan = null;
  const shouldScan = options.enableStructureScan || options.reviewType === "full-project";
  if (projectRootRealpath && shouldScan) {
    structureScan = await computeStructureScan(projectRootRealpath, {
      maxFiles: options.structureScanMaxFiles || 500,
      generatedAt
    });
    await writeContextFile(
      contextRoot,
      CONTEXT_FILES.structureScanJson,
      `${JSON.stringify(structureScan, null, 2)}\n`,
      files
    );
    await writeContextFile(
      contextRoot,
      CONTEXT_FILES.structureScanMarkdown,
      renderStructureScanMarkdown(structureScan),
      files
    );
  }

  const docsIndex = {
    schemaVersion: 1,
    docsRoots,
    designEntrypoints
  };
  await writeContextFile(
    contextRoot,
    CONTEXT_FILES.docsIndex,
    `${JSON.stringify(docsIndex, null, 2)}\n`,
    files
  );

  await writeContextFile(
    contextRoot,
    CONTEXT_FILES.projectBrief,
    renderProjectBrief({ projectContext, qualityPrinciples, changeset }),
    files
  );

  const contextManifest = {
    schemaVersion: 1,
    generatedAt,
    files
  };
  await writeContextFile(
    contextRoot,
    CONTEXT_FILES.contextManifest,
    `${JSON.stringify(contextManifest, null, 2)}\n`,
    files
  );

  // Hashed over the bytes on disk, not over the string that produced them, so the
  // digest a reviewer recomputes from the file is the digest recorded here.
  const contextManifestBytes = await readFile(join(contextRoot, CONTEXT_FILES.contextManifest));
  const contextManifestHash = sha256(contextManifestBytes);

  return {
    artifacts: {
      contextManifest: {
        artifact: contextArtifactPath(CONTEXT_FILES.contextManifest),
        sha256: contextManifestHash
      },
      qualityPrinciples: qualityPrinciples
        ? {
            artifact: contextArtifactPath(CONTEXT_FILES.qualityPrinciplesJson),
            sha256: files[CONTEXT_FILES.qualityPrinciplesJson].sha256
          }
        : null,
      projectContext: {
        artifact: contextArtifactPath(CONTEXT_FILES.projectContext),
        sha256: files[CONTEXT_FILES.projectContext].sha256
      },
      projectBrief: {
        artifact: contextArtifactPath(CONTEXT_FILES.projectBrief),
        sha256: files[CONTEXT_FILES.projectBrief].sha256
      },
      docsIndex: {
        artifact: contextArtifactPath(CONTEXT_FILES.docsIndex),
        sha256: files[CONTEXT_FILES.docsIndex].sha256
      },
      changeset: files[CONTEXT_FILES.changesetJson]
        ? {
            artifact: contextArtifactPath(CONTEXT_FILES.changesetJson),
            sha256: files[CONTEXT_FILES.changesetJson].sha256
          }
        : null,
      structureScan: files[CONTEXT_FILES.structureScanJson]
        ? {
            artifact: contextArtifactPath(CONTEXT_FILES.structureScanJson),
            sha256: files[CONTEXT_FILES.structureScanJson].sha256
          }
        : null
    },
    contextManifest,
    files,
    projectContext,
    qualityPrinciples,
    changeset,
    structureScan
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
  const target = join(contextRoot, artifact);
  const bytes = Buffer.from(content, "utf8");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const key = toProtocolPath(artifact);
  files[key] = {
    artifact: contextArtifactPath(key),
    sha256: sha256(bytes)
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

function renderProjectBrief({ projectContext, qualityPrinciples, changeset = null }) {
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
  lines.push("## Changeset", "");
  const changesetOnly = projectContext.reviewType !== "full-project";
  if (!changeset || !changeset.available) {
    lines.push(
      changeset?.reason
        ? `No changeset was frozen (${changeset.reason}).`
        : "No changeset was frozen."
    );
  } else {
    const shortBase = String(changeset.baseSha || "").slice(0, 12) || "unknown";
    const shortHead = String(changeset.headSha || "").slice(0, 12) || "unknown";
    lines.push(`- Base: ${changeset.base} (${shortBase})`);
    lines.push(`- Head: ${changeset.head} (${shortHead})`);
    lines.push(`- Files changed: ${changeset.fileCount}`);
    lines.push(`- Review scope: ${changesetOnly ? "changeset-only" : "full-project"}`);
    lines.push(
      changesetOnly
        ? "- Evaluate ONLY these files (see context/changeset.md for the full diff):"
        : "- The whole project is in scope. These files are recent changes only, listed as context (see context/changeset.md for the full diff):"
    );
    if (changeset.files.length === 0) {
      lines.push("  - (no files changed)");
    } else {
      for (const file of changeset.files) {
        lines.push(`  - ${file.status} ${file.path}`);
      }
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function computeStructureScan(projectRoot, options = {}) {
  const maxFiles = options.maxFiles || 500;
  const generatedAt = options.generatedAt || new Date().toISOString();

  let fileList = [];
  try {
    const { env } = resolveDeterministicGitEnv();
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: projectRoot, env, maxBuffer: 16 * 1024 * 1024 }
    );
    fileList = stdout.split("\n").filter(Boolean);
    const srcExts = new Set([".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs", ".py", ".go"]);
    fileList = fileList.filter((f) => {
      const dotIdx = f.lastIndexOf(".");
      return dotIdx >= 0 && srcExts.has(f.slice(dotIdx));
    });
  } catch {
    fileList = [];
  }

  fileList = fileList.slice(0, maxFiles);

  // One scanner, not two. The external grep path read JS regex sources as POSIX
  // ERE, kept its own shorter extension list, applied no directory exclusions while
  // scanning ".", and is absent on Windows — so the same field meant different
  // things depending on which path ran.
  const suspiciousPatterns = await computeSuspiciousPatterns(projectRoot, fileList);

  const fileCategories = {};
  for (const file of fileList) {
    const parts = file.split("/");
    const category = parts.length > 1 ? parts[0] : "root";
    if (!fileCategories[category]) fileCategories[category] = [];
    if (fileCategories[category].length < 50) fileCategories[category].push(file);
  }

  const symbolMap = await computeSymbolMap(projectRoot, fileList, { maxSymbols: 200 });

  return {
    schemaVersion: 1,
    generatedAt,
    totalFiles: fileList.length,
    truncated: fileList.length >= maxFiles,
    suspiciousPatterns,
    fileCategories,
    symbolMap,
    fileList: fileList.length <= 200 ? fileList : undefined
  };
}

async function computeSymbolMap(projectRoot, fileList, options = {}) {
  const maxSymbols = options.maxSymbols || 200;
  const importCounts = new Map();
  const fileSymbols = new Map();

  // JS/TS export patterns
  const JS_EXPORT_PATTERNS = [
    // export function name( or export async function name(
    { re: /^export\s+(?:async\s+)?function\s+(\w+)\s*\(/, kind: "function" },
    // export default function name(
    { re: /^export\s+default\s+(?:async\s+)?function\s+(\w+)\s*\(/, kind: "function" },
    // export class Name
    { re: /^export\s+(?:default\s+)?class\s+(\w+)/, kind: "class" },
    // export const/let/var name = (including arrow functions)
    { re: /^export\s+(?:const|let|var)\s+(\w+)\s*[=:]/, kind: "const" },
    // export interface/type/enum Name
    { re: /^export\s+(?:interface|type|enum)\s+(\w+)/, kind: "type" },
    // export { name1, name2 }
    { re: /^export\s+\{([^}]+)\}/, kind: "re-export" }
  ];

  // Python export patterns
  const PY_DEF_PATTERNS = [
    { re: /^(?:@\w+\s*\n)*(?:async\s+)?def\s+(\w+)\s*\(/, kind: "function" },
    { re: /^class\s+(\w+)[\s:(]/, kind: "class" }
  ];

  for (const file of fileList) {
    const dotIdx = file.lastIndexOf(".");
    const ext = dotIdx >= 0 ? file.slice(dotIdx) : "";
    const isPy = ext === ".py";
    const isGo = ext === ".go";
    if (isGo) continue; // Go needs different handling; skip for now

    let content;
    try {
      content = await readFile(join(projectRoot, file), "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const exports = [];
    const imports = [];

    if (isPy) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { re, kind } of PY_DEF_PATTERNS) {
          const m = re.exec(line.trimStart());
          if (m) {
            // check for docstring on next non-empty line
            let docstring = null;
            const nextLine = (lines[i + 1] || "").trim();
            if (nextLine.startsWith('"""') || nextLine.startsWith("'''")) {
              const q = nextLine.slice(0, 3);
              const rest = nextLine.slice(3);
              const endIdx = rest.indexOf(q);
              docstring = endIdx >= 0 ? rest.slice(0, endIdx) : rest;
            }
            if (!line.trimStart().startsWith("_")) {
              exports.push({ name: m[1], kind, docstring });
            }
            break;
          }
        }
        // Python imports
        const importLine = /^\s*(?:from\s+(\S+)\s+)?import\s+/.exec(line);
        if (importLine) {
          const mod = importLine[1] || (line.match(/import\s+(\S+)/)?.[1] ?? null);
          if (mod && !mod.startsWith(".")) imports.push(mod);
        }
      }
    } else {
      // JS/TS
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { re, kind } of JS_EXPORT_PATTERNS) {
          const m = re.exec(line);
          if (m) {
            if (kind === "re-export") {
              // extract individual names from { a, b, c }
              const names = m[1].split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
              for (const name of names) {
                if (name && name !== "default") exports.push({ name, kind: "re-export", docstring: null });
              }
            } else {
              // look for JSDoc comment above
              let docstring = null;
              if (i > 0) {
                const prev = lines[i - 1].trim();
                if (prev.endsWith("*/")) {
                  const start = lines.slice(Math.max(0, i - 8), i).join("\n").lastIndexOf("/**");
                  if (start >= 0) {
                    const block = lines.slice(Math.max(0, i - 8), i).join("\n").slice(start);
                    docstring = block.replace(/\/\*\*|\*\/|^\s*\*/gm, "").replace(/\s+/g, " ").trim().slice(0, 120);
                  }
                }
              }
              exports.push({ name: m[1], kind, docstring });
            }
            break;
          }
        }
        // JS/TS imports
        const importMatch = /^import\s+.*?\s+from\s+['"]([^'"]+)['"]/.exec(line)
          || /^(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
        if (importMatch) {
          imports.push(importMatch[1]);
          // track relative imports for importCounts ranking
          if (importMatch[1].startsWith(".")) {
            const resolved = join(dirname(file), importMatch[1]).replace(/\\/g, "/");
            importCounts.set(resolved, (importCounts.get(resolved) || 0) + 1);
          }
        }
      }
    }

    if (exports.length > 0 || imports.length > 0) {
      fileSymbols.set(file, { exports, imports: imports.slice(0, 20) });
    }
  }

  // rank files by how many times they are imported
  const ranked = [...fileSymbols.keys()].sort((a, b) => {
    const aKey = a.replace(/\.[^.]+$/, "");
    const bKey = b.replace(/\.[^.]+$/, "");
    return (importCounts.get(bKey) || 0) - (importCounts.get(aKey) || 0);
  });

  // build output, capping at maxSymbols total exports
  const result = {};
  let symbolCount = 0;
  for (const file of ranked) {
    if (symbolCount >= maxSymbols) break;
    const { exports, imports } = fileSymbols.get(file);
    const capped = exports.slice(0, maxSymbols - symbolCount);
    result[file] = { exports: capped, imports };
    symbolCount += capped.length;
  }

  return result;
}

export function renderStructureScanMarkdown(scan) {
  const lines = ["# KualityForge Structure Scan", ""];

  if (!scan) {
    lines.push("No structure scan was generated.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Summary", "");
  lines.push(`- Total source files scanned: ${scan.totalFiles}`);
  if (scan.truncated) {
    lines.push(`- (truncated at ${scan.totalFiles} files)`);
  }
  lines.push("");

  lines.push("## Suspicious Patterns", "");
  if (scan.suspiciousPatterns.length === 0) {
    lines.push("No suspicious patterns detected.");
  } else {
    for (const pattern of scan.suspiciousPatterns) {
      lines.push(`### ${pattern.pattern} (${pattern.totalOccurrences} occurrences)`, "");
      for (const file of pattern.files) {
        const note = file.expectedSelfHit
          ? " — expected self-hit: this is the detector's own pattern table, not a finding"
          : "";
        lines.push(`- ${file.path} (${file.count}x)${note}`);
      }
      if (pattern.filesTruncated) {
        lines.push(`- ... and more files`);
      }
      lines.push("");
    }
  }

  lines.push("## File Categories", "");
  for (const [category, files] of Object.entries(scan.fileCategories)) {
    lines.push(`### ${category}/ (${files.length} shown)`, "");
    for (const file of files) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  if (scan.symbolMap && Object.keys(scan.symbolMap).length > 0) {
    lines.push("## Symbol Map", "");
    lines.push("Top exported symbols ranked by import frequency:", "");
    for (const [file, { exports: syms, imports }] of Object.entries(scan.symbolMap)) {
      if (syms.length === 0) continue;
      lines.push(`### ${file}`, "");
      for (const sym of syms) {
        const doc = sym.docstring ? ` — ${sym.docstring.slice(0, 80)}` : "";
        lines.push(`- \`${sym.name}\` (${sym.kind})${doc}`);
      }
      if (imports.length > 0) {
        lines.push(`  imports: ${imports.slice(0, 5).join(", ")}${imports.length > 5 ? ", ..." : ""}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
