import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadManifestFromArtifactRoot } from "./artifact-root.mjs";
import {
  checkArtifactShape,
  isSafeArtifactPath,
  normalizeArtifactKey,
  toProtocolPath
} from "./artifact-operations.mjs";
import {
  CONTEXT_DIR,
  CONTEXT_FILES,
  CONTEXT_ROLE_FILES,
  contextArtifactPath
} from "./context-vocabulary.mjs";
import { mapReviewFindings } from "./review-artifact.mjs";
import { parseRawReviewFence } from "./raw-review-fence.mjs";
import { synthesizeFindings } from "./synthesis.mjs";
import {
  applyDecisionToFindings,
  computeFindingSetDigest,
  parseDecisionArtifact
} from "./decision-artifact.mjs";
import {
  deriveManifestVerification,
  parseVerificationArtifact
} from "./verification-artifact.mjs";
import { DEFAULT_RELEASE_POLICY, reduceQualityGate } from "./gate-reducer.mjs";

// A manifest can name an artifact that was never written. Shape validation cannot
// see that, so the gate would otherwise treat a dangling reference as evidence.
const CONTEXT_KEYS = Object.keys(CONTEXT_ROLE_FILES);

// The descriptor is not one of the files it describes: it is written after the table it
// carries, so the table cannot list it. Both sides of the set comparison exclude it.
const CONTEXT_MANIFEST_PATH = contextArtifactPath(CONTEXT_FILES.contextManifest);
const RECONCILED_CONTEXT_ROLES = CONTEXT_KEYS.filter((role) => role !== "contextManifest");

// A missing or unreadable-as-a-file reference is a verdict about the run; a
// permission or IO fault is a fault of the process running the gate and must not
// be reported as "this run failed review".
const INTEGRITY_ERRNOS = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

// Nothing in this repository enforces a permission claim, so a manifest or policy
// carrying one would assert an enforcement that does not exist. `permissions` is in
// the set as a container: refusing the container also refuses inner keys nobody has
// enumerated yet, which a list of leaf names cannot do.
const FORBIDDEN_PERMISSION_KEYS = Object.freeze([
  "deniedCommands",
  "allowShell",
  "allowRenderer",
  "allowWrite",
  "allowNetwork",
  "permissions"
]);

const MAX_PERMISSION_SCAN_DEPTH = 6;

export async function loadGateInputFromArtifactRoot(artifactRoot, policy = DEFAULT_RELEASE_POLICY) {
  const { manifestPath, manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const derivation = await deriveGateManifest(artifactRoot, manifest);
  const integrityErrors = [
    ...scanForbiddenPermissionFields(manifest, "manifest"),
    ...scanForbiddenPermissionFields(policy, "policy"),
    ...(await collectIntegrityErrors(artifactRoot, manifest)),
    ...derivation.errors
  ];
  // The reducer judges the derived manifest and callers still get the raw one: the raw
  // manifest is what the artifact root actually says, and a caller that reported the
  // derived copy would be reporting fields no file contains.
  const gate = reduceQualityGate(derivation.manifest, policy, { integrityErrors });

  return {
    artifactRoot,
    manifestPath,
    manifest,
    derivedManifest: derivation.manifest,
    integrityErrors,
    gate
  };
}

// Descending stops at the outermost hit so the error names `manifest.permissions`
// rather than every leaf under it, which keeps the output count independent of how
// deeply the payload was nested.
export function scanForbiddenPermissionFields(value, label) {
  const errors = [];
  visitForFields(value, label, 0, errors);
  return errors;
}

function visitForFields(value, path, depth, errors) {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (depth > MAX_PERMISSION_SCAN_DEPTH) {
    errors.push(`${path} exceeds the maximum permission scan depth of ${MAX_PERMISSION_SCAN_DEPTH}`);
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      visitForFields(entry, `${path}[${index}]`, depth + 1, errors);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PERMISSION_KEYS.includes(key)) {
      errors.push(`${path}.${key} declares permissions the gate cannot enforce`);
      continue;
    }
    visitForFields(entry, `${path}.${key}`, depth + 1, errors);
  }
}

