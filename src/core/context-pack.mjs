import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join, relative, resolve } from "node:path";
import { buildChangesetJson, computeChangeset, renderChangesetMarkdown } from "./changeset.mjs";

const execFileAsync = promisify(execFile);

const SUSPICIOUS_PATTERNS = [
  { label: "eval()", regex: /eval\s*\(/ },
  { label: "innerHTML", regex: /innerHTML/ },
  { label: "dangerouslySetInnerHTML", regex: /dangerouslySetInnerHTML/ },
  { label: "document.write", regex: /document\.write/ },
  { label: "TODO", regex: /TODO/ },
  { label: "FIXME", regex: /FIXME/ },
  { label: "HACK", regex: /HACK/ },
  { label: "console.log", regex: /console\.log/ },
  { label: "any type", regex: /:\s*any\b/ },
  { label: "ts-ignore", regex: /\/\/\s*@ts-ignore/ },
  { label: "ts-nocheck", regex: /\/\/\s*@ts-nocheck/ }
];

const DEFAULT_SCAN_INCLUDE = ["**/*.ts", "**/*.js", "**/*.tsx", "**/*.jsx", "**/*.mjs", "**/*.cjs"];
const DEFAULT_SCAN_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/coverage/**", "**/*.min.*"];

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

  let changeset = null;
  if (projectRootRealpath) {
    const changesetOptions = options.changeset || {};
    changeset = await computeChangeset({
      projectRoot: projectRootRealpath,
      base: changesetOptions.base,
      head: changesetOptions.head,
      maxPatchBytes: changesetOptions.maxPatchBytes
    });
    await writeContextFile(
      contextRoot,
      "changeset.json",
      `${JSON.stringify(buildChangesetJson(changeset), null, 2)}\n`,
      files
    );
    await writeContextFile(contextRoot, "changeset.md", renderChangesetMarkdown(changeset), files);
  }

  let structureScan = null;
  const shouldScan = options.enableStructureScan || options.reviewType === "full-project";
  if (projectRootRealpath && shouldScan) {
    structureScan = await computeStructureScan(projectRootRealpath, {
      includePatterns: options.structureScanPatterns || DEFAULT_SCAN_INCLUDE,
      excludePatterns: options.structureScanExclude || DEFAULT_SCAN_EXCLUDE,
      maxFiles: options.structureScanMaxFiles || 500
    });
    await writeContextFile(
      contextRoot,
      "structure-scan.json",
      `${JSON.stringify(structureScan, null, 2)}\n`,
      files
    );
    await writeContextFile(contextRoot, "structure-scan.md", renderStructureScanMarkdown(structureScan), files);
  }

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
    renderProjectBrief({ projectContext, qualityPrinciples, changeset }),
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
      },
      changeset: files["changeset.json"]
        ? {
            artifact: "context/changeset.json",
            sha256: files["changeset.json"].sha256
          }
        : null,
      structureScan: files["structure-scan.json"]
        ? {
            artifact: "context/structure-scan.json",
            sha256: files["structure-scan.json"].sha256
          }
        : null
    },
    contextManifest,
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
    lines.push("- Evaluate ONLY these files (see context/changeset.md for the full diff):");
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

  let fileList = [];
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: projectRoot,
      maxBuffer: 16 * 1024 * 1024
    });
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

  const suspiciousPatterns = [];
  let useGrep = true;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (!useGrep) break;
    try {
      const { stdout } = await execFileAsync(
        "grep",
        ["-rn", "--include=*.ts", "--include=*.js", "--include=*.tsx", "--include=*.jsx", "--include=*.mjs", "--include=*.cjs", "-E", pattern.regex.source, "."],
        { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 }
      );
      const matches = stdout.split("\n").filter(Boolean);
      const fileMap = new Map();
      for (const line of matches) {
        const colonIdx = line.indexOf(":");
        if (colonIdx < 0) continue;
        const filePath = line.slice(0, colonIdx);
        fileMap.set(filePath, (fileMap.get(filePath) || 0) + 1);
      }
      if (fileMap.size > 0) {
        const files = [...fileMap.entries()]
          .map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);
        const total = [...fileMap.values()].reduce((s, c) => s + c, 0);
        suspiciousPatterns.push({ pattern: pattern.label, totalOccurrences: total, files });
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        useGrep = false;
        break;
      }
      // grep exits non-zero when no matches — that's fine
    }
  }

  if (!useGrep) {
    const scanResult = await computeSuspiciousPatternsNode(projectRoot, fileList, SUSPICIOUS_PATTERNS);
    suspiciousPatterns.push(...scanResult);
  }

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
    generatedAt: new Date().toISOString(),
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

async function computeSuspiciousPatternsNode(projectRoot, fileList, patterns) {
  const results = [];
  for (const pattern of patterns) {
    const fileMap = new Map();
    for (const file of fileList) {
      try {
        const content = await readFile(join(projectRoot, file), "utf8");
        const matches = content.match(pattern.regex);
        if (matches && matches.length > 0) {
          fileMap.set(file, matches.length);
        }
      } catch {
        // skip unreadable files
      }
    }
    if (fileMap.size > 0) {
      const files = [...fileMap.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
      const total = [...fileMap.values()].reduce((s, c) => s + c, 0);
      results.push({ pattern: pattern.label, totalOccurrences: total, files });
    }
  }
  return results;
}

function renderStructureScanMarkdown(scan) {
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
        lines.push(`- ${file.path} (${file.count}x)`);
      }
      if (pattern.files.length < pattern.totalOccurrences) {
        lines.push(`- ... and more`);
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
