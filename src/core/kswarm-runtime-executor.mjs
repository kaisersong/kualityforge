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
  writeReviewMarkdownToArtifactRoot
} from "./artifact-operations.mjs";
import { reduceQualityGate } from "./gate-reducer.mjs";
import { deriveRole, isReviewPolicyEnabled, validateReviewPolicyShape } from "./review-policy.mjs";
import {
  KSWARM_RUNTIME_PLAN_KIND,
  createKswarmReviewerNodeInput,
  mapGateResultToKswarmTerminal
} from "./kswarm-workflow.mjs";

export async function runKswarmRuntimePlan(options = {}) {
  const preview = requireObject(options.preview, "preview");
  const runtimePlan = requireObject(options.runtimePlan, "runtimePlan");
  if (runtimePlan.kind !== KSWARM_RUNTIME_PLAN_KIND) {
    throw new Error(`unsupported runtime plan kind: ${runtimePlan.kind || "unknown"}`);
  }

  const kswarmClient = requireObject(options.kswarmClient, "kswarmClient");
  const reviewerRunner = requireFunction(options.reviewerRunner, "reviewerRunner");
  const decisionProvider = options.decisionProvider || null;
  const checkRunner = options.checkRunner || null;
  const verifierRunner = options.verifierRunner || null;
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

  const proposal = await expectOk(
    "createScriptWorkflowProposal",
    kswarmClient.createScriptWorkflowProposal(projectId, preview, {
      requestedBy: preview.requestedBy || "human"
    })
  );
  const proposalId = proposal.workflowProposal?.id;
  if (!proposalId) {
    throw new Error("createScriptWorkflowProposal failed: workflowProposal.id is required");
  }

  const started = await expectOk(
    "startScriptWorkflowRunFromProposal",
    kswarmClient.startScriptWorkflowRunFromProposal(projectId, proposalId, {
      approvedBy: preview.requestedBy || "human"
    })
  );
  const workflowRunId = started.workflowRun?.id;
  if (!workflowRunId) {
    throw new Error("startScriptWorkflowRunFromProposal failed: workflowRun.id is required");
  }

  await initializeArtifactRoot(runtimePlan.artifactRoot, {
    runId: runtimePlan.runId,
    profile: runtimePlan.profile || "release",
    context: createContextOptions(runtimePlan)
  });

  const parallelOperation = runtimePlan.operations.find((operation) => operation.type === "begin_parallel_group");
  const parallelGroupResult = await expectOk(
    "beginWorkflowScriptParallelGroup",
    kswarmClient.beginWorkflowScriptParallelGroup(projectId, workflowRunId, {
      phaseTitle: parallelOperation?.phaseTitle || "Parallel Review",
      label: parallelOperation?.label || "KualityForge reviewer fan-out",
      primitiveId: parallelOperation?.primitiveId || "reviewer-fanout",
      totalCount: runtimePlan.reviewers.length,
      limit: parallelOperation?.limit || runtimePlan.reviewers.length,
      failurePolicy: parallelOperation?.failurePolicy || "required_all"
    })
  );
  const parallelGroupId = parallelGroupResult.parallelGroup?.id;
  if (!parallelGroupId) {
    throw new Error("beginWorkflowScriptParallelGroup failed: parallelGroup.id is required");
  }

  const reviewerResults = [];
  const reviewOutcomes = reviewPolicy ? [] : null;
  for (const reviewer of runtimePlan.reviewers) {
    const role = requiredSet ? deriveRole(reviewer.runnerId, requiredSet) : "required";
    const quorumMember = quorumSet ? quorumSet.has(reviewer.runnerId) : true;
    const isRequired = role === "required";
    const nodeInput = createKswarmReviewerNodeInput({
      runId: runtimePlan.runId,
      artifactRoot: runtimePlan.artifactRoot,
      runnerId: reviewer.runnerId,
      target: runtimePlan.target,
      outputArtifact: reviewer.outputArtifact,
      parallelGroupId,
      reviewerRole: role,
      quorumMember,
      required: isRequired,
      lang: options.lang
    });
    const dispatched = await expectOk(
      "dispatchWorkflowScriptAgentNode",
      kswarmClient.dispatchWorkflowScriptAgentNode(projectId, workflowRunId, nodeInput)
    );

    let reviewerOutput;
    try {
      reviewerOutput = await reviewerRunner({
        reviewer,
        nodeInput,
        dispatch: dispatched,
        runtimePlan,
        preview,
        role,
        quorumMember
      });
    } catch (error) {
      if (!reviewPolicy || isRequired) {
        throw error;
      }
      reviewOutcomes.push({
        runnerId: reviewer.runnerId,
        role,
        quorumMember,
        nodeId: dispatched.nodeId,
        status: "failed",
        absenceReason: `reviewer runner failed: ${error.message}`
      });
      continue;
    }

    if (reviewPolicy && (reviewerOutput === null || reviewerOutput === undefined)) {
      if (isRequired) {
        throw new Error(`required reviewer ${reviewer.runnerId} produced no review artifact`);
      }
      reviewOutcomes.push({
        runnerId: reviewer.runnerId,
        role,
        quorumMember,
        nodeId: dispatched.nodeId,
        status: "skipped",
        absenceReason: "reviewer runner produced no review artifact"
      });
      continue;
    }

    const markdown = normalizeMarkdownResult(reviewerOutput, "reviewerRunner");
    const artifact = await writeReviewMarkdownToArtifactRoot(runtimePlan.artifactRoot, markdown, {
      expectedRunnerId: reviewer.runnerId,
      artifact: reviewer.outputArtifact
    });
    const dispatchInfo = firstDispatch(dispatched);
    const nodeResult = await expectOk(
      "recordWorkflowNodeResult",
      kswarmClient.recordWorkflowNodeResult(projectId, workflowRunId, {
        nodeId: dispatched.nodeId,
        attempt: dispatchInfo?.attempt,
        handoffId: dispatchInfo?.handoffId,
        fromAgent: reviewer.runnerId,
        output: reviewerOutput?.output || {
          summary: `KualityForge review artifact written: ${artifact.artifact}`,
          runnerId: reviewer.runnerId,
          artifact: artifact.artifact
        }
      })
    );
    reviewerResults.push({ reviewer, artifact, dispatched, nodeResult });
    if (reviewPolicy) {
      reviewOutcomes.push({
        runnerId: reviewer.runnerId,
        role,
        quorumMember,
        nodeId: dispatched.nodeId,
        status: "succeeded"
      });
    }
  }

  if (reviewPolicy) {
    reviewOutcomes.sort((a, b) => a.runnerId.localeCompare(b.runnerId));
    await persistReviewMetadata(runtimePlan.artifactRoot, reviewPolicy, reviewOutcomes);
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
  const completionResult = {
    status: gate.status,
    reasons: gate.reasons,
    artifactRoot: runtimePlan.artifactRoot,
    evidenceRefs: terminal.evidenceRefs
  };
  const completion = await expectOk(
    "completeScriptWorkflowRun",
    kswarmClient.completeScriptWorkflowRun(projectId, workflowRunId, {
      result: completionResult,
      terminal
    })
  );

  return {
    preview,
    runtimePlan,
    workflowProposal: proposal.workflowProposal,
    workflowRunId,
    parallelGroup: parallelGroupResult.parallelGroup,
    reviewerResults,
    reviewOutcomes,
    synthesis,
    decision,
    checks,
    verification,
    gate,
    terminal,
    completion
  };
}

export function createOfflineKswarmClient() {
  const calls = [];
  let nodeCount = 0;
  return {
    calls,
    async createScriptWorkflowProposal(projectId, preview, input) {
      calls.push({ type: "create_proposal", projectId, preview, input });
      return { ok: true, workflowProposal: { id: `offline-proposal-${preview.workflowId}`, projectId, workflowId: preview.workflowId } };
    },
    async startScriptWorkflowRunFromProposal(projectId, proposalId, input) {
      calls.push({ type: "start_run", projectId, proposalId, input });
      return { ok: true, workflowRun: { id: `offline-run-${proposalId}`, projectId } };
    },
    async beginWorkflowScriptParallelGroup(projectId, workflowRunId, input) {
      calls.push({ type: "begin_group", projectId, workflowRunId, input });
      return { ok: true, parallelGroup: { id: "offline-parallel-group-1" } };
    },
    async dispatchWorkflowScriptAgentNode(projectId, workflowRunId, input) {
      nodeCount += 1;
      calls.push({ type: "dispatch_node", projectId, workflowRunId, input });
      return {
        ok: true,
        nodeId: `offline-script-agent-${nodeCount}`,
        dispatches: [{ attempt: 1, handoffId: `offline-handoff-${nodeCount}` }]
      };
    },
    async recordWorkflowNodeResult(projectId, workflowRunId, input) {
      calls.push({ type: "record_node_result", projectId, workflowRunId, input });
      return { ok: true };
    },
    async completeScriptWorkflowRun(projectId, workflowRunId, input) {
      calls.push({ type: "complete_run", projectId, workflowRunId, input });
      return { ok: true, workflowRun: { id: workflowRunId, projectId, status: input.terminal.status } };
    }
  };
}

async function expectOk(action, promise) {
  const result = await promise;
  if (!result?.ok) {
    throw new Error(`${action} failed: ${result?.error || "unknown_error"}`);
  }
  return result;
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
  return Array.isArray(dispatched.dispatches) ? dispatched.dispatches[0] : null;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new Error(`${name} is required`);
  }
  return value;
}
