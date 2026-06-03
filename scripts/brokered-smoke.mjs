#!/usr/bin/env node
// Opt-in live smoke for the KSwarm brokered runtime (design Phase 3).
//
// This script talks to a REAL running KSwarm server over HTTP. It is NOT part
// of `npm test`; it is meant for manual integration verification.
//
// What it does:
//   1. Creates an active KSwarm project with two reviewer members.
//   2. Generates a KualityForge preview + runtime plan.
//   3. Runs the brokered runtime against the live server.
//   4. Simulates two reviewer agents out-of-band: as soon as their nodes are
//      dispatched it writes the expected review artifacts into the artifact
//      root and posts node results back through the KSwarm HTTP control plane.
//   5. Asserts the gate passes and the workflow terminal matches the reducer.
//
// Reviewer simulation runs in a separate poll loop so the brokered runtime
// itself never executes a local reviewerRunner — exactly like production.
//
// Usage:
//   1. In one terminal: cd /Users/song/projects/kswarm && npm run server
//   2. In another:      cd /Users/song/projects/kualityforge \
//                         && KSWARM_URL=http://127.0.0.1:4400 npm run smoke:brokered
//
// Env:
//   KSWARM_URL   KSwarm base url (default http://127.0.0.1:4400)
//   KEEP_ARTIFACTS=1  keep the temp artifact root for inspection

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createKswarmHttpClient,
  createKswarmRuntimePlan,
  createKswarmScriptPreview,
  runKswarmBrokeredRuntimePlan
} from "../src/index.mjs";

const KSWARM_URL = process.env.KSWARM_URL || "http://127.0.0.1:4400";
const REQUIRED_REVIEWERS = ["codex:gpt-5"];
const ADVISORY_REVIEWERS = ["claude:sonnet", "gemini:pro"];
// One advisory reviewer is deliberately left without an artifact to exercise the
// completed-with-failure-evidence contract (advisory absence must not block).
const ABSENT_ADVISORY = "gemini:pro";
const REVIEWERS = [...REQUIRED_REVIEWERS, ...ADVISORY_REVIEWERS];
const REVIEW_POLICY = {
  mode: "quorum",
  requiredReviewers: REQUIRED_REVIEWERS,
  advisoryReviewers: ADVISORY_REVIEWERS,
  quorumMembers: [...REQUIRED_REVIEWERS, ...ADVISORY_REVIEWERS],
  quorumMin: 2
};
// KSwarm assigns its own project id on creation; captured in createActiveProject.
let PROJECT_ID = null;

async function main() {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is required (Node >= 20)");
  }

  await assertServerReachable(fetchImpl);
  await createActiveProject(fetchImpl);

  const artifactRoot = await mkdtemp(join(tmpdir(), "kualityforge-smoke-"));
  const workflowOptions = {
    projectId: PROJECT_ID,
    runId: "release-smoke",
    artifactRoot,
    reviewers: REVIEWERS,
    requestedBy: "human",
    createdAt: Date.now()
  };
  const preview = createKswarmScriptPreview(workflowOptions);
  const runtimePlan = createKswarmRuntimePlan(workflowOptions);

  const kswarmClient = createKswarmHttpClient({ baseUrl: KSWARM_URL });

  // Reviewer simulator: watches the live run, writes artifacts + posts node
  // results for any dispatched reviewer node that is still running.
  const simulator = startReviewerSimulator(kswarmClient, artifactRoot);

  try {
    const result = await runKswarmBrokeredRuntimePlan({
      preview,
      runtimePlan,
      kswarmClient,
      policy: { review: REVIEW_POLICY },
      decisionProvider: async () => "# Decision\n\nNo findings to approve.\n",
      checkRunner: async () => [{ name: "npm test", status: "passed" }],
      verifierRunner: async () => ({
        runnerId: "claude:verifier",
        status: "verified",
        markdown: "# Verify\n\nIndependent verification passed.\n"
      }),
      pollIntervalMs: 500,
      timeoutMs: 60000
    });

    assert(result.gate.status === "passed", `expected gate passed, got ${result.gate.status}`);
    assert(result.terminal.status === "passed", `expected terminal passed, got ${result.terminal.status}`);
    assert(
      result.completionResult.artifacts.some((a) => a.path.endsWith("manifest.json")),
      "completion result must include gate-level manifest artifact"
    );
    assert(
      Array.isArray(result.gate.warnings) &&
        result.gate.warnings.some((w) => w.includes(ABSENT_ADVISORY)),
      `expected advisory absence warning for ${ABSENT_ADVISORY}, got ${JSON.stringify(result.gate.warnings)}`
    );
    const absentOutcome = (result.reviewOutcomes || []).find((o) => o.runnerId === ABSENT_ADVISORY);
    assert(
      absentOutcome && (absentOutcome.status === "skipped" || absentOutcome.status === "failed"),
      `expected ${ABSENT_ADVISORY} outcome skipped/failed, got ${JSON.stringify(absentOutcome)}`
    );

    console.log("\nBrokered smoke PASSED");
    console.log(`  workflowRunId: ${result.workflowRunId}`);
    console.log(`  gate.status:   ${result.gate.status}`);
    console.log(`  terminal:      ${result.terminal.status}`);
    console.log(`  warnings:      ${(result.gate.warnings || []).join("; ") || "(none)"}`);
    console.log(`  reviewers:     ${result.reviewerResults.map((r) => r.reviewer.runnerId).join(", ")}`);
    console.log(`  artifactRoot:  ${artifactRoot}`);
  } finally {
    simulator.stop();
    if (process.env.KEEP_ARTIFACTS !== "1") {
      await rm(artifactRoot, { recursive: true, force: true });
    } else {
      console.log(`  (kept artifact root: ${artifactRoot})`);
    }
  }
}

