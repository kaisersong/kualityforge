import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";
import { runKswarmRuntimePlan } from "../../../src/core/kswarm-runtime-executor.mjs";

test("runKswarmRuntimePlan records reviewer artifacts, node results, and passed completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-pass-"));
  try {
    const options = workflowOptions(root);
    const client = createFakeKswarmClient();
    const result = await runKswarmRuntimePlan({
      preview: createKswarmScriptPreview(options),
      runtimePlan: createKswarmRuntimePlan(options),
      kswarmClient: client,
      reviewerRunner: async ({ reviewer }) => reviewMarkdown(reviewer.runnerId),
      decisionProvider: async () => "# Decision\n\nNo findings to approve.\n",
      checkRunner: async () => [{ name: "npm test", status: "passed" }],
      verifierRunner: async () => ({
        runnerId: "claude:verifier",
        status: "verified",
        markdown: "# Verify\n\nVerified.\n"
      })
    });

    assert.equal(result.gate.status, "passed");
    assert.equal(result.terminal.status, "passed");
    assert.equal(client.calls.filter((call) => call.type === "dispatch_node").length, 2);
    assert.equal(client.calls.filter((call) => call.type === "record_node_result").length, 2);
    assert.equal(client.calls.at(-1).type, "complete_run");
    assert.equal(client.calls.at(-1).input.terminal.status, "passed");

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.deepEqual(
      manifest.reviewers.map((reviewer) => reviewer.artifact),
      ["reviews/claude-sonnet.md", "reviews/codex-gpt-5.md"]
    );
    assert.equal(manifest.synthesis.status, "completed");
    assert.equal(manifest.humanDecision.status, "recorded");
    assert.equal(manifest.requiredChecks[0].status, "passed");
    assert.equal(manifest.verification.runnerId, "claude:verifier");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runKswarmRuntimePlan completes KSwarm blocked when deterministic gate is incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-blocked-"));
  try {
    const options = workflowOptions(root);
    const client = createFakeKswarmClient();
    const result = await runKswarmRuntimePlan({
      preview: createKswarmScriptPreview(options),
      runtimePlan: createKswarmRuntimePlan(options),
      kswarmClient: client,
      reviewerRunner: async ({ reviewer }) => reviewMarkdown(reviewer.runnerId),
      decisionProvider: async () => "# Decision\n\nNo findings to approve.\n",
      checkRunner: async () => [{ name: "npm test", status: "passed" }]
    });

    assert.equal(result.gate.status, "incomplete");
    assert.match(result.terminal.reason, /verification artifact is required/);
    assert.equal(client.calls.at(-1).type, "complete_run");
    assert.equal(client.calls.at(-1).input.terminal.status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runKswarmRuntimePlan stops before complete when node result cannot be recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-node-result-fail-"));
  try {
    const options = workflowOptions(root);
    const client = createFakeKswarmClient({ failRecordNodeResult: true });

    await assert.rejects(
      runKswarmRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan: createKswarmRuntimePlan(options),
        kswarmClient: client,
        reviewerRunner: async ({ reviewer }) => reviewMarkdown(reviewer.runnerId),
        decisionProvider: async () => "# Decision\n\nNo findings to approve.\n"
      }),
      /recordWorkflowNodeResult failed: node_result_failed/
    );

    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runKswarmRuntimePlan rejects reviewer identity mismatch before node completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-identity-"));
  try {
    const options = workflowOptions(root);
    const client = createFakeKswarmClient();

    await assert.rejects(
      runKswarmRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan: createKswarmRuntimePlan(options),
        kswarmClient: client,
        reviewerRunner: async () => reviewMarkdown("claude:sonnet"),
        decisionProvider: async () => "# Decision\n\nNo findings to approve.\n"
      }),
      /review runnerId mismatch/
    );

    assert.equal(client.calls.some((call) => call.type === "record_node_result"), false);
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function workflowOptions(artifactRoot) {
  return {
    projectId: "proj-qf-runtime",
    runId: "release-runtime",
    artifactRoot,
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    createdAt: 1782000000000
  };
}

function reviewMarkdown(runnerId) {
  return `# Review

\`\`\`kualityforge-review
{
  "runnerId": "${runnerId}",
  "status": "completed",
  "findings": []
}
\`\`\`
`;
}

function createFakeKswarmClient(options = {}) {
  const calls = [];
  let nodeCount = 0;
  return {
    calls,
    async createScriptWorkflowProposal(projectId, preview, input) {
      calls.push({ type: "create_proposal", projectId, preview, input });
      return { ok: true, workflowProposal: { id: "proposal-1", projectId, workflowId: preview.workflowId } };
    },
    async startScriptWorkflowRunFromProposal(projectId, proposalId, input) {
      calls.push({ type: "start_run", projectId, proposalId, input });
      return { ok: true, workflowRun: { id: "workflow-run-1", projectId } };
    },
    async beginWorkflowScriptParallelGroup(projectId, workflowRunId, input) {
      calls.push({ type: "begin_group", projectId, workflowRunId, input });
      return { ok: true, parallelGroup: { id: "parallel-group-1" } };
    },
    async dispatchWorkflowScriptAgentNode(projectId, workflowRunId, input) {
      nodeCount += 1;
      calls.push({ type: "dispatch_node", projectId, workflowRunId, input });
      return {
        ok: true,
        nodeId: `script-agent-${nodeCount}`,
        dispatches: [{ attempt: 1, handoffId: `handoff-${nodeCount}` }]
      };
    },
    async recordWorkflowNodeResult(projectId, workflowRunId, input) {
      calls.push({ type: "record_node_result", projectId, workflowRunId, input });
      if (options.failRecordNodeResult) {
        return { ok: false, error: "node_result_failed" };
      }
      return { ok: true };
    },
    async completeScriptWorkflowRun(projectId, workflowRunId, input) {
      calls.push({ type: "complete_run", projectId, workflowRunId, input });
      return { ok: true, workflowRun: { id: workflowRunId, projectId, status: input.terminal.status } };
    }
  };
}