export async function collectIntegrityErrors(artifactRoot, manifest) {
  const references = artifactReferences(manifest);
  const errors = [];
  const replayable = [];
  for (const reference of references) {
    const { usable, reason } = await inspectReference(artifactRoot, reference);
    if (reason) {
      errors.push(`${reference.label} ${reference.path} ${reason}`);
    }
    if (usable && reference.reviewerIndex !== undefined) {
      replayable.push(reference);
    }
  }

  // Replay derives evidence from the reviewer artifacts, so it only runs once every
  // reviewer reference is usable. Skipping it when one is not cannot turn a failing
  // run into a passing one — the unusable reference is already an error above — but
  // it does keep one bad path from producing a second, confusing verdict.
  const declaredReviewers = Array.isArray(manifest.reviewers) ? manifest.reviewers.length : 0;
  if (declaredReviewers > 0 && replayable.length === declaredReviewers) {
    errors.push(...(await reconcileReviewFiles(artifactRoot, replayable)));
  }

  errors.push(...(await reconcileContextPack(artifactRoot, manifest)));

  return errors;
}

// `available` is written inside context/changeset.json and nowhere else: the manifest
// reference beside it carries a path and a hash only. The reducer is pure and cannot
// read disk, so a blocker on a failed freeze has no field to read until this layer puts
// one there. Both derived values default to false rather than to absent, because the
// criterion downstream is `!== true` and an absent field would have to be re-decided by
// every reader.
export async function deriveGateManifest(artifactRoot, manifest) {
  const changesetDerivation = await deriveChangesetManifest(artifactRoot, manifest);
  const replayDerivation = await deriveArtifactBackedManifest(
    artifactRoot,
    changesetDerivation.manifest
  );
  return {
    manifest: replayDerivation.manifest,
    errors: [...changesetDerivation.errors, ...replayDerivation.errors]
  };
}

async function deriveChangesetManifest(artifactRoot, manifest) {
  const reference = manifest?.context?.changeset;
  if (reference === null || reference === undefined) {
    return { manifest, errors: [] };
  }

  // A non-canonical reference has already been refused by the reconciliation above.
  // Following it here would be a second read path into whatever it names, constrained by
  // nothing.
  const canonical = contextArtifactPath(CONTEXT_FILES.changesetJson);
  if (reference.artifact !== canonical) {
    return { manifest, errors: [] };
  }

  const shape = await checkArtifactShape({
    value: canonical,
    expectedRoot: CONTEXT_DIR,
    artifactRoot
  });
  if (!shape.ok) {
    return { manifest, errors: [] };
  }

  let document;
  try {
    document = JSON.parse((await readFile(join(artifactRoot, canonical))).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || INTEGRITY_ERRNOS.has(error.code)) {
      return {
        manifest,
        errors: [`${canonical} is not readable as a frozen changeset: ${error.message}`]
      };
    }
    throw error;
  }

  return {
    manifest: {
      ...manifest,
      context: {
        ...manifest.context,
        changeset: {
          ...reference,
          available: document?.available === true,
          deterministicEnvDegraded: document?.deterministicEnvDegraded === true
        }
      }
    },
    errors: []
  };
}

