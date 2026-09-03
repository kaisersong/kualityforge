import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";
import { runKswarmRuntimePlan } from "../../../src/core/kswarm-runtime-executor.mjs";
import { mapReviewFindings } from "../../../src/core/review-artifact.mjs";
import { synthesizeFindings } from "../../../src/core/synthesis.mjs";
import { decisionMarkdown, verificationMarkdown } from "../helpers/artifact-fixtures.mjs";
import { applyDeterministicGitEnv, createChangesetProject } from "../helpers/git-env.mjs";

await applyDeterministicGitEnv();

const FIXTURE_PROJECT_ROOT = await createChangesetProject();
test.after(async () => {
  await rm(FIXTURE_PROJECT_ROOT, { recursive: true, force: true });
});

const FINDING_TITLE =
  "Sample finding for test coverage with sufficient detail to pass vacuous check";
const RAW_FINDING = {
  id: "QF-001",
  title: FINDING_TITLE,
  description:
    "This is a test finding with enough content to exceed the vacuous threshold and ensure the review is considered substantive",
  suggestion: "Consider adding more test coverage for edge cases in the validation module",
  severity: "info"
};

const SYNTHESIZED_FINDINGS = synthesizeFindings(
  ["codex:gpt-5", "claude:sonnet"].flatMap(
    (runnerId) => mapReviewFindings(runnerId, [RAW_FINDING]).findings
  )
);

const decisionProvider = async () => ({
  markdown: decisionMarkdown({ runId: "release-runtime", findings: SYNTHESIZED_FINDINGS }),
  owner: "kai"
});

