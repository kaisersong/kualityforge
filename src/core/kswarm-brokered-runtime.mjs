import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  initializeArtifactRoot,
  loadManifestFromArtifactRoot,
  saveManifestToArtifactRoot
} from "./artifact-root.mjs";
import {
  recordCheckResult,
  recordDecisionMarkdown,
  recordVerificationMarkdown,
  synthesizeArtifactRoot,
  writeReviewFileToArtifactRoot
} from "./artifact-operations.mjs";
import { reduceQualityGate } from "./gate-reducer.mjs";
import { deriveRole, isReviewPolicyEnabled, validateReviewPolicyShape } from "./review-policy.mjs";
import {
  KSWARM_RUNTIME_PLAN_KIND,
  createKswarmReviewerNodeInput,
  mapGateResultToKswarmTerminal
} from "./kswarm-workflow.mjs";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 1800000;

export async function runKswarmBrokeredRuntimePlan(options = {}) {
  const preview = requireObject(options.preview, "preview");
  const runtimePlan = requireObject(options.runtimePlan, "runtimePlan");
  if (runtimePlan.kind !== KSWARM_RUNTIME_PLAN_KIND) {
    throw new Error(`unsupported runtime plan kind: ${runtimePlan.kind || "unknown"}`);
  }
  if (typeof options.reviewerRunner === "function") {
    throw new Error("brokered runtime must not run a local reviewerRunner; reviewers are dispatched by KSwarm");
  }

  const kswarmClient = requireObject(options.kswarmClient, "kswarmClient");
  const decisionProvider = options.decisionProvider || null;
  const checkRunner = options.checkRunner || null;
  const verifierRunner = options.verifierRunner || null;
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const projectId = runtimePlan.projectId;

  const reviewPolicy = isReviewPolicyEnabled(options.policy) ? options.policy.review : null;
  let requiredSet = null;
  let quorumSet = null;
  if (reviewPolicy) {
    const legacyMin =
      options.policy && options.policy.minReviewers !== undefined ? options.policy.minReviewers : null;
    const shapeErrors = validateReviewPolicyShape(reviewPolicy, legacyMin);
    if (shapeErrors.length > 0) {
      throw new Error(`invalid review policy: ${shapeErrors.join("; ")}`);
    }
    requiredSet = new Set(reviewPolicy.requiredReviewers);
    const advisorySet = new Set(reviewPolicy.advisoryReviewers || []);
    quorumSet = new Set(reviewPolicy.quorumMembers || reviewPolicy.requiredReviewers);
    const knownSet = new Set([...requiredSet, ...advisorySet]);
    const dispatchSet = new Set(runtimePlan.reviewers.map((reviewer) => reviewer.runnerId));
    for (const runnerId of dispatchSet) {
      if (!knownSet.has(runnerId)) {
        throw new Error(`runtime plan dispatches unknown reviewer ${runnerId} (not in policy.review)`);
      }
    }
    for (const runnerId of knownSet) {
      if (!dispatchSet.has(runnerId)) {
        throw new Error(`runtime plan does not dispatch expected reviewer ${runnerId}`);
      }
    }
  }

  const proposal = await kswarmClient.createScriptWorkflowProposal(projectId, preview, {
    requestedBy: preview.requestedBy || "human"
  });
  const proposalId = proposal?.workflowProposal?.id;
  if (!proposalId) {
    throw new Error("createScriptWorkflowProposal failed: workflowProposal.id is required");
  }

  const started = await kswarmClient.startScriptWorkflowRunFromProposal(projectId, proposalId, {
    approvedBy: preview.requestedBy || "human"
  });
  const workflowRunId = started?.workflowRun?.id;
  if (!workflowRunId) {
    throw new Error("startScriptWorkflowRunFromProposal failed: workflowRun.id is required");
  }

  await initializeArtifactRoot(runtimePlan.artifactRoot, {
    runId: runtimePlan.runId,
    profile: runtimePlan.profile || "release",
    context: createContextOptions(runtimePlan)
  });

  const parallelOperation = runtimePlan.operations.find((operation) => operation.type === "begin_parallel_group");
  const parallelGroupResult = await kswarmClient.beginWorkflowScriptParallelGroup(projectId, workflowRunId, {
    phaseTitle: parallelOperation?.phaseTitle || "Parallel Review",
    label: parallelOperation?.label || "KualityForge reviewer fan-out",
    primitiveId: parallelOperation?.primitiveId || "reviewer-fanout",
    totalCount: runtimePlan.reviewers.length,
    limit: parallelOperation?.limit || runtimePlan.reviewers.length,
    failurePolicy: parallelOperation?.failurePolicy || "required_all"
  });
  const parallelGroupId = parallelGroupResult?.parallelGroup?.id;
  if (!parallelGroupId) {
    throw new Error("beginWorkflowScriptParallelGroup failed: parallelGroup.id is required");
  }

  const expectedReviewers = [];
  for (const reviewer of runtimePlan.reviewers) {
    const role = requiredSet ? deriveRole(reviewer.runnerId, requiredSet) : "required";
    const quorumMember = quorumSet ? quorumSet.has(reviewer.runnerId) : true;
    const nodeInput = createKswarmReviewerNodeInput({
      runId: runtimePlan.runId,
      artifactRoot: runtimePlan.artifactRoot,
      runnerId: reviewer.runnerId,
      target: runtimePlan.target,
      outputArtifact: reviewer.outputArtifact,
      parallelGroupId,
      reviewerRole: role,
      quorumMember,
      required: role === "required",
      lang: options.lang
    });
    const dispatched = await kswarmClient.dispatchWorkflowScriptAgentNode(projectId, workflowRunId, nodeInput);
    const nodeId = dispatched?.nodeId;
    if (!nodeId) {
      throw new Error(`dispatchWorkflowScriptAgentNode failed for ${reviewer.runnerId}: nodeId is required`);
    }
    const dispatchInfo = firstDispatch(dispatched);
    expectedReviewers.push({
      reviewer,
      nodeId,
      role,
      quorumMember,
      attempt: dispatchInfo?.attempt,
      handoffId: dispatchInfo?.handoffId,
      outputArtifact: reviewer.outputArtifact
    });
  }

  const expectedNodeIds = new Set(expectedReviewers.map((entry) => entry.nodeId));
  const startedAt = now();
  let workflowRun = null;
  for (;;) {
    const runResult = await kswarmClient.getWorkflowRun(projectId, workflowRunId);
    workflowRun = runResult?.workflowRun || null;
    const ready = reviewPolicy
      ? allNodesTerminal(workflowRun, expectedNodeIds)
      : allNodesCompleted(workflowRun, expectedNodeIds);
    if (ready) {
      break;
    }
    if (now() - startedAt >= timeoutMs) {
      throw new Error(
        `timed out waiting for reviewer nodes to complete after ${timeoutMs}ms (workflowRun ${workflowRunId})`
      );
    }
    await sleep(pollIntervalMs);
  }

  const nodeStatusMap = buildNodeStatusMap(workflowRun, expectedNodeIds);

  const reviewerResults = [];
  let reviewOutcomes = null;

  if (!reviewPolicy) {
    for (const entry of expectedReviewers) {
      const artifactPath = join(runtimePlan.artifactRoot, entry.outputArtifact);
      try {
        await access(artifactPath);
      } catch {
        throw new Error(
          `reviewer ${entry.reviewer.runnerId} node completed but artifact is missing: ${entry.outputArtifact}`
        );
      }
      const artifact = await writeReviewFileToArtifactRoot(runtimePlan.artifactRoot, artifactPath, {
        expectedRunnerId: entry.reviewer.runnerId,
        artifact: entry.outputArtifact
      });
      reviewerResults.push({ reviewer: entry.reviewer, nodeId: entry.nodeId, artifact });
    }
  } else {
    const outcomes = [];
    for (const entry of expectedReviewers) {
      const runnerId = entry.reviewer.runnerId;
      const nodeStatus = nodeStatusMap.get(entry.nodeId);
      const isRequired = entry.role === "required";
      const artifactPath = join(runtimePlan.artifactRoot, entry.outputArtifact);

      if (nodeStatus === "failed" || nodeStatus === "blocked") {
        if (isRequired) {
          throw new Error(
            `required reviewer ${runnerId} node ${nodeStatus}; stopping without completing the run`
          );
        }
        outcomes.push({
          runnerId,
          role: entry.role,
          quorumMember: entry.quorumMember,
          nodeId: entry.nodeId,
          status: "failed",
          absenceReason: `node ${nodeStatus}`
        });
        continue;
      }

      let hasArtifact = true;
      try {
        await access(artifactPath);
      } catch {
        hasArtifact = false;
      }

      if (!hasArtifact) {
        if (isRequired) {
          throw new Error(
            `required reviewer ${runnerId} node completed but artifact is missing: ${entry.outputArtifact}`
          );
        }
        outcomes.push({
          runnerId,
          role: entry.role,
          quorumMember: entry.quorumMember,
          nodeId: entry.nodeId,
          status: "skipped",
          absenceReason: "node completed but artifact is missing"
        });
        continue;
      }

      let artifact;
      try {
        artifact = await writeReviewFileToArtifactRoot(runtimePlan.artifactRoot, artifactPath, {
          expectedRunnerId: runnerId,
          artifact: entry.outputArtifact
        });
      } catch (error) {
        if (/runnerId mismatch/.test(error.message)) {
          throw error;
        }
        if (isRequired) {
          throw error;
        }
        outcomes.push({
          runnerId,
          role: entry.role,
          quorumMember: entry.quorumMember,
          nodeId: entry.nodeId,
          status: "failed",
          absenceReason: `artifact parse failure: ${error.message}`
        });
        continue;
      }

      reviewerResults.push({ reviewer: entry.reviewer, nodeId: entry.nodeId, artifact });
      outcomes.push({
        runnerId,
        role: entry.role,
        quorumMember: entry.quorumMember,
        nodeId: entry.nodeId,
        status: "succeeded"
      });
    }

    outcomes.sort((a, b) => a.runnerId.localeCompare(b.runnerId));
    reviewOutcomes = outcomes;
    await persistReviewMetadata(runtimePlan.artifactRoot, reviewPolicy, outcomes);
  }

  const synthesis = await synthesizeArtifactRoot(runtimePlan.artifactRoot, { lang: options.lang });

  const decisionOperation = runtimePlan.operations.find((operation) => operation.type === "request_human_decision");
  if (decisionOperation?.required && typeof decisionProvider !== "function") {
    throw new Error("decisionProvider is required by runtime plan");
  }
  let decision = null;
  if (typeof decisionProvider === "function") {
    const markdown = normalizeMarkdownResult(
      await decisionProvider({ artifactRoot: runtimePlan.artifactRoot, summaryArtifact: synthesis.artifact, runtimePlan }),
      "decisionProvider"
    );
    decision = await recordDecisionMarkdown(runtimePlan.artifactRoot, markdown);
  }

  const checkOperation = runtimePlan.operations.find((operation) => operation.type === "run_required_checks");
  if (checkOperation?.required && typeof checkRunner !== "function") {
    throw new Error("checkRunner is required by runtime plan");
  }
  const checks = [];
  if (typeof checkRunner === "function") {
    for (const check of await checkRunner({ artifactRoot: runtimePlan.artifactRoot, runtimePlan })) {
      checks.push(await recordCheckResult(runtimePlan.artifactRoot, check.name, check.status, { log: check.log }));
    }
  }

  let verification = null;
  if (typeof verifierRunner === "function") {
    const verifierOutput = await verifierRunner({ artifactRoot: runtimePlan.artifactRoot, runtimePlan });
    const markdown = normalizeMarkdownResult(verifierOutput, "verifierRunner");
    verification = await recordVerificationMarkdown(runtimePlan.artifactRoot, markdown, {
      runnerId: verifierOutput.runnerId,
      status: verifierOutput.status || "verified"
    });
  }

  const { manifest } = await loadManifestFromArtifactRoot(runtimePlan.artifactRoot);
  const gate = reduceQualityGate(manifest, options.policy);
  const terminal = mapGateResultToKswarmTerminal(gate, { artifactRoot: runtimePlan.artifactRoot });
  const completionResult = buildKswarmGateResult(gate, runtimePlan.artifactRoot, manifest);
  const completion = await kswarmClient.completeScriptWorkflowRun(projectId, workflowRunId, {
    result: completionResult,
    terminal
  });

  if (completion && completion.ok === false) {
    const code = completion.code || completion.error || "unknown";
    if (/workflow_script_nodes_incomplete/.test(String(code))) {
      throw new Error(
        `completeScriptWorkflowRun rejected: ${code}; not rewriting to a gate blocked result`
      );
    }
    throw new Error(`completeScriptWorkflowRun failed: ${code}`);
  }

  return {
    preview,
    runtimePlan,
    workflowProposal: proposal.workflowProposal,
    workflowRunId,
    parallelGroup: parallelGroupResult.parallelGroup,
    expectedReviewers,
    reviewerResults,
    reviewOutcomes,
    synthesis,
    decision,
    checks,
    verification,
    gate,
    terminal,
    completionResult,
    completion
  };
}

