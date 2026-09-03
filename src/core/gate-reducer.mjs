import { evaluateReviewPolicy, isReviewPolicyEnabled } from "./review-policy.mjs";
import { isSafeArtifactPath, normalizeArtifactKey } from "./artifact-operations.mjs";
import { safeArtifactName } from "./review-artifact.mjs";
import { computeFindingSetDigest } from "./decision-artifact.mjs";
import { GATE_MARKERS, createDiagnosticSink } from "./gate-markers.mjs";
import { changesetRequired, changesetUsable } from "./changeset-usability.mjs";
import { MANIFEST_STATUSES, isManifestStatus } from "./manifest-status.mjs";
import { DEFAULT_RELEASE_POLICY, validatePolicyShape } from "./policy-shape.mjs";
import {
  FINDING_PRIORITIES,
  FINDING_STATUSES,
  MUST_CLEARED_STATUSES,
  SEVERITY_LEVELS,
  WARNING_STATUSES,
  isBlockingStatus,
  isFindingPriority,
  isFindingStatus,
  isSeverityLevel
} from "./finding-vocabulary.mjs";

export { DEFAULT_RELEASE_POLICY } from "./policy-shape.mjs";

const TERMINAL_FAILURE_STATUSES = new Set([
  "failed",
  "invalid_artifact",
  "verification_failed",
  "test_blocked",
  "cancelled"
]);

export function validateManifestShape(manifest, sink = createDiagnosticSink()) {
  const errors = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest must be an object"];
  }

  if (!manifest.runId || typeof manifest.runId !== "string") {
    errors.push("runId is required");
  }

  if (!manifest.status || typeof manifest.status !== "string") {
    errors.push("status is required");
  } else if (!isManifestStatus(manifest.status)) {
    errors.push(`status must be one of ${MANIFEST_STATUSES.join(", ")}`);
  }

  if (!Array.isArray(manifest.reviewers)) {
    errors.push("reviewers must be an array");
  }

  if (!Array.isArray(manifest.findings)) {
    errors.push("findings must be an array");
  }

  if (!Array.isArray(manifest.requiredChecks)) {
    errors.push("requiredChecks must be an array");
  }

  return [
    ...errors,
    ...validateReviewers(manifest, sink),
    ...validateFindings(manifest, sink),
    ...validateRequiredChecks(manifest),
    ...validateRunnerRecords(manifest),
    ...validateHumanDecision(manifest, sink),
    ...validateScoreRecords(manifest),
    ...validateArtifactReferences(manifest),
    ...validateContextArtifacts(manifest)
  ];
}

const REVIEWER_ROLES = ["required", "advisory"];

// Every entry below corresponds to a field the reducer or review policy reads.
// Absent subfields are pushed as errors instead of skipped, because a skipped
// field is exactly what let `reviewers: [{}, {}]` satisfy the quorum.
function validateReviewers(manifest, sink) {
  if (!Array.isArray(manifest.reviewers)) {
    return [];
  }

  const errors = [];
  const seenRunnerIds = new Map();
  const seenArtifacts = new Map();

  for (const [index, reviewer] of manifest.reviewers.entries()) {
    if (!isPlainObject(reviewer)) {
      errors.push(`reviewers[${index}] must be an object`);
      continue;
    }

    errors.push(...requireStrings(reviewer, `reviewers[${index}]`, ["runnerId", "artifact", "status"]));

    if (reviewer.role !== undefined && !REVIEWER_ROLES.includes(reviewer.role)) {
      errors.push(`reviewers[${index}].role must be one of ${REVIEWER_ROLES.join(", ")}`);
    }

    if (reviewer.isVacuous !== undefined && typeof reviewer.isVacuous !== "boolean") {
      errors.push(`reviewers[${index}].isVacuous must be a boolean`);
    }

    if (isNonEmptyString(reviewer.runnerId)) {
      if (seenRunnerIds.has(reviewer.runnerId)) {
        errors.push(`reviewers[${index}].runnerId duplicates reviewer ${reviewer.runnerId}`);
      } else {
        seenRunnerIds.set(reviewer.runnerId, index);
      }
    }

    if (isNonEmptyString(reviewer.artifact)) {
      const artifactKey = normalizeArtifactKey(reviewer.artifact);
      const owner = seenArtifacts.get(artifactKey);
      if (owner !== undefined) {
        errors.push(
          sink.mark(
            GATE_MARKERS.ARTIFACT_PATH_DUPLICATE,
            `reviewers[${index}].artifact "${reviewer.artifact}" is already claimed by reviewer "${owner}"`
          )
        );
      } else {
        seenArtifacts.set(artifactKey, reviewer.runnerId);
      }
    }
  }

  return [...errors, ...findArtifactNameCollisions(manifest.reviewers, sink)];
}

