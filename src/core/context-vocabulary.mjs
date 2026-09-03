// Canonical names for everything KualityForge freezes under <artifactRoot>/context.
//
// The write path, the IO derivation layer, and the prompt rendering layer must all
// read these from here. A second literal is how the ack keys drifted before: the
// reviewer prompt asked for camelCase acks while the policy schema and eval corpus
// required snake_case, so an honest reviewer that followed the prompt was blocked
// with "did not acknowledge context".

export const CONTEXT_DIR = "context";

export const CONTEXT_FILES = Object.freeze({
  contextManifest: "context-manifest.json",
  qualityPrinciplesJson: "quality-principles.json",
  qualityPrinciplesMarkdown: "quality-principles.md",
  projectContext: "project-context.json",
  projectBrief: "project-brief.md",
  docsIndex: "docs-index.json",
  changesetJson: "changeset.json",
  changesetMarkdown: "changeset.md",
  structureScanJson: "structure-scan.json",
  structureScanMarkdown: "structure-scan.md"
});

// Which file each manifest.context role must name. A role whose reference points at
// another role's bytes is drift, not an equivalent claim, and without this table the
// only thing holding a role to its file is the producer remembering to.
export const CONTEXT_ROLE_FILES = Object.freeze({
  contextManifest: CONTEXT_FILES.contextManifest,
  qualityPrinciples: CONTEXT_FILES.qualityPrinciplesJson,
  projectContext: CONTEXT_FILES.projectContext,
  projectBrief: CONTEXT_FILES.projectBrief,
  docsIndex: CONTEXT_FILES.docsIndex,
  changeset: CONTEXT_FILES.changesetJson,
  structureScan: CONTEXT_FILES.structureScanJson
});

export const CONTEXT_ACK_KEYS = Object.freeze({
  userQualityPrinciples: "user_quality_principles",
  projectBrief: "project_brief",
  structureScan: "structure_scan"
});

export const DEFAULT_CONTEXT_ACK_KEYS = Object.freeze([
  CONTEXT_ACK_KEYS.userQualityPrinciples,
  CONTEXT_ACK_KEYS.projectBrief
]);

export function contextArtifactPath(file) {
  return `${CONTEXT_DIR}/${file}`;
}

export function deriveContextAvailability(files) {
  const table = files && typeof files === "object" ? files : {};
  // Own-property only: the table is parsed JSON, so an inherited name would let a file
  // the pack never froze pass for one it did.
  const has = (file) => Object.hasOwn(table, file);

  const hasQualityPrinciples = has(CONTEXT_FILES.qualityPrinciplesJson);
  const hasProjectBrief = has(CONTEXT_FILES.projectBrief);
  // The markdown one, because that is the file the reviewer prompt points at. Keying
  // this on the machine-readable .json asks for an ack on a file no reviewer was shown.
  const hasStructureScan = has(CONTEXT_FILES.structureScanMarkdown);

  const ackKeys = [];
  if (hasQualityPrinciples) {
    ackKeys.push(CONTEXT_ACK_KEYS.userQualityPrinciples);
  }
  if (hasProjectBrief) {
    ackKeys.push(CONTEXT_ACK_KEYS.projectBrief);
  }
  if (hasStructureScan) {
    ackKeys.push(CONTEXT_ACK_KEYS.structureScan);
  }

  return {
    hasQualityPrinciples,
    hasProjectBrief,
    hasChangeset: has(CONTEXT_FILES.changesetJson),
    hasStructureScan,
    ackKeys
  };
}
