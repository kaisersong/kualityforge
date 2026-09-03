import { computeFindingSetDigest } from "../../../src/core/decision-artifact.mjs";
import { mapReviewFindings } from "../../../src/core/review-artifact.mjs";
import { synthesizeFindings } from "../../../src/core/synthesis.mjs";

const DECIDED_AT = "2026-08-30T10:00:00Z";

export function synthesizeReviewFindings(reviews) {
  return synthesizeFindings(
    reviews.flatMap(({ runnerId, findings }) => mapReviewFindings(runnerId, findings).findings)
  );
}

// The digest covers the canonical synthesized finding shape. Fixtures that replay
// raw reviews should pass findings produced by synthesizeReviewFindings.
export function bindDecision(manifest, owner = "kai") {
  manifest.humanDecision = {
    artifact: "decision.md",
    owner,
    status: "parsed",
    runId: manifest.runId,
    findingSetDigest: computeFindingSetDigest(manifest.findings),
    decidedAt: DECIDED_AT
  };
  return manifest;
}

// bindDecision deliberately adds no changeset: its job is the human decision, and a
// default freeze there would hand every caller fake evidence it never produced. A
// fixture that declares neither mode below is therefore refused by the gate, which is
// the intended behaviour rather than an obstacle.
//
// `available` lives on the derived manifest, not on the reference written to disk, so a
// reducer-level fixture sets it directly — that is the reducer's actual input. Fixtures
// that travel through the gate's IO layer must seed a real context/changeset.json.
export function withChangeset(manifest, { available = true } = {}) {
  manifest.context = {
    ...(manifest.context || {}),
    changeset: { artifact: "context/changeset.json", sha256: fixtureDigest("changeset"), available },
    projectBrief: { artifact: "context/project-brief.md", sha256: fixtureDigest("project-brief") }
  };
  return withContextProvenance(manifest);
}

// full-project skips the freeze requirement but is not a free pass: the two references
// it declares here are themselves unconditional, so this route pays its own cost.
export function asFullProject(manifest) {
  manifest.reviewType = "full-project";
  manifest.context = {
    ...(manifest.context || {}),
    projectContext: {
      artifact: "context/project-context.json",
      sha256: fixtureDigest("project-context")
    },
    projectBrief: { artifact: "context/project-brief.md", sha256: fixtureDigest("project-brief") }
  };
  return withContextProvenance(manifest);
}

// Reducer tests provide the reducer's actual derived input; they do not claim that these
// hashes came from disk. Any fixture entering through gate-input must instead write the
// descriptor and let replay derive reviewer provenance from real review artifacts.
function withContextProvenance(manifest) {
  const contextManifestHash = manifest.context?.contextManifest?.sha256 || fixtureDigest("context-manifest");
  manifest.context = {
    ...(manifest.context || {}),
    contextManifest: {
      artifact: "context/context-manifest.json",
      sha256: contextManifestHash
    }
  };
  manifest.reviewers = (manifest.reviewers || []).map((reviewer) =>
    reviewer
      ? {
          ...reviewer,
          contextProvenance: {
            ...(reviewer.contextProvenance || {}),
            contextManifestHash
          }
        }
      : reviewer
  );
  return manifest;
}

function fixtureDigest(seed) {
  return seed.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "0");
}

// Fixture builders take the mode as a required argument rather than defaulting to one,
// so a newly written case has to state which evidence it claims to have. A default here
// would let the next test inherit a freeze it never seeded, which is the shape the gate
// criterion exists to catch.
export function applyReviewMode(manifest, mode) {
  if (mode === "changeset") {
    return withChangeset(manifest);
  }
  if (mode === "full-project") {
    return asFullProject(manifest);
  }
  throw new Error(`fixture requires an explicit review mode, got ${JSON.stringify(mode)}`);
}

export function decisionMarkdown({
  runId,
  findings,
  owner = "kai",
  disposition = "risk_accepted",
  reason = "accepted for this run",
  decidedAt = DECIDED_AT,
  overrides = {}
}) {
  const body = {
    schemaVersion: "kualityforge.decision.v1",
    runId,
    findingSetDigest: computeFindingSetDigest(findings),
    decidedBy: owner,
    decidedAt,
    findings: findings.map((finding) => ({ id: finding.id, disposition, reason })),
    ...overrides
  };
  return `# Human Decision\n\n\`\`\`kualityforge-decision\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

const DEFAULT_REVIEW_FINDING = Object.freeze({
  title: "Potential issue identified during review requiring further investigation and resolution",
  description:
    "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
  suggestion:
    "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
  severity: "info"
});

export function reviewMarkdown({
  runnerId,
  findings = [DEFAULT_REVIEW_FINDING],
  contextManifestHash = null
}) {
  const body = {
    runnerId,
    status: "completed",
    ...(contextManifestHash
      ? { contextProvenance: { contextManifestHash } }
      : {}),
    findings
  };
  return `# Review\n\n\`\`\`kualityforge-review\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

export function verificationMarkdown({ runnerId, verdicts = [] }) {
  const body = { runnerId, verdicts };
  return `# Verification\n\n\`\`\`kualityforge-verification\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}