// Returns errors instead of throwing: an invalid manifest must stay a
// deterministic invalid_artifact verdict, not a CLI crash with a different exit
// code. The write boundary throws; the reducer never does.
export function findArtifactNameCollisions(reviewers, sink = createDiagnosticSink()) {
  const errors = [];
  const byArtifactName = new Map();

  for (const [index, reviewer] of (Array.isArray(reviewers) ? reviewers : []).entries()) {
    if (!isPlainObject(reviewer) || !isNonEmptyString(reviewer.runnerId)) {
      continue;
    }

    const name = safeArtifactName(reviewer.runnerId);
    if (name.length === 0) {
      errors.push(`reviewers[${index}].runnerId produces an empty artifact name`);
      continue;
    }

    const owner = byArtifactName.get(name);
    if (owner !== undefined && owner !== reviewer.runnerId) {
      errors.push(
        sink.mark(
          GATE_MARKERS.ARTIFACT_NAME_COLLISION,
          `reviewers[${index}].runnerId "${reviewer.runnerId}" collides with "${owner}" on artifact name "${name}"`
        )
      );
    }
    byArtifactName.set(name, reviewer.runnerId);
  }

  return errors;
}

function validateRequiredChecks(manifest) {
  if (!Array.isArray(manifest.requiredChecks)) {
    return [];
  }

  const errors = [];
  for (const [index, check] of manifest.requiredChecks.entries()) {
    if (!isPlainObject(check)) {
      errors.push(`requiredChecks[${index}] must be an object`);
      continue;
    }
    errors.push(...requireStrings(check, `requiredChecks[${index}]`, ["name", "status"]));
  }
  return errors;
}

function validateRunnerRecords(manifest) {
  const errors = [];
  if (manifest.verification !== undefined && manifest.verification !== null) {
    if (!isPlainObject(manifest.verification)) {
      errors.push("verification must be an object");
    } else {
      errors.push(...requireStrings(manifest.verification, "verification", ["runnerId", "status", "artifact"]));
    }
  }

  if (manifest.fixer !== undefined && manifest.fixer !== null) {
    if (!isPlainObject(manifest.fixer)) {
      errors.push("fixer must be an object");
    } else {
      errors.push(...requireStrings(manifest.fixer, "fixer", ["runnerId", "artifact"]));
    }
  }

  return errors;
}

function validateHumanDecision(manifest, sink) {
  const decision = manifest.humanDecision;
  if (decision === undefined || decision === null) {
    return [];
  }

  if (!isPlainObject(decision)) {
    return ["humanDecision must be an object"];
  }

  const errors = requireStrings(decision, "humanDecision", ["artifact", "status"]);
  if (!isNonEmptyString(decision.owner)) {
    errors.push(
      sink.mark(
        GATE_MARKERS.DECISION_OWNER_MISSING,
        "humanDecision.owner must be a non-empty string"
      )
    );
  }

  // A decision that failed to parse is a legitimate recorded state and blocks at
  // the gate layer; only a decision claiming to be parsed must carry the binding.
  if (decision.status === "parsed") {
    errors.push(...requireStrings(decision, "humanDecision", ["runId", "decidedAt"]));
    if (!isFindingSetDigest(decision.findingSetDigest)) {
      errors.push("humanDecision.findingSetDigest must be a sha256:<hex> digest");
    }
  }

  return errors;
}