async function deriveArtifactBackedManifest(artifactRoot, manifest) {
  const reviewers = [];
  const rawFindings = [];
  const errors = [];

  for (const [index, reviewer] of (manifest.reviewers || []).entries()) {
    if (typeof reviewer?.artifact !== "string" || !isSafeArtifactPath(reviewer.artifact)) {
      return { manifest, errors };
    }
    const shape = await checkArtifactShape({
      value: reviewer.artifact,
      expectedRoot: "reviews",
      expectedSuffix: ".md",
      artifactRoot
    });
    if (!shape.ok) {
      return { manifest, errors };
    }
    let document;
    try {
      document = parseRawReviewFence(await readFile(join(artifactRoot, reviewer.artifact), "utf8"));
    } catch (error) {
      if (INTEGRITY_ERRNOS.has(error.code)) {
        return { manifest, errors };
      }
      if (error?.code) {
        throw error;
      }
      errors.push(
        `reviewers[${index}].artifact ${reviewer.artifact} is not a replayable review artifact: ${error.message}`
      );
      return { manifest, errors };
    }
    try {
      if (document.runnerId !== reviewer.runnerId) {
        errors.push(
          `reviewers[${index}].artifact ${reviewer.artifact} was written by ${document.runnerId}, not ${reviewer.runnerId}`
        );
        return { manifest, errors };
      }
      const mapped = mapReviewFindings(document.runnerId, document.findings);
      rawFindings.push(...mapped.findings);
      const derivedReviewer = {
        ...reviewer,
        status: document.status,
        contextRead: document.contextRead || {},
        contextConfidence: document.contextConfidence || "medium",
        contextGaps: Array.isArray(document.contextGaps) ? document.contextGaps : [],
        contextProvenance: document.contextProvenance || {},
        principleAlignment: document.principleAlignment || {},
        isVacuous: mapped.isVacuous
      };
      for (const key of [
        "contextRead",
        "contextConfidence",
        "contextGaps",
        "contextProvenance",
        "principleAlignment"
      ]) {
        if (JSON.stringify(reviewer[key] ?? defaultReviewerField(key)) !== JSON.stringify(derivedReviewer[key])) {
          errors.push(`reviewers[${index}].${key} does not match ${reviewer.artifact}`);
        }
      }
      if (reviewer.status !== document.status) {
        errors.push(
          `reviewers[${index}].status ${reviewer.status} does not match ${document.status} in ${reviewer.artifact}`
        );
      }
      if ((reviewer.isVacuous === true) !== mapped.isVacuous) {
        errors.push(
          `reviewers[${index}].isVacuous ${reviewer.isVacuous === true} does not match ${mapped.isVacuous} derived from ${reviewer.artifact}`
        );
      }
      reviewers.push(derivedReviewer);
    } catch (error) {
      if (INTEGRITY_ERRNOS.has(error.code)) {
        return { manifest, errors };
      }
      if (error?.code) {
        throw error;
      }
      errors.push(
        `reviewers[${index}].artifact ${reviewer.artifact} does not map to protocol findings: ${error.message}`
      );
      return { manifest, errors };
    }
  }

  let findings;
  try {
    findings = synthesizeFindings(rawFindings);
  } catch (error) {
    errors.push(`review findings cannot be synthesized: ${error.message}`);
    return { manifest: { ...manifest, reviewers }, errors };
  }

  let humanDecision = manifest.humanDecision;
  const decisionArtifact = manifest.humanDecision?.artifact;
  if (typeof decisionArtifact === "string" && isSafeArtifactPath(decisionArtifact)) {
    try {
      const decision = parseDecisionArtifact(
        await readFile(join(artifactRoot, decisionArtifact), "utf8"),
        { findings, owner: manifest.humanDecision.owner }
      );
      if (!decision) {
        throw new Error("decision artifact has no machine-readable decision block");
      }
      if (decision.runId !== manifest.runId) {
        throw new Error(`decision runId ${decision.runId} does not match manifest runId ${manifest.runId}`);
      }
      const digest = computeFindingSetDigest(findings);
      if (decision.findingSetDigest !== digest) {
        throw new Error("decision findingSetDigest does not match replayed findings");
      }
      findings = applyDecisionToFindings(findings, decision);
      humanDecision = {
        artifact: decisionArtifact,
        owner: manifest.humanDecision.owner,
        status: "parsed",
        runId: decision.runId,
        findingSetDigest: decision.findingSetDigest,
        decidedAt: decision.decidedAt
      };
    } catch (error) {
      if (INTEGRITY_ERRNOS.has(error.code)) {
        return { manifest, errors };
      }
      if (error?.code) {
        throw error;
      }
      errors.push(`humanDecision.artifact ${decisionArtifact} is not replayable: ${error.message}`);
      humanDecision = { ...manifest.humanDecision, status: "unparsed" };
    }
  }

  if (!equalFindingProjection(findings, manifest.findings || [])) {
    errors.push("manifest findings do not match the replayed review, synthesis, and decision projection");
  }

  let verification = manifest.verification;
  const verificationArtifact = manifest.verification?.artifact;
  if (typeof verificationArtifact === "string" && isSafeArtifactPath(verificationArtifact)) {
    try {
      const parsed = parseVerificationArtifact(
        await readFile(join(artifactRoot, verificationArtifact), "utf8")
      );
      const replayedVerification = deriveManifestVerification(parsed, findings, {
        artifact: verificationArtifact
      });
      if (!equalVerificationProjection(replayedVerification, manifest.verification)) {
        errors.push("manifest verification does not match replayed verification");
      }
      verification = replayedVerification;
    } catch (error) {
      if (INTEGRITY_ERRNOS.has(error.code)) {
        return { manifest, errors };
      }
      if (error?.code) {
        throw error;
      }
      errors.push(`verification.artifact ${verificationArtifact} is not replayable: ${error.message}`);
    }
  }

  return {
    manifest: { ...manifest, reviewers, findings, humanDecision, verification },
    errors
  };
}

