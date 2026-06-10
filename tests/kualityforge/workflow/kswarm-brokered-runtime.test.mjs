import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";
import { runKswarmBrokeredRuntimePlan } from "../../../src/core/kswarm-brokered-runtime.mjs";

test("runKswarmBrokeredRuntimePlan dispatches reviewers, collects artifacts, and completes passed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-pass-"));
  try {
    const options = workflowOptions(root);
    const runtimePlan = createKswarmRuntimePlan(options);
    const client = createFakeBrokeredClient(root, runtimePlan, { completeAfterPolls: 2 });

    const result = await runKswarmBrokeredRuntimePlan({
      preview: createKswarmScriptPreview(options),
      runtimePlan,
      kswarmClient: client,
      decisionProvider: async () => "# Decision\n\nNo findings to approve.\n",
      checkRunner: async () => [{ name: "npm test", status: "passed" }],
      verifierRunner: async () => ({
        runnerId: "claude:verifier",
        status: "verified",
        markdown: "# Verify\n\nVerified.\n"
      }),
      pollIntervalMs: 1,
      sleep: async () => {}
    });

    assert.equal(result.gate.status, "passed");
    assert.equal(result.terminal.status, "passed");
    assert.equal(client.calls.filter((call) => call.type === "dispatch_node").length, 2);
    assert.equal(client.calls.some((call) => call.type === "record_node_result"), false);
    assert.equal(client.calls.at(-1).type, "complete_run");
    assert.equal(client.calls.at(-1).input.terminal.status, "passed");
    assert.ok(
      client.calls
        .at(-1)
        .input.result.artifacts.some((artifact) => artifact.path.endsWith("manifest.json")),
      "completion result must include gate-level artifacts"
    );

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.deepEqual(
      manifest.reviewers.map((reviewer) => reviewer.artifact),
      ["reviews/claude-sonnet.md", "reviews/codex-gpt-5.md"]
    );
    assert.equal(manifest.verification.runnerId, "claude:verifier");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runKswarmBrokeredRuntimePlan rejects a local reviewerRunner", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-runner-"));
  try {
    const options = workflowOptions(root);
    const runtimePlan = createKswarmRuntimePlan(options);
    await assert.rejects(
      runKswarmBrokeredRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan,
        kswarmClient: createFakeBrokeredClient(root, runtimePlan),
        reviewerRunner: async () => "# nope"
      }),
      /must not run a local reviewerRunner/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runKswarmBrokeredRuntimePlan fails when a completed node has no review artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-missing-"));
  try {
    const options = workflowOptions(root);
    const runtimePlan = createKswarmRuntimePlan(options);
    const client = createFakeBrokeredClient(root, runtimePlan, { completeAfterPolls: 1, skipArtifacts: true });

    await assert.rejects(
      runKswarmBrokeredRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan,
        kswarmClient: client,
        decisionProvider: async () => "# Decision\n",
        pollIntervalMs: 1,
        sleep: async () => {}
      }),
      /node completed but artifact is missing/
    );
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runKswarmBrokeredRuntimePlan rejects reviewer runnerId mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-identity-"));
  try {
    const options = workflowOptions(root);
    const runtimePlan = createKswarmRuntimePlan(options);
    const client = createFakeBrokeredClient(root, runtimePlan, {
      completeAfterPolls: 1,
      forgeRunnerId: "mallory:fake"
    });

    await assert.rejects(
      runKswarmBrokeredRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan,
        kswarmClient: client,
        decisionProvider: async () => "# Decision\n",
        pollIntervalMs: 1,
        sleep: async () => {}
      }),
      /review runnerId mismatch/
    );
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runKswarmBrokeredRuntimePlan completes blocked when gate is incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-blocked-"));
  try {
    const options = workflowOptions(root);
    const runtimePlan = createKswarmRuntimePlan(options);
    const client = createFakeBrokeredClient(root, runtimePlan, { completeAfterPolls: 1 });

    const result = await runKswarmBrokeredRuntimePlan({
      preview: createKswarmScriptPreview(options),
      runtimePlan,
      kswarmClient: client,
      decisionProvider: async () => "# Decision\n",
      checkRunner: async () => [{ name: "npm test", status: "passed" }],
      pollIntervalMs: 1,
      sleep: async () => {}
    });

    assert.equal(result.gate.status, "incomplete");
    assert.equal(client.calls.at(-1).type, "complete_run");
    assert.equal(client.calls.at(-1).input.terminal.status, "blocked");
    assert.match(result.terminal.reason, /verification artifact is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runKswarmBrokeredRuntimePlan times out if reviewer nodes never complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-timeout-"));
  try {
    const options = workflowOptions(root);
    const runtimePlan = createKswarmRuntimePlan(options);
    const client = createFakeBrokeredClient(root, runtimePlan, { completeAfterPolls: Infinity });
    let clock = 0;

    await assert.rejects(
      runKswarmBrokeredRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan,
        kswarmClient: client,
        decisionProvider: async () => "# Decision\n",
        pollIntervalMs: 10,
        timeoutMs: 30,
        now: () => clock,
        sleep: async () => {
          clock += 10;
        }
      }),
      /timed out waiting for reviewer nodes/
    );
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function workflowOptions(artifactRoot) {
  return {
    projectId: "proj-qf-brokered",
    runId: "release-brokered",
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
  "findings": [
    {
      "id": "QF-001",
      "title": "Potential issue identified during review requiring further investigation and resolution",
      "description": "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
      "suggestion": "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
      "severity": "info",
      "status": "risk_accepted"
    }
  ]
}
\`\`\`
`;
}

function createFakeBrokeredClient(artifactRoot, runtimePlan, config = {}) {
  const calls = [];
  let nodeCount = 0;
  let polls = 0;
  const dispatched = [];
  const completeAfterPolls = config.completeAfterPolls ?? 1;

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
      const nodeId = `script-agent-${nodeCount}`;
      calls.push({ type: "dispatch_node", projectId, workflowRunId, input });
      dispatched.push({ nodeId, outputArtifact: input.options.outputArtifact, runnerId: input.options.runnerId });
      return { ok: true, nodeId, dispatches: [{ attempt: 1, handoffId: `handoff-${nodeCount}` }] };
    },
    async getWorkflowRun(projectId, workflowRunId) {
      polls += 1;
      calls.push({ type: "get_run", projectId, workflowRunId, poll: polls });
      const completed = polls >= completeAfterPolls;
      if (completed && !config.skipArtifacts) {
        for (const node of dispatched) {
          const runnerId = config.forgeRunnerId || node.runnerId;
          const path = join(artifactRoot, node.outputArtifact);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, reviewMarkdown(runnerId), "utf8");
        }
      }
      return {
        ok: true,
        workflowRun: {
          id: workflowRunId,
          projectId,
          nodes: dispatched.map((node) => ({
            id: node.nodeId,
            status: completed ? "completed" : "running"
          }))
        }
      };
    },
    async completeScriptWorkflowRun(projectId, workflowRunId, input) {
      calls.push({ type: "complete_run", projectId, workflowRunId, input });
      return { ok: true, workflowRun: { id: workflowRunId, projectId, status: input.terminal.status } };
    }
  };
}