function validateScoreRecords(manifest) {
  const errors = [];
  const scores = manifest.reviewerScores?.scores;
  if (Array.isArray(scores)) {
    for (const [index, score] of scores.entries()) {
      if (!isPlainObject(score)) {
        errors.push(`reviewerScores.scores[${index}] must be an object`);
      }
    }
  }

  if (Array.isArray(manifest.reviewOutcomes)) {
    for (const [index, outcome] of manifest.reviewOutcomes.entries()) {
      if (!isPlainObject(outcome)) {
        errors.push(`reviewOutcomes[${index}] must be an object`);
        continue;
      }
      errors.push(...requireStrings(outcome, `reviewOutcomes[${index}]`, ["runnerId"]));
    }
  }

  return errors;
}

function requireStrings(target, prefix, keys) {
  return keys
    .filter((key) => !isNonEmptyString(target[key]))
    .map((key) => `${prefix}.${key} must be a non-empty string`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isFindingSetDigest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value);
}

// Runs unconditionally, so plain flow gets the same source-attribution and
// vocabulary guarantees as a run with a review policy enabled.
function validateFindings(manifest, sink) {
  if (!Array.isArray(manifest.findings)) {
    return [];
  }

  const declaredRunnerIds = new Set(
    (Array.isArray(manifest.reviewers) ? manifest.reviewers : [])
      .map((reviewer) => reviewer?.runnerId)
      .filter((runnerId) => typeof runnerId === "string" && runnerId.length > 0)
  );

  const errors = [];
  const seenIds = new Set();
  for (const [index, finding] of manifest.findings.entries()) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      errors.push(`findings[${index}] must be an object`);
      continue;
    }

    // Verdicts and dispositions address findings by id, so a repeated id makes
    // "which finding did the human rule on" unanswerable.
    if (!isNonEmptyString(finding.id)) {
      errors.push(`findings[${index}].id must be a non-empty string`);
    } else if (seenIds.has(finding.id)) {
      errors.push(
        sink.mark(
          GATE_MARKERS.FINDING_ID_DUPLICATE,
          `findings[${index}].id duplicates finding ${finding.id}`
        )
      );
    } else {
      seenIds.add(finding.id);
    }

    if (finding.sourceRunnerId !== undefined && !isNonEmptyString(finding.sourceRunnerId)) {
      errors.push(`findings[${index}].sourceRunnerId must be a non-empty string`);
    }

    if (Array.isArray(finding.sourceRunnerIds)) {
      for (const [position, runnerId] of finding.sourceRunnerIds.entries()) {
        if (!isNonEmptyString(runnerId)) {
          errors.push(`findings[${index}].sourceRunnerIds[${position}] must be a non-empty string`);
        }
      }
    }

    // The type checks above cannot see an absent field, and the undeclared-source
    // loop below iterates the empty list zero times. Without this error a finding
    // no reviewer claims passes every source-attribution check there is.
    const sources = findingSources(finding);
    if (sources.length === 0) {
      errors.push(`findings[${index}] has no source runner`);
    }

    if (finding.severity !== undefined && !isSeverityLevel(finding.severity)) {
      errors.push(`findings[${index}].severity must be one of ${SEVERITY_LEVELS.join(", ")}`);
    }

    if (
      finding.priority !== undefined &&
      finding.priority !== null &&
      !isFindingPriority(finding.priority)
    ) {
      errors.push(`findings[${index}].priority must be one of ${FINDING_PRIORITIES.join(", ")}`);
    }

    if (finding.status !== undefined && !isFindingStatus(finding.status)) {
      errors.push(
        sink.mark(
          GATE_MARKERS.UNKNOWN_FINDING_STATUS,
          `findings[${index}].status must be one of ${FINDING_STATUSES.join(", ")}`
        )
      );
    }

    for (const runnerId of sources) {
      if (!declaredRunnerIds.has(runnerId)) {
        errors.push(
          sink.mark(
            GATE_MARKERS.SOURCE_RUNNER_UNDECLARED,
            `findings[${index}] cites undeclared reviewer ${runnerId}`
          )
        );
      }
    }
  }

  return errors;
}