function equalVerificationProjection(left, right) {
  return JSON.stringify(projectVerification(left)) === JSON.stringify(projectVerification(right));
}

function projectVerification(verification) {
  return {
    runnerId: verification?.runnerId ?? null,
    status: verification?.status ?? null,
    artifact: verification?.artifact ?? null,
    verdicts: Array.isArray(verification?.verdicts)
      ? verification.verdicts.map((verdict) => ({
          findingId: verdict?.findingId ?? null,
          status: verdict?.status ?? null,
          notes: verdict?.notes ?? null
        }))
      : verification?.verdicts ?? null,
    verdictCount: verification?.verdictCount ?? null,
    confirmedCount: verification?.confirmedCount ?? null,
    dismissedCount: verification?.dismissedCount ?? null,
    cannotVerifyCount: verification?.cannotVerifyCount ?? null,
    coveredFindingIds: verification?.coveredFindingIds ?? null,
    uncoveredOpenFindingIds: verification?.uncoveredOpenFindingIds ?? null,
    disputedFindings: verification?.disputedFindings ?? null
  };
}

function defaultReviewerField(key) {
  if (key === "status") return undefined;
  if (key === "contextConfidence") return "medium";
  if (key === "contextRead" || key === "contextProvenance" || key === "principleAlignment") return {};
  if (key === "contextGaps") return [];
  if (key === "isVacuous") return false;
  return undefined;
}

function equalFindingProjection(left, right) {
  return JSON.stringify(projectFindings(left)) === JSON.stringify(projectFindings(right));
}

function projectFindings(findings) {
  return (Array.isArray(findings) ? findings : [])
    .map((finding) => ({
      id: finding?.id ?? null,
      severity: finding?.severity ?? null,
      title: finding?.title ?? null,
      type: finding?.type ?? null,
      priority: finding?.priority ?? null,
      principleId: finding?.principleId ?? null,
      status: finding?.status ?? null,
      decisionReason: finding?.decisionReason ?? null,
      sourceRunnerIds: normalizedFindingRunners(finding)
    }))
    .sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
}

function normalizedFindingRunners(finding) {
  return [
    finding?.sourceRunnerId,
    ...(Array.isArray(finding?.sourceRunnerIds) ? finding.sourceRunnerIds : [])
  ]
    .filter((runnerId) => typeof runnerId === "string" && runnerId.length > 0)
    .filter((runnerId, index, values) => values.indexOf(runnerId) === index)
    .sort(compareCodePoints);
}

function compareCodePoints(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function artifactReferences(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [];
  }

  const references = [];
  const add = (label, path, extra = {}) => {
    if (typeof path === "string" && path.length > 0) {
      references.push({ label, path, ...extra });
    }
  };

  for (const [index, reviewer] of (manifest.reviewers || []).entries()) {
    // Reviewer artifacts are the only references with a mandated location. Without
    // it, a reference into context/ would satisfy every other check while the
    // directory reconciliation below finds nothing to reconcile.
    add(`reviewers[${index}].artifact`, reviewer?.artifact, {
      reviewerIndex: index,
      expectedRoot: "reviews",
      expectedSuffix: ".md"
    });
  }
  for (const [index, check] of (manifest.requiredChecks || []).entries()) {
    add(`requiredChecks[${index}].log`, check?.log);
  }
  for (const key of ["humanDecision", "verification", "synthesis", "reviewerScores", "inducedPrinciples", "fixer"]) {
    add(`${key}.artifact`, manifest[key]?.artifact);
  }
  for (const key of CONTEXT_KEYS) {
    add(`context.${key}.artifact`, manifest.context?.[key]?.artifact);
  }

  return references;
}