test("runKswarmRuntimePlan records reviewer artifacts, node results, and passed completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-pass-"));
  const projectRoot = await createChangesetProject();
  try {
    const options = workflowOptions(root, projectRoot);
    const client = createFakeKswarmClient();
    const result = await runKswarmRuntimePlan({
      preview: createKswarmScriptPreview(options),
      runtimePlan: createKswarmRuntimePlan(options),
      kswarmClient: client,
      reviewerRunner: async ({ reviewer, nodeInput }) =>
        reviewMarkdown(reviewer.runnerId, nodeInput.options.contextManifestHash),
      decisionProvider,
      checkRunner: async () => [{ name: "npm test", status: "passed" }],
      verifierRunner: async () => ({
        runnerId: "claude:verifier",
        markdown: verificationMarkdown({ runnerId: "claude:verifier" })
      })
    });

    assert.equal(result.gate.status, "passed");
    assert.equal(result.terminal.status, "passed");
    assert.equal(client.calls.filter((call) => call.type === "dispatch_node").length, 2);
    assert.deepEqual(
      client.calls.find((call) => call.type === "dispatch_node").input.options.contextRequired,
      ["project_brief", "structure_scan"]
    );
    assert.equal(client.calls.filter((call) => call.type === "record_node_result").length, 2);
    assert.equal(client.calls.at(-1).type, "complete_run");
    assert.equal(client.calls.at(-1).input.terminal.status, "passed");

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.deepEqual(
      manifest.reviewers.map((reviewer) => reviewer.artifact),
      ["reviews/claude-sonnet.md", "reviews/codex-gpt-5.md"]
    );
    assert.equal(manifest.synthesis.status, "completed");
    assert.equal(manifest.humanDecision.status, "parsed");
    assert.equal(manifest.requiredChecks[0].status, "passed");
    assert.equal(manifest.verification.runnerId, "claude:verifier");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runKswarmRuntimePlan rejects an unusable changeset before reviewer dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-no-freeze-"));
  try {
    const options = { ...workflowOptions(root, null), reviewType: "changeset" };
    const client = createFakeKswarmClient();

    await assert.rejects(
      runKswarmRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan: createKswarmRuntimePlan(options),
        kswarmClient: client,
        reviewerRunner: async ({ reviewer, nodeInput }) =>
        reviewMarkdown(reviewer.runnerId, nodeInput.options.contextManifestHash)
      }),
      /frozen changeset is required and is not usable/
    );

    assert.equal(client.calls.some((call) => call.type === "begin_group"), false);
    assert.equal(client.calls.some((call) => call.type === "dispatch_node"), false);
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
      reviewerRunner: async ({ reviewer, nodeInput }) =>
        reviewMarkdown(reviewer.runnerId, nodeInput.options.contextManifestHash),
      decisionProvider,
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
        reviewerRunner: async ({ reviewer, nodeInput }) =>
        reviewMarkdown(reviewer.runnerId, nodeInput.options.contextManifestHash),
        decisionProvider
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
        decisionProvider
      }),
      /review runnerId mismatch/
    );

    assert.equal(client.calls.some((call) => call.type === "record_node_result"), false);
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required_all without reviewPolicy stops when a reviewer returns no artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-missing-"));
  try {
    const options = workflowOptions(root);
    const client = createFakeKswarmClient();

    await assert.rejects(
      runKswarmRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan: createKswarmRuntimePlan(options),
        kswarmClient: client,
        reviewerRunner: async () => null,
        decisionProvider
      }),
      /required reviewer codex:gpt-5 produced no review artifact/
    );

    assert.equal(client.calls.some((call) => call.type === "record_node_result"), false);
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required_all without reviewPolicy stops when a reviewer returns vacuous output", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-vacuous-"));
  try {
    const options = workflowOptions(root);
    const client = createFakeKswarmClient();

    await assert.rejects(
      runKswarmRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan: createKswarmRuntimePlan(options),
        kswarmClient: client,
        reviewerRunner: async ({ reviewer, nodeInput }) =>
          reviewMarkdown(reviewer.runnerId, nodeInput.options.contextManifestHash, []),
        decisionProvider
      }),
      /required reviewer codex:gpt-5 produced vacuous output/
    );

    assert.equal(client.calls.some((call) => call.type === "record_node_result"), false);
    assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit advisory reviewer may skip a missing artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-runtime-advisory-missing-"));
  try {
    const options = workflowOptions(root);
    const client = createFakeKswarmClient();
    const result = await runKswarmRuntimePlan({
      preview: createKswarmScriptPreview(options),
      runtimePlan: createKswarmRuntimePlan(options),
      kswarmClient: client,
      policy: {
        review: {
          mode: "required_all",
          requiredReviewers: ["codex:gpt-5"],
          advisoryReviewers: ["claude:sonnet"]
        }
      },
      reviewerRunner: async ({ reviewer, nodeInput }) =>
        reviewer.runnerId === "claude:sonnet"
          ? null
          : reviewMarkdown(reviewer.runnerId, nodeInput.options.contextManifestHash),
      decisionProvider: async () => {
        const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
        return {
          markdown: decisionMarkdown({ runId: "release-runtime", findings: manifest.findings }),
          owner: "kai"
        };
      },
      checkRunner: async () => [{ name: "npm test", status: "passed" }],
      verifierRunner: async () => ({
        runnerId: "claude:verifier",
        markdown: verificationMarkdown({ runnerId: "claude:verifier" })
      })
    });

    assert.equal(result.reviewOutcomes.length, 2);
    assert.equal(
      result.reviewOutcomes.find((outcome) => outcome.runnerId === "codex:gpt-5").status,
      "succeeded"
    );
    assert.equal(
      result.reviewOutcomes.find((outcome) => outcome.runnerId === "claude:sonnet").status,
      "skipped"
    );
    assert.equal(client.calls.at(-1).type, "complete_run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function workflowOptions(artifactRoot, projectRoot = FIXTURE_PROJECT_ROOT) {
  return {
    projectId: "proj-qf-runtime",
    runId: "release-runtime",
    artifactRoot,
    ...(projectRoot ? { projectRoot } : {}),
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    createdAt: 1782000000000
  };
}

function reviewMarkdown(runnerId, contextManifestHash = null, findings = [RAW_FINDING]) {
  return `# Review

\`\`\`kualityforge-review
${JSON.stringify(
  {
    runnerId,
    status: "completed",
    ...(contextManifestHash
      ? { contextProvenance: { contextManifestHash } }
      : {}),
    findings
  },
  null,
  2
)}
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