export function validateArtifactReferences(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [];
  }

  const errors = [];
  for (const [index, reviewer] of (manifest.reviewers || []).entries()) {
    if (reviewer?.artifact && !isSafeArtifactPath(reviewer.artifact)) {
      errors.push(`reviewers[${index}].artifact must stay within artifact root`);
    }
  }

  if (manifest.humanDecision?.artifact && !isSafeArtifactPath(manifest.humanDecision.artifact)) {
    errors.push("humanDecision.artifact must stay within artifact root");
  }

  if (manifest.verification?.artifact && !isSafeArtifactPath(manifest.verification.artifact)) {
    errors.push("verification.artifact must stay within artifact root");
  }

  if (manifest.synthesis?.artifact && !isSafeArtifactPath(manifest.synthesis.artifact)) {
    errors.push("synthesis.artifact must stay within artifact root");
  }

  if (manifest.reviewerScores?.artifact && !isSafeArtifactPath(manifest.reviewerScores.artifact)) {
    errors.push("reviewerScores.artifact must stay within artifact root");
  }

  if (manifest.inducedPrinciples?.artifact && !isSafeArtifactPath(manifest.inducedPrinciples.artifact)) {
    errors.push("inducedPrinciples.artifact must stay within artifact root");
  }

  if (manifest.fixer?.artifact && !isSafeArtifactPath(manifest.fixer.artifact)) {
    errors.push("fixer.artifact must stay within artifact root");
  }

  for (const [index, check] of (manifest.requiredChecks || []).entries()) {
    if (check?.log && !isSafeArtifactPath(check.log)) {
      errors.push(`requiredChecks[${index}].log must stay within artifact root`);
    }
  }

  return errors;
}

function validateContextArtifacts(manifest) {
  const errors = [];
  const context = manifest.context;
  if (!context) {
    return errors;
  }

  for (const key of [
    "contextManifest",
    "qualityPrinciples",
    "projectContext",
    "projectBrief",
    "docsIndex",
    "changeset",
    "structureScan"
  ]) {
    const item = context[key];
    if (!item) {
      continue;
    }

    if (item.artifact && !isSafeArtifactPath(item.artifact)) {
      errors.push(`context.${key}.artifact must stay within artifact root`);
    }

    if (item.sha256 && !isSha256HexDigest(item.sha256)) {
      errors.push(`context.${key}.sha256 must be a sha256 hex digest`);
    }
  }

  return errors;
}

