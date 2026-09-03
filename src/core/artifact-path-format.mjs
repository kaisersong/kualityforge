// Pure artifact-path shape rules, with no IO and no imports from the rest of core.
//
// These live in a leaf module because the write side (context-pack) and the gate
// side (gate-input, gate-reducer) both need them, and context-pack is reachable
// from artifact-operations through artifact-root. Importing them from
// artifact-operations would close that loop, and a second copy of the rules is how
// the protocol form and the comparison key would drift apart.

// One canonical key for both the write boundary and the gate reducer. Windows
// treats reviews/a.md, reviews\a.md and reviews/A.md as the same file, so the
// key folds separators and case: over-rejecting a case-only difference on Linux
// is safer than missing a real overwrite on Windows.
export function normalizeArtifactKey(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/")
    .toLowerCase();
}

// The protocol form of a path: forward separators, no empty or "." segments, and
// case preserved. Unlike normalizeArtifactKey this is a path, not a comparison key,
// so `toProtocolPath(p) === p` is the test for "already canonical" that lets set
// reconciliation compare both sides as plain strings.
export function toProtocolPath(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

export function isSafeArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return false;
  }
  if (value.split(/[\\/]+/).includes("..")) {
    return false;
  }
  return true;
}
