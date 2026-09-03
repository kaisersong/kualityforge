import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createKswarmRuntimePlan, createKswarmScriptPreview } from "../../../src/core/kswarm-workflow.mjs";
import { runKswarmBrokeredRuntimePlan } from "../../../src/core/kswarm-brokered-runtime.mjs";
import { decisionMarkdown, verificationMarkdown } from "../helpers/artifact-fixtures.mjs";
import { applyDeterministicGitEnv, createChangesetProject } from "../helpers/git-env.mjs";

await applyDeterministicGitEnv();

const FIXTURE_PROJECT_ROOT = await createChangesetProject();
test.after(async () => {
  await rm(FIXTURE_PROJECT_ROOT, { recursive: true, force: true });
});

const FINDING_TITLE =
  "Potential issue identified during review requiring further investigation and resolution";

// Both reviewers report the same title, so synthesis merges them into one finding.
const SYNTHESIZED_FINDINGS = [{
  id: "QF-001",
  severity: "info",
  title: FINDING_TITLE,
  type: "code",
  priority: null,
  principleId: null,
  sourceRunnerId: "claude:sonnet",
  sourceRunnerIds: ["claude:sonnet", "codex:gpt-5"]
}];

const decisionProvider = async () => ({
  markdown: decisionMarkdown({ runId: "release-brokered", findings: SYNTHESIZED_FINDINGS }),
  owner: "kai"
});

test("runKswarmBrokeredRuntimePlan dispatches reviewers, collects artifacts, and completes passed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-pass-"));
  const projectRoot = await createChangesetProject();
  try {
    const options = workflowOptions(root, projectRoot);
    const runtimePlan = createKswarmRuntimePlan(options);
    const client = createFakeBrokeredClient(root, runtimePlan, { completeAfterPolls: 2 });

    const result = await runKswarmBrokeredRuntimePlan({
      preview: createKswarmScriptPreview(options),
      runtimePlan,
      kswarmClient: client,
      decisionProvider,
      checkRunner: async () => [{ name: "npm test", status: "passed" }],
      verifierRunner: async () => ({
        runnerId: "claude:verifier",
        markdown: verificationMarkdown({ runnerId: "claude:verifier" })
      }),
      pollIntervalMs: 1,
      sleep: async () => {}
    });

    assert.equal(result.gate.status, "passed");
    assert.equal(result.terminal.status, "passed");
    assert.equal(client.calls.filter((call) => call.type === "dispatch_node").length, 2);
    assert.deepEqual(
      client.calls.find((call) => call.type === "dispatch_node").input.options.contextRequired,
      ["project_brief", "structure_scan"]
    );
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
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runKswarmBrokeredRuntimePlan rejects an unusable changeset before reviewer dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-no-freeze-"));
  try {
    const options = { ...workflowOptions(root, null), reviewType: "changeset" };
    const runtimePlan = createKswarmRuntimePlan(options);
    const client = createFakeBrokeredClient(root, runtimePlan);

    await assert.rejects(
      runKswarmBrokeredRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan,
        kswarmClient: client
      }),
      /frozen changeset is required and is not usable/
    );

    assert.equal(client.calls.some((call) => call.type === "begin_group"), false);
    assert.equal(client.calls.some((call) => call.type === "dispatch_node"), false);
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
        decisionProvider,
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
        decisionProvider,
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

for (const nodeStatus of ["failed", "blocked"]) {
  test(`required_all without reviewPolicy stops on a ${nodeStatus} reviewer`, async () => {
    const root = await mkdtemp(join(tmpdir(), `kualityforge-brokered-${nodeStatus}-`));
    try {
      const options = workflowOptions(root);
      const runtimePlan = createKswarmRuntimePlan(options);
      const client = createFakeBrokeredClient(root, runtimePlan, {
        completeAfterPolls: 1,
        nodeStatuses: [nodeStatus, "completed"]
      });

      await assert.rejects(
        runKswarmBrokeredRuntimePlan({
          preview: createKswarmScriptPreview(options),
          runtimePlan,
          kswarmClient: client,
          decisionProvider,
          pollIntervalMs: 1,
          sleep: async () => {}
        }),
        new RegExp(`required reviewer codex:gpt-5 node ${nodeStatus}`)
      );
      assert.equal(client.calls.some((call) => call.type === "complete_run"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("required_all without reviewPolicy stops on a vacuous brokered review", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-brokered-vacuous-"));
  try {
    const options = workflowOptions(root);
    const runtimePlan = createKswarmRuntimePlan(options);
    const client = createFakeBrokeredClient(root, runtimePlan, {
      completeAfterPolls: 1,
      vacuousNodeIndexes: [0]
    });

    await assert.rejects(
      runKswarmBrokeredRuntimePlan({
        preview: createKswarmScriptPreview(options),
        runtimePlan,
        kswarmClient: client,
        decisionProvider,
        pollIntervalMs: 1,
        sleep: async () => {}
      }),
      /required reviewer codex:gpt-5 produced vacuous output/
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
      decisionProvider,
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
        decisionProvider,
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

function workflowOptions(artifactRoot, projectRoot = FIXTURE_PROJECT_ROOT) {
  return {
    projectId: "proj-qf-brokered",
    runId: "release-brokered",
    artifactRoot,
    ...(projectRoot ? { projectRoot } : {}),
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    createdAt: 1782000000000
  };
}

function reviewMarkdown(runnerId, contextManifestHash = null, findings = [
  {
    id: "QF-001",
    title: FINDING_TITLE,
    description:
      "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
    suggestion:
      "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
    severity: "info"
  }
]) {
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

function createFakeBrokeredClient(artifactRoot, runtimePlan, config = {}) {
  const calls = [];
  let nodeCount = 0;
  let polls = 0;
  const dispatched = [];
  const completeAfterPolls = config.completeAfterPolls ?? 1;

  return {
    calls,
    async createScriptProject(input) {
      calls.push({ type: "create_project", input });
      return { id: runtimePlan.projectId };
    },
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
      dispatched.push({
        nodeId,
        outputArtifact: input.options.outputArtifact,
        runnerId: input.options.runnerId,
        contextManifestHash: input.options.contextManifestHash
      });
      return { ok: true, nodeId, dispatches: [{ attempt: 1, handoffId: `handoff-${nodeCount}` }] };
    },
    async getWorkflowRun(projectId, workflowRunId) {
      polls += 1;
      calls.push({ type: "get_run", projectId, workflowRunId, poll: polls });
      const completed = polls >= completeAfterPolls;
      if (completed && !config.skipArtifacts) {
        for (const [index, node] of dispatched.entries()) {
          const terminalStatus = config.nodeStatuses?.[index] || "completed";
          if (terminalStatus !== "completed") {
            continue;
          }
          const runnerId = config.forgeRunnerId || node.runnerId;
          const path = join(artifactRoot, node.outputArtifact);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(
            path,
            config.vacuousNodeIndexes?.includes(index)
              ? reviewMarkdown(runnerId, node.contextManifestHash, [])
              : reviewMarkdown(runnerId, node.contextManifestHash),
            "utf8"
          );
        }
      }
      return {
        ok: true,
        workflowRun: {
          id: workflowRunId,
          projectId,
          nodes: dispatched.map((node, index) => ({
            id: node.nodeId,
            status: completed ? config.nodeStatuses?.[index] || "completed" : "running"
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