export function reduceQualityGate(manifest, policy = DEFAULT_RELEASE_POLICY, { integrityErrors = [] } = {}) {
  const policySource = policy ?? {};
  const sink = createDiagnosticSink();
  const shapeErrors = [
    ...validateManifestShape(manifest, sink),
    ...validatePolicyShape(policySource),
    ...integrityErrors
  ];
  if (shapeErrors.length > 0) {
    return failure("invalid_artifact", shapeErrors, sink.entries);
  }
  const effectivePolicy = mergePolicy(policySource);

  if (TERMINAL_FAILURE_STATUSES.has(manifest.status)) {
    return failure("failed", [`manifest status is ${manifest.status}`], []);
  }

  const blockers = [];
  const warnings = [];

  if (isReviewPolicyEnabled(effectivePolicy)) {
    const reviewResult = evaluateReviewPolicy(manifest, effectivePolicy);
    if (reviewResult.invalid) {
      return failure("invalid_artifact", reviewResult.invalid, sink.entries);
    }
    blockers.push(...reviewResult.blockers);
    warnings.push(...reviewResult.warnings);
  } else {
    const reviewerCount = manifest.reviewers.filter(
      (reviewer) =>
        reviewer.status === "completed" &&
        !isAdvisoryReviewer(reviewer.runnerId, effectivePolicy)
    ).length;
    if (reviewerCount < effectivePolicy.minReviewers) {
      blockers.push(
        `reviewer shortage: expected at least ${effectivePolicy.minReviewers}, got ${reviewerCount}`
      );
    }
  }

  // isVacuous is set by writeReviewMarkdownToArtifactRoot during artifact write;
  // the manifest is the gate's authoritative evidence source.
  for (const reviewer of manifest.reviewers) {
    if (reviewer.isVacuous === true) {
      const isAdvisory = isReviewPolicyEnabled(effectivePolicy) &&
        isAdvisoryReviewer(reviewer.runnerId, effectivePolicy);
      if (isAdvisory) {
        warnings.push(`advisory reviewer ${reviewer.runnerId} produced vacuous output`);
      } else {
        blockers.push(`required reviewer ${reviewer.runnerId} produced vacuous output`);
      }
    }
  }

  if (effectivePolicy.requireHumanDecision) {
    const decision = manifest.humanDecision;
    if (!decision) {
      blockers.push("human decision artifact is required");
    } else if (decision.status !== "parsed") {
      const message = `human decision artifact is ${decision.status || "missing a decision block"}`;
      blockers.push(
        decision.status === "unparsed" ? sink.mark(GATE_MARKERS.DECISION_UNPARSED, message) : message
      );
    } else {
      if (decision.runId !== manifest.runId) {
        blockers.push(
          `human decision runId ${decision.runId} does not match run ${manifest.runId}`
        );
      }
      const currentDigest = computeFindingSetDigest(manifest.findings);
      if (decision.findingSetDigest !== currentDigest) {
        blockers.push(
          sink.mark(
            GATE_MARKERS.DECISION_DIGEST_MISMATCH,
            "human decision findingSetDigest does not match the current finding set"
          )
        );
      }
    }
  }

  const reviewEnabled = isReviewPolicyEnabled(effectivePolicy);
  const requiredReviewerSet = reviewEnabled
    ? new Set(effectivePolicy.review.requiredReviewers || [])
    : null;
  const isAdvisoryFinding = (finding) => {
    if (!reviewEnabled) {
      return false;
    }
    const sources = findingSources(finding);
    if (sources.length === 0) {
      return false;
    }
    return sources.every((runnerId) => !requiredReviewerSet.has(runnerId));
  };

  // Blacklist direction: a status only stops blocking if it is an explicit
  // release outcome, so an unknown or newly added status fails closed.
  const openFindings = manifest.findings.filter((finding) => isBlockingStatus(finding.status));
  const blockingOpenFindings = openFindings.filter((finding) => !isAdvisoryFinding(finding));
  const advisoryOpenFindings = openFindings.filter((finding) => isAdvisoryFinding(finding));
  if (blockingOpenFindings.length > 0) {
    blockers.push(`unresolved findings: ${blockingOpenFindings.map((f) => f.id).join(", ")}`);
  }
  for (const finding of advisoryOpenFindings) {
    warnings.push(`advisory finding (non-blocking): ${finding.id}`);
  }

  for (const finding of manifest.findings) {
    if (WARNING_STATUSES.includes(finding.status)) {
      warnings.push(`finding ${finding.id} released as ${finding.status}`);
    }
  }

  // Keyed on priority alone: a misspelled or reclassified type must not let a
  // must-priority finding slip past the gate.
  const unresolvedMustFindings = manifest.findings.filter((finding) => {
    return (
      finding.priority === "must" &&
      !MUST_CLEARED_STATUSES.includes(finding.status) &&
      !isAdvisoryFinding(finding)
    );
  });
  if (unresolvedMustFindings.length > 0) {
    blockers.push(
      `unresolved must findings: ${unresolvedMustFindings
        .map((finding) => finding.id)
        .join(", ")}`
    );
  }

  if (effectivePolicy.requireRequiredChecks) {
    if (manifest.requiredChecks.length === 0) {
      blockers.push(
        "requiredChecks is empty while requireRequiredChecks is enabled; no check evidence means the requirement is unproven, not satisfied"
      );
    }
    const failedChecks = manifest.requiredChecks.filter((check) => check.status !== "passed");
    if (failedChecks.length > 0) {
      blockers.push(`required checks not passed: ${failedChecks.map((c) => c.name).join(", ")}`);
    }
  }

  if (!manifest.verification) {
    blockers.push("verification artifact is required");
  } else {
    // "disputed" is not a verdict on the run: the per-finding adjudication below
    // decides. Every other non-verified status means insufficient evidence.
    if (!["verified", "disputed"].includes(manifest.verification.status)) {
      blockers.push(`verification status is ${manifest.verification.status}`);
    }

    const findingById = new Map(manifest.findings.map((finding) => [finding.id, finding]));
    const stillBlocking = (id) => {
      const finding = findingById.get(id);
      return Boolean(finding) && isBlockingStatus(finding.status) && !isAdvisoryFinding(finding);
    };

    const uncovered = asIdList(manifest.verification.uncoveredOpenFindingIds).filter(stillBlocking);
    if (uncovered.length > 0) {
      blockers.push(
        sink.mark(
          GATE_MARKERS.VERDICT_COVERAGE_INCOMPLETE,
          `verification did not cover open findings: ${uncovered.join(", ")}`
        )
      );
    }

    for (const id of asIdList(manifest.verification.disputedFindings)) {
      if (stillBlocking(id)) {
        blockers.push(`verifier disputes unresolved finding ${id}`);
      } else {
        warnings.push(`verifier disputed finding ${id} after a human ruling`);
      }
    }
  }

  if (effectivePolicy.requireIndependentVerifier && manifest.verification) {
    if (!manifest.fixer) {
      // A fixed finding means someone did the fixing. With no fixer on record
      // there is nothing to compare the verifier against, which is unproven
      // rather than satisfied.
      const fixEvidence = manifest.findings.some((finding) =>
        ["fixed", "verification_failed"].includes(finding.status)
      );
      if (fixEvidence) {
        blockers.push("fix evidence present but no fixer record: verifier independence unprovable");
      } else {
        warnings.push("verifier independence not applicable: no fix recorded");
      }
    } else if (manifest.verification.runnerId === manifest.fixer.runnerId) {
      blockers.push("verifier runner must be independent from fixer runner");
    }
  }

  blockers.push(...contextBlockers(manifest, effectivePolicy.context));

  const minReviewerScore = effectivePolicy.review?.minReviewerScore;
  if (typeof minReviewerScore === "number" && Number.isFinite(minReviewerScore)) {
    const inlineScores = Array.isArray(manifest.reviewerScores?.scores)
      ? manifest.reviewerScores.scores
      : [];
    for (const score of inlineScores) {
      if (typeof score.overall === "number" && score.overall < minReviewerScore) {
        warnings.push(
          `reviewer ${score.runnerId} score ${score.overall} below advisory threshold ${minReviewerScore}`
        );
      }
    }
  }

  if (blockers.length > 0) {
    return {
      status: "incomplete",
      exitCode: 2,
      reasons: blockers,
      warnings: [...warnings].sort(),
      diagnostics: sink.entries
    };
  }

  return {
    status: "passed",
    exitCode: 0,
    reasons: [],
    warnings: [...warnings].sort(),
    diagnostics: sink.entries
  };
}

