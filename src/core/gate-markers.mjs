// One authoritative marker vocabulary. Downstream consumers (xiaok-cli UI, CI
// scripts) branch on these constants; the human-readable message beside a marker
// stays free to be reworded. Adding a member here without a producer is a broken
// promise, so gate-markers.test.mjs asserts the two sets match exactly.
export const GATE_MARKERS = Object.freeze({
  ARTIFACT_NAME_COLLISION: "ARTIFACT_NAME_COLLISION",
  ARTIFACT_PATH_DUPLICATE: "ARTIFACT_PATH_DUPLICATE",
  UNKNOWN_FINDING_STATUS: "UNKNOWN_FINDING_STATUS",
  FINDING_ID_DUPLICATE: "FINDING_ID_DUPLICATE",
  SOURCE_RUNNER_UNDECLARED: "SOURCE_RUNNER_UNDECLARED",
  DECISION_OWNER_MISSING: "DECISION_OWNER_MISSING",
  DECISION_UNPARSED: "DECISION_UNPARSED",
  DECISION_DIGEST_MISMATCH: "DECISION_DIGEST_MISMATCH",
  VERDICT_COVERAGE_INCOMPLETE: "VERDICT_COVERAGE_INCOMPLETE",
  RUNNER_ID_MISMATCH: "RUNNER_ID_MISMATCH",
  VERIFICATION_UNPARSED: "VERIFICATION_UNPARSED"
});

// mark() returns the message it recorded, so a marked reason is written once and
// cannot drift from its marker.
export function createDiagnosticSink() {
  const entries = [];
  return {
    entries,
    mark(marker, message) {
      entries.push({ marker, message });
      return message;
    }
  };
}

export function protocolError(marker, message) {
  const error = new Error(message);
  error.marker = marker;
  return error;
}