function startReviewerSimulator(kswarmClient, artifactRoot) {
  let stopped = false;
  let workflowRunId = null;
  const handled = new Set();

  // Discover the running workflow run id by scanning, then poll its nodes.
  const tick = async () => {
    if (stopped) return;
    try {
      if (!workflowRunId) {
        workflowRunId = await discoverRunId(kswarmClient);
      }
      if (workflowRunId) {
        await handleDispatchedReviewerNodes(kswarmClient, workflowRunId, artifactRoot, handled);
      }
    } catch (error) {
      // Non-fatal: the brokered runtime owns pass/fail; log and keep trying.
      if (!stopped) console.error("[simulator]", error.message);
    }
    if (!stopped) setTimeout(tick, 300);
  };
  setTimeout(tick, 300);

  return {
    stop() {
      stopped = true;
    }
  };
}

async function discoverRunId(kswarmClient) {
  // The brokered runtime starts exactly one run for PROJECT_ID; the server
  // exposes it through the project workflows listing.
  const listing = await rawGet(kswarmClient.baseUrl, `/projects/${encodeURIComponent(PROJECT_ID)}/workflows`);
  const runs = listing?.workflowRuns || listing?.runs || [];
  const running = runs.find((run) => run.source === "script_generated");
  return running?.id || null;
}

async function handleDispatchedReviewerNodes(kswarmClient, workflowRunId, artifactRoot, handled) {
  const runResult = await kswarmClient.getWorkflowRun(PROJECT_ID, workflowRunId);
  const workflowRun = runResult?.workflowRun;
  if (!workflowRun) return;
  const nodes = Array.isArray(workflowRun.nodes) ? workflowRun.nodes : [];
  for (const node of nodes) {
    const options = node?.input?.options || node?.options || null;
    const runnerId = options?.runnerId;
    const outputArtifact = options?.outputArtifact;
    if (!runnerId || !outputArtifact) continue;
    if (node.status !== "running") continue;
    if (handled.has(node.id)) continue;
    handled.add(node.id);

    const path = join(artifactRoot, outputArtifact);
    if (runnerId === ABSENT_ADVISORY) {
      console.log(`[simulator] advisory reviewer ${runnerId} completing WITHOUT artifact (intentional absence)`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, reviewMarkdown(runnerId, outputArtifact), "utf8");
    }

    await kswarmClient.recordWorkflowNodeResult(PROJECT_ID, workflowRunId, {
      nodeId: node.id,
      attempt: node.attempt,
      handoffId: node.runtime?.handoffId,
      fromAgent: runnerId,
      output: {
        summary:
          runnerId === ABSENT_ADVISORY
            ? `KualityForge advisory reviewer ${runnerId} produced no artifact`
            : `KualityForge review artifact written: ${outputArtifact}`,
        runnerId,
        artifact: outputArtifact
      }
    });
    console.log(`[simulator] completed reviewer node ${node.id} (${runnerId})`);
  }
}

async function assertServerReachable(fetchImpl) {
  try {
    await fetchImpl(`${KSWARM_URL}/projects`, { method: "GET" });
  } catch (error) {
    throw new Error(
      `KSwarm server not reachable at ${KSWARM_URL}. Start it with \`cd /Users/song/projects/kswarm && npm run server\`. (${error.message})`
    );
  }
}

async function createActiveProject(fetchImpl) {
  const create = await rawPost(fetchImpl, "/projects", {
    name: "KualityForge brokered smoke",
    goal: "Verify KualityForge brokered runtime over live KSwarm",
    poAgent: "xiaok-po",
    members: REVIEWERS,
    autoStartPlanning: false
  });
  if (!create?.project?.id) {
    throw new Error(`create project failed: ${JSON.stringify(create)}`);
  }
  PROJECT_ID = create.project.id;
  console.log(`[smoke] created project ${PROJECT_ID}`);
  await rawPost(fetchImpl, `/projects/${encodeURIComponent(PROJECT_ID)}/tasks/human`, {
    tasks: [{ title: "Run KualityForge quality gate", assignedAgent: "codex:gpt-5" }]
  });
  await rawPost(fetchImpl, `/projects/${encodeURIComponent(PROJECT_ID)}/approve`, {});
}

async function rawPost(fetchImpl, path, body) {
  const response = await fetchImpl(`${KSWARM_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return safeJson(response);
}

async function rawGet(baseUrl, path) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, { method: "GET" });
  return safeJson(response);
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, raw: text };
  }
}

function reviewMarkdown(runnerId, artifact) {
  return `# KualityForge Review

Artifact: ${artifact}

\`\`\`kualityforge-review
{
  "runnerId": "${runnerId}",
  "status": "completed",
  "contextRead": { "projectBrief": true, "userQualityPrinciples": true },
  "contextConfidence": "high",
  "contextGaps": [],
  "principleAlignment": {},
  "findings": []
}
\`\`\`
`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`smoke assertion failed: ${message}`);
  }
}

main().catch((error) => {
  console.error("\nBrokered smoke FAILED");
  console.error(error.message);
  process.exit(1);
});
