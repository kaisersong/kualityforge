import { createHash } from "node:crypto";
import {
  DECISION_DISPOSITIONS,
  DISPOSITIONS_REQUIRING_REASON,
  isDecisionDisposition
} from "./finding-vocabulary.mjs";

const DECISION_BLOCK_PATTERN = /```kualityforge-decision\s*\n([\s\S]*?)\n```/;
const DECISION_SCHEMA_VERSION = "kualityforge.decision.v1";
const RECORD_SEPARATOR = "\u001e";
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// Binds a decision to the immutable, gate-critical finding set it was made
// against. Decision-stage fields and merge-produced prose are deliberately
// excluded so an honest status transition does not invalidate the decision.
export function computeFindingSetDigest(findings) {
  const rows = (Array.isArray(findings) ? findings : []).map((finding) =>
    JSON.stringify([
      finding?.id ?? "",
      finding?.severity ?? "",
      finding?.title ?? "",
      finding?.type ?? null,
      finding?.priority ?? null,
      finding?.principleId ?? null,
      normalizedSourceRunnerIds(finding)
    ])
  );
  rows.sort(compareCodePoints);
  return `sha256:${createHash("sha256").update(rows.join(RECORD_SEPARATOR), "utf8").digest("hex")}`;
}

function normalizedSourceRunnerIds(finding) {
  const runners = [
    finding?.sourceRunnerId,
    ...(Array.isArray(finding?.sourceRunnerIds) ? finding.sourceRunnerIds : [])
  ].filter((runnerId) => typeof runnerId === "string" && runnerId.length > 0);
  return [...new Set(runners)].sort(compareCodePoints);
}

// localeCompare is locale- and ICU-version-dependent; the digest must not be.
function compareCodePoints(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

// Returns null when the artifact carries no machine-readable decision at all.
// That is a recordable fact the gate turns into a blocker. Anything present but
// malformed is a contract violation and throws.
export function parseDecisionArtifact(markdown, options = {}) {
  if (typeof markdown !== "string") {
    throw new Error("decision markdown must be a string");
  }
  const match = DECISION_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return null;
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  if (data.schemaVersion !== DECISION_SCHEMA_VERSION) {
    throw new Error(
      `kualityforge-decision schemaVersion must be ${DECISION_SCHEMA_VERSION}; got: ${data.schemaVersion}`
    );
  }
  const runId = requireString(data.runId, "runId");
  const findingSetDigest = requireString(data.findingSetDigest, "findingSetDigest");
  if (!/^sha256:[0-9a-f]{64}$/.test(findingSetDigest)) {
    throw new Error("kualityforge-decision findingSetDigest must be sha256:<64 hex>");
  }
  const decidedBy = requireString(data.decidedBy, "decidedBy");
  if (options.owner !== undefined && decidedBy !== options.owner) {
    throw new Error(
      `kualityforge-decision decidedBy must match the recording owner: expected ${options.owner}, got ${decidedBy}`
    );
  }
  const decidedAt = requireString(data.decidedAt, "decidedAt");
  if (!RFC3339_PATTERN.test(decidedAt)) {
    throw new Error("kualityforge-decision decidedAt must be an RFC3339 timestamp");
  }
  if (!Array.isArray(data.findings)) {
    throw new Error("kualityforge-decision must include a findings array");
  }

  const knownIds = new Set((options.findings || []).map((finding) => finding?.id));
  const seen = new Set();
  const dispositions = data.findings.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error("each kualityforge-decision finding must be an object");
    }
    const id = requireString(entry.id, "finding id");
    if (seen.has(id)) {
      throw new Error(`kualityforge-decision decides ${id} more than once`);
    }
    seen.add(id);
    if (!knownIds.has(id)) {
      throw new Error(`kualityforge-decision references unknown finding ${id}`);
    }
    if (!isDecisionDisposition(entry.disposition)) {
      throw new Error(
        `kualityforge-decision disposition for ${id} must be one of ${DECISION_DISPOSITIONS.join(", ")}; got: ${entry.disposition}`
      );
    }
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (DISPOSITIONS_REQUIRING_REASON.includes(entry.disposition) && reason === "") {
      throw new Error(`kualityforge-decision requires a reason for ${entry.disposition} on ${id}`);
    }
    return reason === ""
      ? { id, disposition: entry.disposition }
      : { id, disposition: entry.disposition, reason };
  });

  return { runId, findingSetDigest, decidedBy, decidedAt, dispositions };
}

// A finding the decision stayed silent about becomes unchecked, which blocks.
// Silence is not consent.
export function applyDecisionToFindings(findings, decision) {
  const byId = new Map((decision?.dispositions || []).map((entry) => [entry.id, entry]));
  return (findings || []).map((finding) => {
    const entry = byId.get(finding.id);
    if (!entry) {
      return { ...finding, status: "unchecked" };
    }
    return {
      ...finding,
      status: entry.disposition,
      ...(entry.reason ? { decisionReason: entry.reason } : {})
    };
  });
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`kualityforge-decision ${name} is required`);
  }
  return value;
}