// Returns "usable" separately from "reason" because a shape-unsafe reference is
// reported by nobody here and must still never be read. Collapsing the two lets the
// replay layer below join and read a traversal path — the W4 hole reopening one
// layer further in.
async function inspectReference(artifactRoot, { path, expectedRoot, expectedSuffix }) {
  // Returning before checkArtifactShape can join anything is the whole point:
  // otherwise the gate stats a path outside its own root. The reducer independently
  // rejects a shape-unsafe reference as invalid_artifact, so reporting it here too
  // would only duplicate that verdict — tests/kualityforge/unit/gate-input.test.mjs
  // pins both halves.
  if (!isSafeArtifactPath(path)) {
    return { usable: false, reason: null };
  }

  const shape = await checkArtifactShape({
    value: path,
    expectedRoot: expectedRoot ?? null,
    artifactRoot,
    expectedSuffix: expectedSuffix ?? null
  });
  return shape.ok ? { usable: true, reason: null } : { usable: false, reason: shape.reason };
}

// The reviewer index has no binding of its own: deleting the entry that carried a
// blocker leaves the artifact on disk, valid and reachable, and nothing in the
// reference walk above would ever look at it. Enumeration is what makes that
// deletion visible.
async function reconcileReviewFiles(artifactRoot, replayable) {
  let onDisk;
  try {
    // .gitkeep is written by initializeArtifactRoot, so counting it would make every
    // honest run red.
    onDisk = await enumerateFiles(join(artifactRoot, "reviews"), "reviews", (name) => name.endsWith(".md"));
  } catch (error) {
    if (INTEGRITY_ERRNOS.has(error.code)) {
      // No reviews directory at all: every declared reference already failed above.
      return [];
    }
    throw error;
  }

  const declared = new Set(replayable.map((reference) => reference.path));
  const errors = [];
  for (const path of onDisk) {
    if (!declared.has(path)) {
      errors.push(`reviews/ contains ${path}, which no manifest reviewer claims`);
    }
  }

  // Same-side collision only. Two protocol paths that fold to one key mean the two
  // reviewers are the same file on a case-insensitive host, whichever host this is.
  const keys = new Map();
  for (const reference of replayable) {
    const key = normalizeArtifactKey(reference.path);
    const incumbent = keys.get(key);
    if (incumbent) {
      errors.push(`${reference.label} ${reference.path} collides with ${incumbent}`);
      continue;
    }
    keys.set(key, reference.path);
  }

  return errors;
}

// Hand-rolled because engines.node is >= 20, where fs.glob does not exist, and
// because a single-level read would miss an artifact moved into reviews/nested/.
async function enumerateFiles(absoluteDir, protocolPrefix, accept) {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const childProtocolPath = toProtocolPath(`${protocolPrefix}/${entry.name}`);
    if (entry.isDirectory()) {
      found.push(...(await enumerateFiles(join(absoluteDir, entry.name), childProtocolPath, accept)));
      continue;
    }
    if (entry.isFile() && accept(entry.name)) {
      found.push(childProtocolPath);
    }
  }
  return found.sort();
}

// The manifest's reviewer entry and the artifact it claims to summarise must agree,
// and the only way to know that is to read the bytes. Stat alone cannot tell the
// difference between a review and the words "not a KualityForge artifact".
async function replayReviewer(artifactRoot, manifest, { label, path, reviewerIndex }) {
  const reviewer = manifest.reviewers[reviewerIndex];
  const markdown = await readFile(join(artifactRoot, path), "utf8");

  // The strict parser is a write-boundary-style function that throws. The reducer's
  // contract is that it never throws, so a protocol violation in the bytes has to
  // become an integrity error here.
  let document;
  try {
    document = parseRawReviewFence(markdown);
  } catch (error) {
    return [`${label} ${path} is not a replayable review artifact: ${error.message}`];
  }

  // Only the top-level runnerId is an anchor. Per-finding sourceRunnerId is
  // overwritten by the write path, so checking it would be vacuously true.
  if (document.runnerId !== reviewer.runnerId) {
    return [`${label} ${path} was written by ${document.runnerId}, not ${reviewer.runnerId}`];
  }

  let mapped;
  try {
    mapped = mapReviewFindings(document.runnerId, document.findings);
  } catch (error) {
    return [`${label} ${path} does not map to protocol findings: ${error.message}`];
  }

  const errors = [];
  if (document.status !== reviewer.status) {
    errors.push(
      `reviewers[${reviewerIndex}].status ${reviewer.status} does not match ${document.status} in ${path}`
    );
  }

  // Derived from the raw fence, never from the manifest copy: padding the manifest's
  // description past the threshold is otherwise enough to flip a vacuous review.
  if (mapped.isVacuous !== (reviewer.isVacuous === true)) {
    errors.push(
      `reviewers[${reviewerIndex}].isVacuous ${reviewer.isVacuous === true} does not match ${mapped.isVacuous} derived from ${path}`
    );
  }

  return errors;
}

