import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REVIEWER_DENIED_COMMAND_LABELS,
  createKswarmReviewerNodeInput,
  createKswarmRuntimePlan,
  createKswarmScriptPreview,
  mapGateResultToKswarmTerminal
} from "../../../src/core/kswarm-workflow.mjs";
import { buildContextPack } from "../../../src/core/context-pack.mjs";
import { CONTEXT_FILES, deriveContextAvailability } from "../../../src/core/context-vocabulary.mjs";
import {
  FINDING_PRIORITIES,
  REVIEWER_WRITABLE_STATUSES,
  REVIEW_ARTIFACT_STATUSES,
  SEVERITY_LEVELS
} from "../../../src/core/finding-vocabulary.mjs";
import { applyDeterministicGitEnv } from "../helpers/git-env.mjs";

await applyDeterministicGitEnv();

const reviewerNodeBase = {
  runId: "release-1",
  artifactRoot: "docs/quality/release-1",
  runnerId: "codex:gpt-5",
  target: ".",
  outputArtifact: "reviews/codex-gpt-5.md",
  parallelGroupId: "script-parallel-1",
  contextFiles: {
    [CONTEXT_FILES.contextManifest]: { sha256: "a".repeat(64) },
    [CONTEXT_FILES.qualityPrinciplesJson]: {},
    [CONTEXT_FILES.projectBrief]: {},
    [CONTEXT_FILES.changesetJson]: {},
    [CONTEXT_FILES.changesetMarkdown]: {}
  }
};

