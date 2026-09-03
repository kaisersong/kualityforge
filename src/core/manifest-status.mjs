export const MANIFEST_STATUSES = Object.freeze([
  "open",
  "incomplete",
  "approved_for_fix",
  "fixed",
  "partially_fixed",
  "wont_fix",
  "risk_accepted",
  "verified",
  "verification_failed",
  "test_blocked",
  "failed",
  "invalid_artifact",
  "cancelled"
]);

const MANIFEST_STATUS_SET = new Set(MANIFEST_STATUSES);

export function isManifestStatus(value) {
  return MANIFEST_STATUS_SET.has(value);
}
