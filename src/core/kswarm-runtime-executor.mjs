import { initializeArtifactRoot, loadManifestFromArtifactRoot } from "./artifact-root.mjs";
import {
  recordCheckResult,
  recordDecisionMarkdown,
  recordVerificationMarkdown,
  synthesizeArtifactRoot,
  writeReviewMarkdownToArtifactRoot
} from "./artifact-operations.mjs";
import { reduceQualityGate } from "./gate-reducer.mjs";
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
  for (const reviewer of runtimePlan.reviewers) {
    const nodeInput = createKswarmReviewerNodeInput({
      runId: runtimePlan.runId,
      artifactRoot: runtimePlan.artifactRoot,
      runnerId: reviewer.runnerId,
      target: runtimePlan.target,
      outputArtifact: reviewer.outputArtifact,
      parallelGroupId
    });
    const dispatched = await expectOk(
      "dispatchWorkflowScriptAgentNode",
      kswarmClient.dispatchWorkflowScriptAgentNode(projectId, workflowRunId, nodeInput)
    );
    const reviewerOutput = await reviewerRunner({
      reviewer,
      nodeInput,
      dispatch: dispatched,
      runtimePlan,
      preview
    });
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
  }

  const synthesis = await synthesizeArtifactRoot(runtimePlan.artifactRoot);

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

function createContextOptions(runtimePlan) {
  if (
    !runtimePlan.projectRoot &&
    (!Array.isArray(runtimePlan.docsRoots) || runtimePlan.docsRoots.length === 0) &&
    !runtimePlan.qualityPrinciplesPath &&
    !runtimePlan.changeGoal
  ) {
    return null;
  }

  return {
    projectRoot: runtimePlan.projectRoot,
    docsRoots: runtimePlan.docsRoots || [],
    qualityPrinciplesPath: runtimePlan.qualityPrinciplesPath,
    changeGoal: runtimePlan.changeGoal
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