// The context pack is the only evidence a reviewer was shown anything, and until this
// layer existed nothing bound it to the bytes on disk: the manifest's seven references
// name six files, so the changeset and structure scan markdown a reviewer actually
// reads had their hash recorded in exactly one place — the descriptor's own table —
// and nobody ever read that table back.
async function reconcileContextPack(artifactRoot, manifest) {
  const contextRoot = join(artifactRoot, CONTEXT_DIR);
  const claim = manifest?.context?.contextManifest?.artifact;

  // No claim at all: there is nothing to reconcile against, so the only question left
  // is whether a context directory exists anyway. Enumerating is what keeps a planted
  // one from riding along unlooked at.
  if (typeof claim !== "string" || claim.length === 0) {
    const orphans = await enumerateContextFiles(contextRoot, () => true);
    return orphans.map((path) => `${CONTEXT_DIR}/ contains ${path}, which no context manifest claims`);
  }

  // Step 0. Read the canonical descriptor path, not the claimed one: the claim is
  // checked below, and following it here would let a rewritten claim choose which
  // bytes get to describe the pack.
  const descriptorPath = join(contextRoot, CONTEXT_FILES.contextManifest);
  let descriptorBytes;
  let descriptor;
  try {
    descriptorBytes = await readFile(descriptorPath);
    descriptor = JSON.parse(descriptorBytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || INTEGRITY_ERRNOS.has(error.code)) {
      return [`${CONTEXT_MANIFEST_PATH} is not readable as a context manifest: ${error.message}`];
    }
    throw error;
  }

  const files = descriptor?.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    return [`${CONTEXT_MANIFEST_PATH} does not declare a files table`];
  }

  // Own properties only, and the values are pre-validated here rather than where they
  // are used: the artifact field is consumed by the set comparison and the sha256 by
  // the hash check, two different steps, so a check inside either one leaves the other
  // able to throw on a malformed entry.
  const entries = Object.entries(files);
  for (const [key, entry] of entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.artifact !== "string" ||
      entry.artifact.length === 0 ||
      typeof entry.sha256 !== "string" ||
      entry.sha256.length === 0
    ) {
      return [`${CONTEXT_MANIFEST_PATH} entry ${key} must declare a non-empty artifact and sha256`];
    }
  }

  const errors = [];
  const hashes = new Map();
  const hashOf = async (protocolPath) => {
    if (!hashes.has(protocolPath)) {
      // No encoding argument: the digest has to be over the bytes, because a decode
      // and re-encode is only lossless while the file happens to be valid UTF-8, and
      // "happens to be" is exactly what an integrity check may not assume.
      hashes.set(protocolPath, createHash("sha256").update(await readFile(join(artifactRoot, protocolPath))).digest("hex"));
    }
    return hashes.get(protocolPath);
  };

  // Steps 1 to 3. The descriptor is excluded from both sides because it is written
  // after the table it carries and so cannot list itself; excluding it on the index
  // side too keeps the two sides symmetric rather than relying on that ordering.
  //
  // This loop is only the disk-only half. The index-only half is the per-entry
  // reachability check below, which names the offending entry rather than just the set
  // difference — removing it would silently make the reconciliation one-way, which is
  // exactly the weakening that lets a dropped entry hide a rewritten file.
  const onDisk = (await enumerateContextFiles(contextRoot, () => true)).filter(
    (path) => path !== CONTEXT_MANIFEST_PATH
  );
  const indexed = entries
    .map(([, entry]) => entry.artifact)
    .filter((artifact) => artifact !== CONTEXT_MANIFEST_PATH);
  const indexedSet = new Set(indexed);
  for (const path of onDisk) {
    if (!indexedSet.has(path)) {
      errors.push(`${path} is on disk but ${CONTEXT_FILES.contextManifest} does not list it`);
    }
  }

  // Same side only. Two protocol paths that fold to one key mean the descriptor lists
  // the same file twice under different spellings, whichever host this is.
  const keys = new Map();
  for (const artifact of indexed) {
    const key = normalizeArtifactKey(artifact);
    const incumbent = keys.get(key);
    if (incumbent !== undefined && incumbent !== artifact) {
      errors.push(`${CONTEXT_FILES.contextManifest} lists both ${incumbent} and ${artifact}`);
      continue;
    }
    keys.set(key, artifact);
  }

  // Step 4. Shape first and without a try/catch: a protocol violation comes back as a
  // reason, and a permission or IO fault has to keep travelling to the CLI rather than
  // be reported as "this pack was tampered with".
  for (const [key, entry] of entries) {
    const shape = await checkArtifactShape({
      value: entry.artifact,
      expectedRoot: CONTEXT_DIR,
      artifactRoot
    });
    if (!shape.ok) {
      errors.push(
        `${CONTEXT_FILES.contextManifest} entry ${key} artifact ${entry.artifact} ${shape.reason}`
      );
      continue;
    }
    if ((await hashOf(entry.artifact)) !== entry.sha256) {
      errors.push(
        `${CONTEXT_FILES.contextManifest} entry ${key} artifact ${entry.artifact} does not match its recorded sha256`
      );
    }
  }

  // Step 5. The canonical path comes first so a role pointed at another role's bytes is
  // refused before anything joins or reads it. A matching hash next to a swapped path
  // is not an equivalent claim, it is drift: whoever renamed the file missed one of the
  // two places that name it.
  for (const role of RECONCILED_CONTEXT_ROLES) {
    const reference = manifest.context[role];
    if (reference === null || reference === undefined) {
      continue;
    }

    const canonical = contextArtifactPath(CONTEXT_ROLE_FILES[role]);
    if (reference.artifact !== canonical) {
      errors.push(
        `context.${role}.artifact ${reference.artifact} is not the canonical path ${canonical}`
      );
      continue;
    }

    const shape = await checkArtifactShape({
      value: canonical,
      expectedRoot: CONTEXT_DIR,
      artifactRoot
    });
    if (!shape.ok) {
      errors.push(`context.${role}.artifact ${canonical} ${shape.reason}`);
      continue;
    }

    const occurrences = indexed.filter((artifact) => artifact === canonical).length;
    if (occurrences !== 1) {
      errors.push(
        `context.${role}.artifact ${canonical} appears ${occurrences} times in ${CONTEXT_FILES.contextManifest}`
      );
      continue;
    }

    if (reference.sha256 !== (await hashOf(canonical))) {
      errors.push(`context.${role} sha256 does not match the bytes of ${canonical}`);
    }
  }

  // Step 6. The descriptor takes two judgements of its own and joins neither set: it is
  // pinned to one canonical name and to its own bytes, which needs no membership.
  if (claim !== CONTEXT_MANIFEST_PATH) {
    errors.push(
      `context.contextManifest.artifact ${claim} is not the canonical path ${CONTEXT_MANIFEST_PATH}`
    );
  } else if (
    manifest.context.contextManifest.sha256 !==
    createHash("sha256").update(descriptorBytes).digest("hex")
  ) {
    errors.push(`context.contextManifest sha256 does not match the bytes of ${CONTEXT_MANIFEST_PATH}`);
  }

  return errors;
}

async function enumerateContextFiles(contextRoot, accept) {
  try {
    return await enumerateFiles(contextRoot, CONTEXT_DIR, accept);
  } catch (error) {
    if (INTEGRITY_ERRNOS.has(error.code)) {
      // No context directory: a run that froze no context is the common case, and a
      // manifest that claims one it never wrote is already caught by the reference walk.
      return [];
    }
    throw error;
  }
}
