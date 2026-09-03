import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Every pattern carries `g`. Without it String.prototype.match returns a
// single-match array, so the per-file count would be a constant 1 and
// totalOccurrences would silently mean "files hit" rather than what it says.
export const SUSPICIOUS_PATTERNS = Object.freeze([
  { label: "eval()", regex: /eval\s*\(/g },
  { label: "innerHTML", regex: /innerHTML/g },
  { label: "dangerouslySetInnerHTML", regex: /dangerouslySetInnerHTML/g },
  { label: "document.write", regex: /document\.write/g },
  { label: "TODO", regex: /TODO/g },
  { label: "FIXME", regex: /FIXME/g },
  { label: "HACK", regex: /HACK/g },
  { label: "console.log", regex: /console\.log/g },
  { label: "any type", regex: /:\s*any\b/g },
  { label: "ts-ignore", regex: /\/\/\s*@ts-ignore/g },
  { label: "ts-nocheck", regex: /\/\/\s*@ts-nocheck/g }
]);

const MAX_FILES_PER_PATTERN = 20;

// Derived rather than written as a literal: a hardcoded path would keep pointing at
// a module that had been renamed, the marker would quietly disappear, and no test
// would go red — the scan would just start reporting its own table as a finding
// again.
export function detectorModulePath(projectRoot) {
  return toPosixPath(relative(projectRoot, fileURLToPath(import.meta.url)));
}

// git ls-files emits POSIX separators regardless of platform, and the scan compares
// its paths against that output.
function toPosixPath(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}

// The detector's own pattern table is marked, not excluded: excluding it would make
// the scan blind to a real suspicious call added to this file.
export async function computeSuspiciousPatterns(projectRoot, fileList) {
  const detectorPath = detectorModulePath(projectRoot);
  const results = [];

  for (const pattern of SUSPICIOUS_PATTERNS) {
    const fileMap = new Map();
    for (const file of fileList) {
      let content;
      try {
        content = await readFile(join(projectRoot, file), "utf8");
      } catch {
        continue;
      }
      // A global regex is reused across files; String.prototype.match resets
      // lastIndex itself, so the shared table stays safe to iterate.
      const matches = content.match(pattern.regex);
      if (matches && matches.length > 0) {
        fileMap.set(file, matches.length);
      }
    }

    if (fileMap.size === 0) {
      continue;
    }

    const files = [...fileMap.entries()]
      .map(([path, count]) => {
        const entry = { path, count };
        if (path === detectorPath) {
          entry.expectedSelfHit = true;
        }
        return entry;
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_FILES_PER_PATTERN);

    results.push({
      pattern: pattern.label,
      totalOccurrences: [...fileMap.values()].reduce((sum, count) => sum + count, 0),
      // Stated as a fact about the list rather than inferred from the occurrence
      // total: with occurrence counting one busy file can outnumber the entries
      // while nothing was cut.
      filesTruncated: fileMap.size > MAX_FILES_PER_PATTERN,
      files
    });
  }

  return results;
}
