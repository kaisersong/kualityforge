import assert from "node:assert/strict";
import test from "node:test";
import { createKswarmHttpClient, KswarmHttpError } from "../../../src/core/kswarm-http-client.mjs";

function createFetchRecorder(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers: init.headers, body });
    return responder({ url, method: init.method, body });
  };
  return { calls, fetchImpl };
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

test("createKswarmHttpClient builds exact endpoint paths and preserves payload", async () => {
  const { calls, fetchImpl } = createFetchRecorder(() => jsonResponse({ ok: true }));
  const client = createKswarmHttpClient({ baseUrl: "http://127.0.0.1:4319/", fetch: fetchImpl });

  await client.createScriptWorkflowProposal("proj-1", { workflowId: "wf" }, { requestedBy: "human" });
  await client.startScriptWorkflowRunFromProposal("proj-1", "proposal-1", { approvedBy: "human" });
  await client.beginWorkflowScriptParallelGroup("proj-1", "run-1", { totalCount: 2 });
  await client.dispatchWorkflowScriptAgentNode("proj-1", "run-1", { assignedAgent: "codex:gpt-5" });
  await client.getWorkflowRun("proj-1", "run-1");
  await client.recordWorkflowNodeResult("proj-1", "run-1", {
    nodeId: "node-1",
    attempt: 1,
    handoffId: "handoff-1",
    fromAgent: "codex:gpt-5",
    output: { summary: "done" }
  });
  await client.completeScriptWorkflowRun("proj-1", "run-1", { terminal: { status: "passed" } });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      "POST http://127.0.0.1:4319/projects/proj-1/workflows/script-generated/proposal",
      "POST http://127.0.0.1:4319/projects/proj-1/workflows/script-generated/runs",
      "POST http://127.0.0.1:4319/projects/proj-1/workflows/run-1/script/parallel-groups",
      "POST http://127.0.0.1:4319/projects/proj-1/workflows/run-1/script/nodes",
      "GET http://127.0.0.1:4319/projects/proj-1/workflows/run-1",
      "POST http://127.0.0.1:4319/projects/proj-1/workflows/run-1/script/nodes/node-1/result",
      "POST http://127.0.0.1:4319/projects/proj-1/workflows/run-1/script/complete"
    ]
  );

  const proposalCall = calls[0];
  assert.deepEqual(proposalCall.body, { preview: { workflowId: "wf" }, requestedBy: "human" });

  const nodeResultCall = calls[5];
  assert.equal(nodeResultCall.body.nodeId, undefined);
  assert.equal(nodeResultCall.body.attempt, 1);
  assert.equal(nodeResultCall.body.handoffId, "handoff-1");
  assert.equal(nodeResultCall.body.fromAgent, "codex:gpt-5");
  assert.deepEqual(nodeResultCall.body.output, { summary: "done" });
});

test("createKswarmHttpClient raises KswarmHttpError on non-2xx response", async () => {
  const { fetchImpl } = createFetchRecorder(() => jsonResponse({ error: "boom" }, { ok: false, status: 500 }));
  const client = createKswarmHttpClient({ baseUrl: "http://127.0.0.1:4319", fetch: fetchImpl });

  await assert.rejects(client.getWorkflowRun("proj-1", "run-1"), (error) => {
    assert.ok(error instanceof KswarmHttpError);
    assert.equal(error.action, "getWorkflowRun");
    assert.equal(error.statusCode, 500);
    assert.equal(error.kswarmError, "boom");
    return true;
  });
});

test("createKswarmHttpClient raises KswarmHttpError on ok:false body", async () => {
  const { fetchImpl } = createFetchRecorder(() =>
    jsonResponse({ ok: false, error: "workflow_script_nodes_incomplete" })
  );
  const client = createKswarmHttpClient({ baseUrl: "http://127.0.0.1:4319", fetch: fetchImpl });

  await assert.rejects(
    client.completeScriptWorkflowRun("proj-1", "run-1", { terminal: { status: "passed" } }),
    /completeScriptWorkflowRun failed: workflow_script_nodes_incomplete/
  );
});