function contextBlockers(manifest, contextPolicy) {
  const blockers = [];
  const context = manifest.context;

  // Unconditional and keyed only on reviewType: a policy override that could switch
  // this off would leave the criterion worth nothing, because the runs that most need
  // a freeze are exactly the ones whose policy someone relaxed. An absent reviewType
  // resolves to changeset, the stricter of the two modes.
  if (changesetRequired(manifest.reviewType)) {
    // `available` is derived from context/changeset.json by the gate's IO layer. The
    // reference on the manifest exists whenever a project root does, so judging the
    // reference itself would pass a run whose freeze failed.
    const { usable } = changesetUsable(context?.changeset);
    if (!usable) {
      blockers.push("frozen changeset is required and is not usable");
    } else if (context.changeset.deterministicEnvDegraded === true) {
      blockers.push("frozen changeset deterministic git isolation degraded");
    }
  } else {
    // full-project is an explicit mode switch, not a way to shed evidence: what it
    // swaps in is a context pack it must actually have. Both of these are written
    // unconditionally by buildContextPack, so requiring them cannot misfire —
    // qualityPrinciples deliberately stays out, since nothing on the review path
    // produces it and requiring it would reject every honest run.
    if (!context?.projectContext?.artifact) {
      blockers.push("full-project review requires a projectContext artifact");
    }
    if (!context?.projectBrief?.artifact) {
      blockers.push("full-project review requires a projectBrief artifact");
    }
  }

  if (contextPolicy.qualityPrinciplesRequired && !context?.qualityPrinciples?.artifact) {
    blockers.push("quality principles artifact is required");
  }

  if (contextPolicy.projectContextRequired && !context?.projectContext?.artifact) {
    blockers.push("project context artifact is required");
  }

  if (contextPolicy.projectBriefRequired && !context?.projectBrief?.artifact) {
    blockers.push("project brief artifact is required");
  }

  const requiredAck = contextPolicy.requiredReviewerContextAck || [];
  if (requiredAck.length > 0) {
    for (const reviewer of manifest.reviewers) {
      const missing = requiredAck.filter((key) => reviewer.contextRead?.[key] !== true);
      if (missing.length > 0) {
        blockers.push(
          `reviewer ${reviewer.runnerId} did not acknowledge context: ${missing.join(", ")}`
        );
      }
    }
  }

  const expectedContextManifestHash = context?.contextManifest?.sha256;
  if (contextPolicy.requireReviewerContextProvenance && !expectedContextManifestHash) {
    blockers.push("context manifest hash is required for reviewer provenance");
  }

  for (const reviewer of manifest.reviewers) {
    if (reviewer.contextConfidence === "low") {
      blockers.push(`reviewer ${reviewer.runnerId} context confidence is low`);
    }

    if (contextPolicy.requireReviewerContextProvenance) {
      const actualHash = reviewer.contextProvenance?.contextManifestHash;
      if (!actualHash) {
        blockers.push(`reviewer ${reviewer.runnerId} context provenance is required`);
      } else if (expectedContextManifestHash && actualHash !== expectedContextManifestHash) {
        blockers.push(
          `reviewer ${reviewer.runnerId} context provenance does not match context manifest`
        );
      }
    }
  }

  return blockers;
}

function isAdvisoryReviewer(runnerId, policy) {
  const advisorySet = new Set(policy.review?.advisoryReviewers || []);
  return advisorySet.has(runnerId);
}

function mergePolicy(policy) {
  const source = policy ?? {};
  return {
    ...DEFAULT_RELEASE_POLICY,
    ...source,
    context: {
      ...DEFAULT_RELEASE_POLICY.context,
      ...(source.context || {})
    }
  };
}

function findingSources(finding) {
  const sources = new Set();
  if (typeof finding.sourceRunnerId === "string" && finding.sourceRunnerId.length > 0) {
    sources.add(finding.sourceRunnerId);
  }
  for (const runnerId of Array.isArray(finding.sourceRunnerIds) ? finding.sourceRunnerIds : []) {
    if (typeof runnerId === "string" && runnerId.length > 0) {
      sources.add(runnerId);
    }
  }
  return [...sources];
}

function asIdList(value) {
  return (Array.isArray(value) ? value : []).filter(
    (id) => typeof id === "string" && id.length > 0
  );
}

function isSha256HexDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function failure(status, reasons, diagnostics) {
  return {
    status,
    exitCode: 1,
    reasons,
    warnings: [],
    diagnostics
  };
}
