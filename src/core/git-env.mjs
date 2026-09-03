import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

// Removing this would leave git unable to start on Nix and Homebrew layouts, and
// a failed spawn surfaces as an unavailable changeset rather than an error.
const PRESERVED_GIT_VARS = new Set(["GIT_EXEC_PATH"]);

// Blacklist by prefix rather than an allowlist: git keeps adding environment
// variables, so an allowlist would silently let the new ones through.
export function stripGitVars(env) {
  const stripped = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("GIT_") && !PRESERVED_GIT_VARS.has(key)) {
      continue;
    }
    stripped[key] = value;
  }
  return stripped;
}

let cached = null;

// A changeset runs git a dozen times; one isolation root per process keeps that
// from becoming a dozen temp directories. The pid keeps two concurrent
// KualityForge processes from overwriting each other's config file.
function isolationRoot() {
  const dir = mkdtempSync(join(tmpdir(), `kualityforge-gitenv-${process.pid}-`));
  const configPath = join(dir, "empty.gitconfig");
  writeFileSync(configPath, "");
  return { dir, configPath };
}

function buildOverrides({ dir, configPath }) {
  const root = parse(dir).root;
  // Git for Windows resolves the second fallback by concatenating these two, and
  // an invalid concatenation is skipped silently rather than reported — which
  // would drop one isolation layer while everything still looked healthy.
  const homeDrive = root.replace(/[\\/]+$/, "");
  const homePath = dir.slice(homeDrive.length);

  return {
    GIT_CONFIG_NOSYSTEM: "1",
    // Exact, but only honored by Git >= 2.32.
    GIT_CONFIG_GLOBAL: configPath,
    // Where older git and Git for Windows look instead. Both layers are set so
    // no version probe is needed — a probe would only report the failure, and it
    // would have to run before the work-tree check.
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    USERPROFILE: dir,
    HOMEDRIVE: homeDrive,
    HOMEPATH: homePath,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    TZ: "UTC"
  };
}

// Degrading to GIT_CONFIG_NOSYSTEM alone is exactly the hole this module exists
// to close, so the caller must record it and the gate must refuse to pass on it.
function degradedOverrides() {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    TZ: "UTC"
  };
}

export function resolveDeterministicGitOverrides() {
  if (!cached) {
    try {
      cached = { overrides: buildOverrides(isolationRoot()), degraded: false };
    } catch {
      cached = { overrides: degradedOverrides(), degraded: true };
    }
  }
  return cached;
}

// The host is filtered before the deterministic values are layered on, never the
// other way around: reversing it strips the variables just set.
export function resolveDeterministicGitEnv() {
  const { overrides, degraded } = resolveDeterministicGitOverrides();
  return { env: { ...stripGitVars(process.env), ...overrides }, degraded };
}
