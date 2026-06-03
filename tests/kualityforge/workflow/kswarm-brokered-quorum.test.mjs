import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";
import { runKswarmBrokeredRuntimePlan } from "../../../src/core/kswarm-brokered-runtime.mjs";

const REVIEW = Object.freeze({
  mode: "quorum",
  requiredReviewers: ["codex:gpt-5"],
  quorumMembers: ["codex:gpt-5", "claude:sonnet", "gemini:pro"],
  advisoryReviewers: ["claude:sonnet", "gemini:pro"],
  quorumMin: 2
});

function quorumPolicy() {
  return { profile: "release", review: { ...REVIEW } };
}

function workflowOptions(artifactRoot) {
  return {
    projectId: "proj-qf-quorum",
    runId: "release-quorum",
    artifactRoot,
    reviewers: ["codex:gpt-5", "claude:sonnet", "gemini:pro"],
    createdAt: 1782000000000
  };
}

function runOptions(root, runtimePlan, client, overrides = {}) {
  return {
    preview: createKswarmScriptPreview(workflowOptions(root)),
    runtimePlan,
    kswarmClient: client,
    policy: quorumPolicy(),
    decisionProvider: async () => "# Decision\n\nNo findings to approve.\n",
    checkRunner: async () => [{ name: "npm test", status: "passed" }],
    verifierRunner: async () => ({
      runnerId: "claude:verifier",
      status: "verified",
      markdown: "# Verify\n\nVerified.\n"
    }),
    pollIntervalMs: 1,
    sleep: async () => {},
    ...overrides
  };
}