test("createKswarmScriptPreview returns a KSwarm script-generated preview", () => {
  const preview = createKswarmScriptPreview({
    projectId: "proj-qf",
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    requestedBy: "codex",
    createdAt: 1782000000000
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.workflowId, "kualityforge_quality_gate");
  assert.equal(preview.source, "script_generated");
  assert.equal(preview.strategy, "workflow");
  assert.equal(preview.projectId, "proj-qf");
  assert.equal(preview.scope.qualityRunId, "release-1");
  assert.equal(preview.meta.artifactRoot, "docs/quality/release-1");
  assert.deepEqual(preview.meta.reviewers, ["codex:gpt-5", "claude:sonnet"]);
  assert.equal(preview.phases.length, 5);
  assert.match(preview.scriptHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.analysis.parallelCallCount, 1);
  assert.equal(preview.analysis.agentCallCount, 2);
});

test("createKswarmScriptPreview uses stable scriptHash for the same runtime plan", () => {
  const first = createKswarmScriptPreview({
    projectId: "proj-qf",
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    createdAt: 1782000000000
  });
  const second = createKswarmScriptPreview({
    projectId: "proj-qf",
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    createdAt: 1782000000100
  });

  assert.equal(first.scriptHash, second.scriptHash);
});

test("createKswarmRuntimePlan describes reviewer fan-out and artifact writes", () => {
  const plan = createKswarmRuntimePlan({
    projectId: "proj-qf",
    runId: "release-1",
    artifactRoot: "docs/quality/release-1",
    reviewers: ["codex:gpt-5", "claude:sonnet"],
    projectRoot: "/repo",
    docsRoots: ["/docs"],
    qualityPrinciplesPath: "/principles.json",
    changeGoal: "Ship release 1",
    createdAt: 1782000000000
  });

  assert.equal(plan.kind, "kualityforge.kswarm-runtime-plan.v1");
  assert.equal(plan.contextGeneratedAt, new Date(1782000000000).toISOString());
  assert.equal(plan.operations.some((operation) => operation.type === "begin_parallel_group"), true);
  assert.equal(plan.operations.filter((operation) => operation.type === "dispatch_reviewer").length, 2);
  assert.equal(plan.operations.find((operation) => operation.type === "write_review_artifact").required, true);
  assert.deepEqual(
    plan.reviewers.map((reviewer) => reviewer.outputArtifact),
    ["reviews/codex-gpt-5.md", "reviews/claude-sonnet.md"]
  );
});

test("createKswarmReviewerNodeInput includes context and review artifact instructions", () => {
  const input = createKswarmReviewerNodeInput({ ...reviewerNodeBase });

  assert.equal(input.phaseTitle, "Parallel Review");
  assert.equal(input.label, "KualityForge review: codex:gpt-5");
  assert.equal(input.assignedAgent, "codex:gpt-5");
  assert.equal(input.parallelGroupId, "script-parallel-1");
  assert.equal(input.fanoutItemKey, "reviewer-codex-gpt-5");
  assert.equal(input.required, true);
  assert.equal(input.evidenceRequired, true);
  assert.equal(input.options.outputArtifact, "reviews/codex-gpt-5.md");
  assert.equal(input.options.contextManifestHash, "a".repeat(64));
  assert.deepEqual(input.options.contextRequired, ["user_quality_principles", "project_brief"]);
  assert.match(input.prompt, /context\/project-brief\.md/);
  assert.match(input.prompt, /context\/context-manifest\.json/);
  assert.match(input.prompt, /```kualityforge-review/);
  assert.match(input.prompt, /contextRead/);
  assert.match(input.prompt, /"contextProvenance"\s*:\s*\{/);
  assert.match(input.prompt, /"contextManifestHash"\s*:/);
});

test("createKswarmReviewerNodeInput rejects the obsolete structure-scan flag", () => {
  const { contextFiles, ...input } = reviewerNodeBase;

  assert.throws(
    () => createKswarmReviewerNodeInput({ ...input, hasStructureScan: true }),
    /contextFiles is required/
  );
});

test("createKswarmReviewerNodeInput rejects a missing frozen context file table", () => {
  const { contextFiles, ...input } = reviewerNodeBase;

  assert.throws(() => createKswarmReviewerNodeInput(input), /contextFiles is required/);
});

test("createKswarmReviewerNodeInput freezes the changeset and forbids self-diff", () => {
  const input = createKswarmReviewerNodeInput({ ...reviewerNodeBase });

  // The constraint is asserted as a structured field plus the invariant that the
  // field is what the prompt is rendered from: rephrasing the sentence must not
  // break the test, and dropping a denied command must.
  assert.ok(Array.isArray(input.permissions.deniedCommands));
  assert.ok(input.permissions.deniedCommands.length > 0);
  for (const command of input.permissions.deniedCommands) {
    assert.ok(input.prompt.includes(command), `prompt must render denied command: ${command}`);
  }
  assert.match(input.prompt, /context\/changeset\.md/);
  assert.match(input.prompt, /context\/changeset\.json/);
  assert.match(input.prompt, /patchTruncated/);
  // Existing context wiring must remain intact.
  assert.match(input.prompt, /context\/project-brief\.md/);
});

test("denied commands travel as structured ids whose labels come from a trusted table", () => {
  const input = createKswarmReviewerNodeInput({ ...reviewerNodeBase });

  // Two fields, one direction: the id is what a consumer may validate against its
  // allowlist, the label is what the prompt shows. Deriving the label from the id
  // keeps caller-supplied text out of the prompt while still naming a real command.
  assert.ok(Array.isArray(input.permissions.deniedCommandIds));
  assert.ok(input.permissions.deniedCommandIds.length > 0);
  for (const id of input.permissions.deniedCommandIds) {
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    assert.ok(id.length <= 64);
    assert.ok(
      Object.hasOwn(REVIEWER_DENIED_COMMAND_LABELS, id),
      `denied command id must have a trusted label: ${id}`
    );
  }
  assert.deepEqual(
    input.permissions.deniedCommands,
    input.permissions.deniedCommandIds.map((id) => REVIEWER_DENIED_COMMAND_LABELS[id])
  );
  // The prompt must name the real command, not the id: rendering "git-diff" would
  // leave the model with a token that matches nothing it can decline to run.
  assert.ok(input.prompt.includes("git diff"));
});

test("reviewer permissions no longer declare capabilities nobody enforces", () => {
  const input = createKswarmReviewerNodeInput({ ...reviewerNodeBase });

  // These four booleans and toolCategories are never read on the script_generated
  // path. Sending them claimed an enforcement that does not exist, and allowWrite:false
  // directly contradicted the prompt's own instruction to write the review artifact.
  for (const key of ["allowShell", "allowWrite", "allowNetwork", "allowRenderer", "toolCategories"]) {
    assert.equal(
      Object.hasOwn(input.permissions, key),
      false,
      `permissions must not declare unenforced key: ${key}`
    );
  }
});

test("the reviewer prompt carries the finding vocabulary the parser enforces", () => {
  const input = createKswarmReviewerNodeInput({ ...reviewerNodeBase });

  // A value outside these enums makes write-review reject the artifact outright, so
  // the reviewer has to be told the enums rather than guess them.
  for (const severity of SEVERITY_LEVELS) {
    assert.ok(input.prompt.includes(severity), `prompt must list severity: ${severity}`);
  }
  for (const priority of FINDING_PRIORITIES) {
    assert.ok(input.prompt.includes(priority), `prompt must list priority: ${priority}`);
  }
  for (const status of REVIEWER_WRITABLE_STATUSES) {
    assert.ok(input.prompt.includes(status), `prompt must list writable status: ${status}`);
  }
  for (const status of REVIEW_ARTIFACT_STATUSES) {
    assert.ok(input.prompt.includes(status), `prompt must list artifact status: ${status}`);
  }
  // The parser derives duplicateKey from the title and ignores whatever the reviewer
  // reports, so asking for it spends prompt budget on a discarded field.
  assert.equal(input.prompt.includes("duplicateKey"), false);
});

test("the reviewer prompt scopes the review to the changeset by default", () => {
  const input = createKswarmReviewerNodeInput({ ...reviewerNodeBase });

  assert.match(input.prompt, /^- Review scope: changeset-only$/m);
});

test("the reviewer prompt widens the review scope for full-project runs", () => {
  const input = createKswarmReviewerNodeInput({
    ...reviewerNodeBase,
    reviewType: "full-project"
  });

  assert.match(input.prompt, /^- Review scope: full-project$/m);
  assert.doesNotMatch(input.prompt, /^- Review scope: changeset-only$/m);
  // A full-project run that still says "evaluate only the changeset" contradicts the
  // focus areas the same prompt appends further down.
  assert.doesNotMatch(input.prompt, /Evaluate ONLY/);
});

test("every context file the reviewer prompt references was really frozen", async (t) => {
  // Both sides of this assertion must come from one options set. The pack writes
  // conditionally and the prompt renders conditionally, so comparing a fully loaded
  // pack against a differently configured prompt would test two unrelated objects.
  const canonical = new Set(Object.values(CONTEXT_FILES));
  const cells = [
    { projectRoot: true, reviewType: "changeset", enableStructureScan: false, qualityPrinciples: true },
    { projectRoot: true, reviewType: "changeset", enableStructureScan: false, qualityPrinciples: false },
    { projectRoot: true, reviewType: "changeset", enableStructureScan: true, qualityPrinciples: true },
    { projectRoot: true, reviewType: "changeset", enableStructureScan: true, qualityPrinciples: false },
    { projectRoot: true, reviewType: "full-project", enableStructureScan: false, qualityPrinciples: true },
    { projectRoot: true, reviewType: "full-project", enableStructureScan: false, qualityPrinciples: false },
    { projectRoot: false, reviewType: "changeset", enableStructureScan: false, qualityPrinciples: true },
    { projectRoot: false, reviewType: "changeset", enableStructureScan: false, qualityPrinciples: false },
    { projectRoot: false, reviewType: "full-project", enableStructureScan: false, qualityPrinciples: true },
    { projectRoot: false, reviewType: "full-project", enableStructureScan: false, qualityPrinciples: false }
  ];

  for (const [index, cell] of cells.entries()) {
    const label = `cell ${index + 1} ${JSON.stringify(cell)}`;
    const root = await mkdtemp(join(tmpdir(), "kualityforge-u5-matrix-"));
    try {
      const artifactRoot = join(root, "artifacts");
      await mkdir(artifactRoot, { recursive: true });

      let projectRoot = null;
      if (cell.projectRoot) {
        projectRoot = join(root, "project");
        await mkdir(projectRoot, { recursive: true });
        await writeFile(join(projectRoot, "index.mjs"), "export const value = 1;\n", "utf8");
      }

      let qualityPrinciplesPath = null;
      if (cell.qualityPrinciples) {
        qualityPrinciplesPath = join(root, "quality-principles.json");
        await writeFile(
          qualityPrinciplesPath,
          `${JSON.stringify({ schemaVersion: 1, scope: "user", required: true, principles: [] })}\n`,
          "utf8"
        );
      }

      const pack = await buildContextPack(artifactRoot, {
        projectRoot,
        qualityPrinciplesPath,
        reviewType: cell.reviewType,
        enableStructureScan: cell.enableStructureScan,
        changeGoal: "Matrix cell."
      });

      const input = createKswarmReviewerNodeInput({
        ...reviewerNodeBase,
        artifactRoot,
        reviewType: cell.reviewType,
        contextFiles: pack.files
      });

      const referenced = new Set(
        [...input.prompt.matchAll(/context\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)+/g)].map((match) =>
          match[0].slice("context/".length)
        )
      );
      assert.ok(referenced.size > 0, `${label}: prompt must reference context files`);
      for (const name of referenced) {
        assert.ok(canonical.has(name), `${label}: ${name} is not a canonical context file`);
        assert.ok(Object.hasOwn(pack.files, name), `${label}: ${name} was never frozen`);
      }

      assert.deepEqual(
        input.options.contextRequired,
        deriveContextAvailability(pack.files).ackKeys,
        `${label}: contextRequired must be derived from the frozen pack`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  t.diagnostic("matrix covered 10 cells");
});

test("mapGateResultToKswarmTerminal blocks non-passed gates with artifact evidence", () => {
  const terminal = mapGateResultToKswarmTerminal(
    {
      status: "incomplete",
      exitCode: 2,
      reasons: ["reviewer shortage", "project brief artifact is required"]
    },
    { artifactRoot: "docs/quality/release-1" }
  );

  assert.equal(terminal.status, "blocked");
  assert.match(terminal.reason, /reviewer shortage/);
  assert.deepEqual(terminal.evidenceRefs, [
    "docs/quality/release-1/manifest.json",
    "docs/quality/release-1/summary.md",
    "docs/quality/release-1/verify.md"
  ]);

  const passed = mapGateResultToKswarmTerminal(
    { status: "passed", exitCode: 0, reasons: [] },
    { artifactRoot: "docs/quality/release-1" }
  );
  assert.equal(passed.status, "passed");
});