export function buildKswarmGateResult(gate, artifactRoot, manifest = {}) {
  const artifacts = [
    { path: `${artifactRoot}/manifest.json`, kind: "json", label: "KualityForge manifest" },
    { path: `${artifactRoot}/summary.md`, kind: "markdown", label: "KualityForge summary" }
  ];
  if (manifest.humanDecision?.artifact) {
    artifacts.push({
      path: `${artifactRoot}/${manifest.humanDecision.artifact}`,
      kind: "markdown",
      label: "Human decision"
    });
  }
  if (manifest.verification?.artifact) {
    artifacts.push({
      path: `${artifactRoot}/${manifest.verification.artifact}`,
      kind: "markdown",
      label: "Independent verification"
    });
  }

  return {
    status: gate.status,
    summary:
      gate.status === "passed" ? "KualityForge gate passed" : `KualityForge gate ${gate.status}`,
    artifactRoot,
    artifacts,
    evidenceRefs: artifacts.map((artifact) => artifact.path),
    reasons: Array.isArray(gate.reasons) ? gate.reasons : []
  };
}

function allNodesCompleted(workflowRun, expectedNodeIds) {
  if (!workflowRun || expectedNodeIds.size === 0) {
    return false;
  }
  const nodes = Array.isArray(workflowRun.nodes) ? workflowRun.nodes : [];
  const completed = new Set();
  for (const node of nodes) {
    if (node && expectedNodeIds.has(node.id) && node.status === "completed") {
      completed.add(node.id);
    }
  }
  return completed.size === expectedNodeIds.size;
}