// item 32: advisory failure -> completed-with-failure-evidence, quorum still met, gate passed
test("advisory reviewer failing still completes with failure evidence and passes quorum", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-quorum-advfail-"));
  try {
    const runtimePlan = createKswarmRuntimePlan(workflowOptions(root));
    const client = createFakeBrokeredClient(root, runtimePlan, {
      completeAfterPolls: 1,
      nodeStatusByRunner: { "gemini:pro": "failed" },
      skipArtifactForRunner: ["gemini:pro"]
    });

    const result = await runKswarmBrokeredRuntimePlan(runOptions(root, runtimePlan, client));

    assert.equal(result.gate.status, "passed");
    assert.equal(client.calls.at(-1).type, "complete_run");
    assert.equal(client.calls.at(-1).input.terminal.status, "passed");

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.reviewers.some((r) => r.runnerId === "gemini:pro"), false);
    const outcomes = Object.fromEntries(manifest.reviewOutcomes.map((o) => [o.runnerId, o]));
    assert.equal(outcomes["codex:gpt-5"].status, "succeeded");
    assert.equal(outcomes["claude:sonnet"].status, "succeeded");
    assert.equal(outcomes["gemini:pro"].status, "failed");
    assert.ok(outcomes["gemini:pro"].absenceReason);
    // warnings list the absent advisory
    assert.ok(result.gate.warnings.some((w) => w.includes("gemini:pro")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// item 33: required failure -> runtime error, no complete, no fake outcome
test("required reviewer node failure is a runtime error without completing", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-quorum-reqfail-"));
  try {
    const runtimePlan = createKswarmRuntimePlan(workflowOptions(root));
    const client = createFakeBrokeredClient(root, runtimePlan, {
      completeAfterPolls: 1,
      nodeStatusByRunner: { "codex:gpt-5": "failed" },
      skipArtifactForRunner: ["codex:gpt-5"]
    });

    await assert.rejects(
      runKswarmBrokeredRuntimePlan(runOptions(root, runtimePlan, client)),
      /required reviewer codex:gpt-5 node failed/
    );
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// item 35: advisory completed but artifact missing -> skipped outcome (not registered), quorum may still pass
test("advisory completed but missing artifact records skipped outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-quorum-advmiss-"));
  try {
    const runtimePlan = createKswarmRuntimePlan(workflowOptions(root));
    const client = createFakeBrokeredClient(root, runtimePlan, {
      completeAfterPolls: 1,
      skipArtifactForRunner: ["gemini:pro"]
    });

    const result = await runKswarmBrokeredRuntimePlan(runOptions(root, runtimePlan, client));
    assert.equal(result.gate.status, "passed");
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    const outcomes = Object.fromEntries(manifest.reviewOutcomes.map((o) => [o.runnerId, o]));
    assert.equal(outcomes["gemini:pro"].status, "skipped");
    assert.match(outcomes["gemini:pro"].absenceReason, /artifact is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// item 35b: required completed but artifact missing -> runtime error
test("required completed but missing artifact is a runtime error", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-quorum-reqmiss-"));
  try {
    const runtimePlan = createKswarmRuntimePlan(workflowOptions(root));
    const client = createFakeBrokeredClient(root, runtimePlan, {
      completeAfterPolls: 1,
      skipArtifactForRunner: ["codex:gpt-5"]
    });

    await assert.rejects(
      runKswarmBrokeredRuntimePlan(runOptions(root, runtimePlan, client)),
      /required reviewer codex:gpt-5 node completed but artifact is missing/
    );
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// item 38: runnerId mismatch is always a runtime error
test("runnerId mismatch is always a runtime error", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-quorum-mismatch-"));
  try {
    const runtimePlan = createKswarmRuntimePlan(workflowOptions(root));
    const client = createFakeBrokeredClient(root, runtimePlan, {
      completeAfterPolls: 1,
      forgeRunnerIdFor: { "gemini:pro": "mallory:fake" }
    });

    await assert.rejects(
      runKswarmBrokeredRuntimePlan(runOptions(root, runtimePlan, client)),
      /review runnerId mismatch/
    );
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// item 39: timeout when nodes never reach terminal
test("times out when reviewer nodes never reach terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-quorum-timeout-"));
  try {
    const runtimePlan = createKswarmRuntimePlan(workflowOptions(root));
    const client = createFakeBrokeredClient(root, runtimePlan, { completeAfterPolls: Infinity });
    let clock = 0;

    await assert.rejects(
      runKswarmBrokeredRuntimePlan(
        runOptions(root, runtimePlan, client, {
          pollIntervalMs: 10,
          timeoutMs: 30,
          now: () => clock,
          sleep: async () => {
            clock += 10;
          }
        })
      ),
      /timed out waiting for reviewer nodes/
    );
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// item 40: completeScriptWorkflowRun rejection -> runtime error, not rewritten to blocked
test("complete rejection with nodes_incomplete is a runtime error", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-quorum-completereject-"));
  try {
    const runtimePlan = createKswarmRuntimePlan(workflowOptions(root));
    const client = createFakeBrokeredClient(root, runtimePlan, {
      completeAfterPolls: 1,
      completeReject: "workflow_script_nodes_incomplete"
    });

    await assert.rejects(
      runKswarmBrokeredRuntimePlan(runOptions(root, runtimePlan, client)),
      /completeScriptWorkflowRun rejected: workflow_script_nodes_incomplete/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// item 41: every expected reviewer has exactly one outcome with full fields
test("every expected reviewer has exactly one reviewOutcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-quorum-outcomes-"));
  try {
    const runtimePlan = createKswarmRuntimePlan(workflowOptions(root));
    const client = createFakeBrokeredClient(root, runtimePlan, { completeAfterPolls: 1 });

    await runKswarmBrokeredRuntimePlan(runOptions(root, runtimePlan, client));
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    const ids = manifest.reviewOutcomes.map((o) => o.runnerId);
    assert.deepEqual([...ids].sort(), ["claude:sonnet", "codex:gpt-5", "gemini:pro"]);
    for (const outcome of manifest.reviewOutcomes) {
      assert.ok(["required", "advisory"].includes(outcome.role));
      assert.equal(typeof outcome.quorumMember, "boolean");
      assert.ok(outcome.nodeId);
      assert.ok(["succeeded", "failed", "skipped"].includes(outcome.status));
    }
    // manifest reviewPolicy echo present
    assert.equal(manifest.reviewPolicy.mode, "quorum");
    assert.equal(manifest.reviewPolicy.quorumMin, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

function createFakeBrokeredClient(artifactRoot, runtimePlan, config = {}) {
  const calls = [];
  let nodeCount = 0;
  let polls = 0;
  const dispatched = [];
  const completeAfterPolls = config.completeAfterPolls ?? 1;
  const nodeStatusByRunner = config.nodeStatusByRunner || {};
  const skipArtifactForRunner = new Set(config.skipArtifactForRunner || []);
  const forgeRunnerIdFor = config.forgeRunnerIdFor || {};

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
      if (completed) {
        for (const node of dispatched) {
          const status = nodeStatusByRunner[node.runnerId] || "completed";
          if (status === "completed" && !skipArtifactForRunner.has(node.runnerId)) {
            const runnerId = forgeRunnerIdFor[node.runnerId] || node.runnerId;
            const path = join(artifactRoot, node.outputArtifact);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, reviewMarkdown(runnerId), "utf8");
          }
        }
      }
      return {
        ok: true,
        workflowRun: {
          id: workflowRunId,
          projectId,
          nodes: dispatched.map((node) => ({
            id: node.nodeId,
            status: completed ? nodeStatusByRunner[node.runnerId] || "completed" : "running"
          }))
        }
      };
    },
    async completeScriptWorkflowRun(projectId, workflowRunId, input) {
      calls.push({ type: "complete_run", projectId, workflowRunId, input });
      if (config.completeReject) {
        return { ok: false, code: config.completeReject };
      }
      return { ok: true, workflowRun: { id: workflowRunId, projectId, status: input.terminal.status } };
    }
  };
}
