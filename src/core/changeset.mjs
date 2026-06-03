import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_PATCH_BYTES = 1_048_576;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// Computes and freezes a single git changeset so every reviewer judges the
// identical file set. A working-tree head ("WORKTREE") is only deterministic
// for a fixed tree state; it is frozen once at init and all reviewers consume
// the frozen copy. Pass an explicit head sha for full determinism.
export async function computeChangeset({
  projectRoot,
  base = "HEAD",
  head = "WORKTREE",
  maxPatchBytes = DEFAULT_MAX_PATCH_BYTES
} = {}) {
  const generatedAt = new Date().toISOString();

  if (!projectRoot || typeof projectRoot !== "string") {
    return unavailable({ base, head, generatedAt, reason: "projectRoot is required" });
  }

  const git = async (gitArgs) => {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotepath=false", ...gitArgs],
      { cwd: projectRoot, maxBuffer: GIT_MAX_BUFFER }
    );
    return stdout;
  };

  // `git diff --no-index` exits with code 1 when the two inputs differ; that is
  // expected (not an error) when diffing an untracked file against /dev/null.
  const gitAllowDiff = async (gitArgs) => {
    try {
      return await git(gitArgs);
    } catch (error) {
      if (error && error.code === 1 && typeof error.stdout === "string") {
        return error.stdout;
      }
      throw error;
    }
  };

  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    return unavailable({ base, head, generatedAt, reason: gitReason(error) });
  }

  const isWorktree = head === "WORKTREE";
  const range = isWorktree ? [base] : [`${base}..${head}`];

  try {
    const baseSha = (await git(["rev-parse", base])).trim();
    const headSha = isWorktree
      ? (await git(["rev-parse", "HEAD"])).trim()
      : (await git(["rev-parse", head])).trim();

    const nameStatus = await git(["diff", "--name-status", ...range]);
    const numstat = await git(["diff", "--numstat", ...range]);
    const files = mergeFileStats(parseNameStatus(nameStatus), parseNumstat(numstat));

    let untrackedPatch = "";
    if (isWorktree) {
      const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      for (const path of untracked) {
        const diff = await gitAllowDiff(["diff", "--no-index", "--", "/dev/null", path]);
        const stats = countAddedLines(diff);
        files.push({ path, status: "A", added: stats.added, deleted: 0 });
        untrackedPatch += diff;
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
    }

    const totals = files.reduce(
      (acc, file) => {
        acc.added += Number.isFinite(file.added) ? file.added : 0;
        acc.deleted += Number.isFinite(file.deleted) ? file.deleted : 0;
        return acc;
      },
      { added: 0, deleted: 0 }
    );

    const rawPatch = (await git(["diff", ...range])) + untrackedPatch;
    const patchBytes = Buffer.byteLength(rawPatch, "utf8");
    let patch = rawPatch;
    let patchTruncated = false;
    if (patchBytes > maxPatchBytes) {
      patch = truncateToBytes(rawPatch, maxPatchBytes);
      patchTruncated = true;
    }

    return {
      schemaVersion: 1,
      available: true,
      base,
      head,
      baseSha,
      headSha,
      dirty: isWorktree,
      fileCount: files.length,
      files,
      totals,
      patch,
      patchBytes,
      patchTruncated,
      generatedAt
    };
  } catch (error) {
    return unavailable({ base, head, generatedAt, reason: gitReason(error) });
  }
}

export function buildChangesetJson(changeset) {
  return changeset;
}

export function renderChangesetMarkdown(changeset) {
  const lines = ["# KualityForge Frozen Changeset", ""];

  if (!changeset || !changeset.available) {
    lines.push(`No changeset could be frozen (${changeset?.reason || "unknown reason"}).`, "");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Scope", "");
  lines.push(`- Base: ${changeset.base} (${shortSha(changeset.baseSha)})`);
  lines.push(`- Head: ${changeset.head} (${shortSha(changeset.headSha)})${changeset.dirty ? " [working tree]" : ""}`);
  lines.push(`- Files changed: ${changeset.fileCount}`);
  lines.push(`- Lines: +${changeset.totals.added} / -${changeset.totals.deleted}`);
  if (changeset.patchTruncated) {
    lines.push(
      `- NOTE: patch truncated at ${changeset.patch.length} of ${changeset.patchBytes} bytes; treat unlisted hunks as out of scope.`
    );
  }
  lines.push("");

  lines.push("## Files", "");
  if (changeset.files.length === 0) {
    lines.push("No files changed in the frozen range.");
  } else {
    for (const file of changeset.files) {
      const rename = file.renamedTo ? ` -> ${file.renamedTo}` : "";
      lines.push(`- ${file.status} ${file.path}${rename} (+${file.added} / -${file.deleted})`);
    }
  }
  lines.push("");

  lines.push("## Unified Diff", "");
  lines.push("```diff");
  lines.push(changeset.patch.replace(/\n$/, ""));
  lines.push("```");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function unavailable({ base, head, generatedAt, reason }) {
  return {
    schemaVersion: 1,
    available: false,
    base,
    head,
    reason,
    generatedAt
  };
}

function parseNameStatus(stdout) {
  const map = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    const code = parts[0] || "";
    const status = code[0];
    if (status === "R" || status === "C") {
      const from = parts[1];
      const to = parts[2];
      if (from && to) {
        map.set(from, { path: from, status, renamedTo: to });
      }
      continue;
    }
    const path = parts[1];
    if (path) {
      map.set(path, { path, status });
    }
  }
  return map;
}

function parseNumstat(stdout) {
  const map = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    const addedRaw = parts[0];
    const deletedRaw = parts[1];
    let path = parts[2];
    if (!path) {
      continue;
    }
    // Rename numstat may render as "old => new" inside the path field.
    const renameMatch = path.match(/\{(.*) => (.*)\}/);
    if (renameMatch) {
      path = path.replace(/\{(.*) => (.*)\}/, renameMatch[1]).replace(/\/\//g, "/");
    } else if (path.includes(" => ")) {
      path = path.split(" => ")[0];
    }
    map.set(path, {
      added: addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10) || 0,
      deleted: deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw, 10) || 0
    });
  }
  return map;
}

function mergeFileStats(statusMap, numstatMap) {
  const paths = new Set([...statusMap.keys(), ...numstatMap.keys()]);
  const files = [];
  for (const path of paths) {
    const status = statusMap.get(path) || { path, status: "M" };
    const numbers = numstatMap.get(path) || { added: 0, deleted: 0 };
    const file = {
      path,
      status: status.status || "M",
      added: numbers.added || 0,
      deleted: numbers.deleted || 0
    };
    if (status.renamedTo) {
      file.renamedTo = status.renamedTo;
    }
    files.push(file);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function countAddedLines(diff) {
  let added = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    }
  }
  return { added };
}

function truncateToBytes(value, maxBytes) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  // Avoid splitting a multi-byte UTF-8 sequence.
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 12) : sha || "unknown";
}

function gitReason(error) {
  const message = error?.stderr || error?.message || String(error);
  return String(message).trim().split("\n")[0] || "git command failed";
}