function allNodesTerminal(workflowRun, expectedNodeIds) {
  if (!workflowRun || expectedNodeIds.size === 0) {
    return false;
  }
  const nodes = Array.isArray(workflowRun.nodes) ? workflowRun.nodes : [];
  const terminal = new Set();
  for (const node of nodes) {
    if (node && expectedNodeIds.has(node.id) && ["completed", "failed", "blocked"].includes(node.status)) {
      terminal.add(node.id);
    }
  }
  return terminal.size === expectedNodeIds.size;
}

function buildNodeStatusMap(workflowRun, expectedNodeIds) {
  const map = new Map();
  const nodes = Array.isArray(workflowRun?.nodes) ? workflowRun.nodes : [];
  for (const node of nodes) {
    if (node && expectedNodeIds.has(node.id)) {
      map.set(node.id, node.status);
    }
  }
  return map;
}

async function persistReviewMetadata(artifactRoot, reviewPolicy, reviewOutcomes) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const reviewPolicyEcho = {
    mode: reviewPolicy.mode,
    requiredReviewers: [...(reviewPolicy.requiredReviewers || [])],
    quorumMembers: [...(reviewPolicy.quorumMembers || reviewPolicy.requiredReviewers || [])],
    advisoryReviewers: [...(reviewPolicy.advisoryReviewers || [])]
  };
  if (reviewPolicy.quorumMin !== undefined) {
    reviewPolicyEcho.quorumMin = reviewPolicy.quorumMin;
  }
  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    reviewPolicy: reviewPolicyEcho,
    reviewOutcomes
  });
}

function createContextOptions(runtimePlan) {
  if (
    !runtimePlan.projectRoot &&
    (!Array.isArray(runtimePlan.docsRoots) || runtimePlan.docsRoots.length === 0) &&
    !runtimePlan.qualityPrinciplesPath &&
    !runtimePlan.changeGoal &&
    !runtimePlan.changeset
  ) {
    return null;
  }

  return {
    projectRoot: runtimePlan.projectRoot,
    docsRoots: runtimePlan.docsRoots || [],
    qualityPrinciplesPath: runtimePlan.qualityPrinciplesPath,
    changeGoal: runtimePlan.changeGoal,
    ...(runtimePlan.changeset ? { changeset: runtimePlan.changeset } : {})
  };
}

function normalizeMarkdownResult(value, providerName) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value.markdown === "string") {
    return value.markdown;
  }
  throw new Error(`${providerName} must return markdown`);
}

function firstDispatch(dispatched) {
  return Array.isArray(dispatched?.dispatches) ? dispatched.dispatches[0] : null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return fallback;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}
