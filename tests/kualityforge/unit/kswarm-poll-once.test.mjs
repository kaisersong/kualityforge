import assert from "node:assert/strict";
import test from "node:test";
import { pollOnce } from "../../../src/core/kswarm-brokered-runtime.mjs";

function client(workflowRun) {
  return {
    calls: 0,
    async getWorkflowRun() {
      this.calls += 1;
      return { workflowRun };
    }
  };
}

const ARGS = { projectId: "p1", workflowRunId: "wr-1" };

test("pollOnce classifies every expected node by terminal status", async () => {
  const kswarmClient = client({
    nodes: [
      { id: "n1", status: "completed" },
      { id: "n2", status: "failed" },
      { id: "n3", status: "blocked" },
      { id: "n4", status: "running" },
      { id: "other", status: "completed" }
    ]
  });

  const result = await pollOnce({
    kswarmClient,
    ...ARGS,
    expectedNodeIds: new Set(["n1", "n2", "n3", "n4"])
  });

  assert.deepEqual(result.completed, ["n1"]);
  assert.deepEqual(result.failed, ["n2"]);
  assert.deepEqual(result.blocked, ["n3"]);
  assert.deepEqual(result.pending, ["n4"]);
  assert.equal(result.done, false);
});

test("pollOnce reports done once no expected node is pending", async () => {
  const kswarmClient = client({
    nodes: [
      { id: "n1", status: "completed" },
      { id: "n2", status: "blocked" }
    ]
  });

  const result = await pollOnce({
    kswarmClient,
    ...ARGS,
    expectedNodeIds: new Set(["n1", "n2"])
  });

  assert.equal(result.done, true);
  assert.deepEqual(result.pending, []);
});

test("pollOnce treats an unknown node id as pending, not as done", async () => {
  const kswarmClient = client({ nodes: [{ id: "n1", status: "completed" }] });

  const result = await pollOnce({
    kswarmClient,
    ...ARGS,
    expectedNodeIds: new Set(["n1", "n2"])
  });

  assert.deepEqual(result.pending, ["n2"]);
  assert.equal(result.done, false);
});

// An empty expectation set has no evidence to offer, so reporting done would let
// a run with zero dispatched reviewers proceed as if every reviewer finished.
test("pollOnce is never done when nothing is expected", async () => {
  const kswarmClient = client({ nodes: [] });

  const result = await pollOnce({ kswarmClient, ...ARGS, expectedNodeIds: new Set() });

  assert.equal(result.done, false);
});

test("pollOnce is never done when the workflow run is unavailable", async () => {
  const kswarmClient = client(null);

  const result = await pollOnce({
    kswarmClient,
    ...ARGS,
    expectedNodeIds: new Set(["n1"])
  });

  assert.equal(result.workflowRun, null);
  assert.equal(result.done, false);
  assert.deepEqual(result.pending, ["n1"]);
});

test("pollOnce performs exactly one client call per invocation", async () => {
  const kswarmClient = client({ nodes: [{ id: "n1", status: "completed" }] });

  await pollOnce({ kswarmClient, ...ARGS, expectedNodeIds: new Set(["n1"]) });
  await pollOnce({ kswarmClient, ...ARGS, expectedNodeIds: new Set(["n1"]) });

  assert.equal(kswarmClient.calls, 2);
});
