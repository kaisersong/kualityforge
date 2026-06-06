import { createHash } from "node:crypto";
import { safeArtifactName } from "./review-artifact.mjs";

export const KSWARM_WORKFLOW_ID = "kualityforge_quality_gate";
export const KSWARM_RUNTIME_PLAN_KIND = "kualityforge.kswarm-runtime-plan.v1";

const DEFAULT_CONTEXT_REQUIRED = ["user_quality_principles", "project_brief"];
const DEFAULT_PHASES = [
  {
    id: "freeze-context",
    title: "Freeze Context",
    description: "Freeze project context, docs, instructions, and user quality principles."
  },
  {
    id: "parallel-review",
    title: "Parallel Review",
    description: "Dispatch required reviewers in a KSwarm script parallel group."
  },
  {
    id: "synthesize",
    title: "Synthesize",
    description: "Normalize review artifacts and synthesize duplicate findings."
  },
  {
    id: "verify",
    title: "Verify",
    description: "Record human decision, required checks, and independent verification."
  },
  {
    id: "gate",
    title: "Gate",
    description: "Reduce the KualityForge manifest into a terminal quality-gate decision."
  }
];

export function createKswarmScriptPreview(options = {}) {
  const normalized = normalizeWorkflowOptions(options);
  const runtimePlan = createKswarmRuntimePlan(normalized);
  const scriptHash = hashStable(runtimePlan);

  return {
    ok: true,
    workflowId: KSWARM_WORKFLOW_ID,
    source: "script_generated",
    strategy: "workflow",
    status: "pending_confirmation",
    projectId: normalized.projectId,
    title: "KualityForge Quality Gate",
    description:
      "Run KualityForge as a dynamic KSwarm workflow with parallel reviewer fan-out and artifact-based gate reduction.",
    createdAt: normalized.createdAt,
    requestedBy: normalized.requestedBy,
    scope: {
      projectId: normalized.projectId,
      qualityRunId: normalized.runId,
      artifactRoot: normalized.artifactRoot,
      target: normalized.target
    },
    meta: {
      artifactRoot: normalized.artifactRoot,
      reviewers: [...normalized.reviewers],
      runtimePlanKind: runtimePlan.kind
    },
    phases: DEFAULT_PHASES.map((phase) => ({ ...phase })),
    scriptHash,
    analysis: {
      parallelCallCount: 1,
      agentCallCount: normalized.reviewers.length,
      requiresExternalRuntime: true,
      artifactRoot: normalized.artifactRoot
    }
  };
}

export function createKswarmRuntimePlan(options = {}) {
  const normalized = normalizeWorkflowOptions(options);
  const reviewers = normalized.reviewers.map((runnerId) => {
    const outputArtifact = `reviews/${safeArtifactName(runnerId)}.md`;
    return {
      runnerId,
      assignedAgent: runnerId,
      outputArtifact,
      role: "reviewer"
    };
  });

  const baseContextArgs = createContextCliArgs(normalized);
  const operations = [
    {
      type: "create_proposal",
      previewRef: "preview"
    },
    {
      type: "start_run"
    },
    {
      type: "run_local_command",
      command: "kualityforge",
      args: [
        "init",
        "--artifact-root",
        normalized.artifactRoot,
        "--run-id",
        normalized.runId,
        ...baseContextArgs
      ]
    },
    {
      type: "begin_parallel_group",
      phaseTitle: "Parallel Review",
      primitiveId: "reviewer-fanout",
      totalCount: reviewers.length,
      limit: reviewers.length,
      failurePolicy: "required_all"
    },
    ...reviewers.map((reviewer) => ({
      type: "dispatch_reviewer",
      phaseTitle: "Parallel Review",
      label: `KualityForge review: ${reviewer.runnerId}`,
      runnerId: reviewer.runnerId,
      assignedAgent: reviewer.assignedAgent,
      fanoutItemKey: `reviewer-${safeArtifactName(reviewer.runnerId)}`,
      fanoutItemLabel: reviewer.runnerId,
      required: true,
      evidenceRequired: true,
      outputArtifact: reviewer.outputArtifact,
      contextRequired: [...DEFAULT_CONTEXT_REQUIRED]
    })),
    {
      type: "write_review_artifact",
      required: true,
      artifacts: reviewers.map((reviewer) => reviewer.outputArtifact)
    },
    {
      type: "run_local_command",
      command: "kualityforge",
      args: ["synthesize", "--artifact-root", normalized.artifactRoot]
    },
    {
      type: "request_human_decision",
      required: true,
      artifact: "decision.md"
    },
    {
      type: "run_required_checks",
      required: true
    },
    {
      type: "dispatch_verifier",
      required: false,
      artifact: "verify.md"
    },
    {
      type: "run_local_command",
      command: "kualityforge",
      args: ["gate", "--artifact-root", normalized.artifactRoot]
    },
    {
      type: "complete_run",
      terminalMapper: "mapGateResultToKswarmTerminal"
    }
  ];

  return {
    kind: KSWARM_RUNTIME_PLAN_KIND,
    workflowId: KSWARM_WORKFLOW_ID,
    projectId: normalized.projectId,
    runId: normalized.runId,
    artifactRoot: normalized.artifactRoot,
    target: normalized.target,
    projectRoot: normalized.projectRoot,
    docsRoots: [...normalized.docsRoots],
    qualityPrinciplesPath: normalized.qualityPrinciplesPath,
    changeGoal: normalized.changeGoal,
    changeset: normalized.changeset,
    reviewers,
    contextRequired: [...DEFAULT_CONTEXT_REQUIRED],
    operations
  };
}

export function createKswarmReviewerNodeInput(options = {}) {
  const normalized = normalizeReviewerNodeOptions(options);
  const reviewerRole = options.reviewerRole === "advisory" ? "advisory" : "required";
  const quorumMember = options.quorumMember === undefined ? true : Boolean(options.quorumMember);
  const required = options.required === undefined ? reviewerRole === "required" : Boolean(options.required);
  const promptLines = [
    "You are a KualityForge reviewer running inside a KSwarm dynamic workflow.",
    "",
    "Review target:",
    normalized.target,
    "",
    "Required context before judging the change:",
    `- Read ${normalized.artifactRoot}/context/project-brief.md.`,
    `- Evaluate ONLY the frozen changeset. Read ${normalized.artifactRoot}/context/changeset.md (human-readable) and ${normalized.artifactRoot}/context/changeset.json (machine-readable).`,
    "- Do NOT run your own git diff or infer the changeset from the working tree; the changeset is frozen once so all reviewers judge the identical file set.",
    "- If context/changeset.json reports patchTruncated:true, treat unlisted hunks as out of scope and record a contextGap.",
    `- Read ${normalized.artifactRoot}/context/user-quality-principles.json when it exists.`,
    "- Use project instructions and docs listed in the project brief as higher-priority context than generic assumptions.",
    "",
    "Your entire final message MUST BE the review, written as Markdown. Do not summarize or describe it; emit the Markdown itself.",
    "The Markdown MUST contain exactly one fenced JSON block, written verbatim with this fence and shape (fill in real findings):",
    "",
    "```kualityforge-review",
    JSON.stringify(
      {
        runnerId: normalized.runnerId,
        status: "completed",
        contextRead: {
          projectBrief: true,
          userQualityPrinciples: true
        },
        contextConfidence: "high",
        contextGaps: [],
        principleAlignment: {},
        findings: []
      },
      null,
      2
    ),
    "```",
    "",
    `Save the artifact to ${normalized.outputArtifact}. KSwarm node summaries alone are not KualityForge gate evidence.`
  ];
  if (normalized.lang === "zh") {
    promptLines.push("");
    promptLines.push("语言要求：所有 finding 的 title、description、suggestion 字段必须使用中文撰写。duplicateKey 和 id 保持英文 slug。");
  }
  const prompt = promptLines.join("\n");

  return {
    phaseTitle: "Parallel Review",
    label: `KualityForge review: ${normalized.runnerId}`,
    taskTitle: `KualityForge review by ${normalized.runnerId}`,
    assignedAgent: normalized.runnerId,
    parallelGroupId: normalized.parallelGroupId,
    fanoutItemKey: `reviewer-${safeArtifactName(normalized.runnerId)}`,
    fanoutItemLabel: normalized.runnerId,
    required,
    evidenceRequired: true,
    prompt,
    options: {
      role: "reviewer",
      reviewerRole,
      quorumMember,
      runnerId: normalized.runnerId,
      artifactRoot: normalized.artifactRoot,
      outputArtifact: normalized.outputArtifact,
      contextRequired: [...DEFAULT_CONTEXT_REQUIRED]
    }
  };
}

export function mapGateResultToKswarmTerminal(gateResult = {}, options = {}) {
  const artifactRoot = requireString(options.artifactRoot, "artifactRoot");
  const evidenceRefs = [...defaultEvidenceRefs(artifactRoot), ...(options.evidenceRefs || [])];

  if (gateResult.status === "passed") {
    return {
      status: "passed",
      reason: "KualityForge gate passed",
      evidenceRefs
    };
  }

  const reasons = Array.isArray(gateResult.reasons) ? gateResult.reasons : [];
  const detail = reasons.length > 0 ? `: ${reasons.join("; ")}` : "";
  return {
    status: "blocked",
    reason: `KualityForge gate ${gateResult.status || "failed"}${detail}`,
    evidenceRefs
  };
}

function normalizeWorkflowOptions(options) {
  const projectId = requireString(options.projectId, "projectId");
  const runId = requireString(options.runId, "runId");
  const artifactRoot = requireString(options.artifactRoot, "artifactRoot");
  const reviewers = normalizeReviewers(options.reviewers);

  return {
    projectId,
    runId,
    artifactRoot,
    reviewers,
    target: options.target || ".",
    projectRoot: options.projectRoot || null,
    docsRoots: Array.isArray(options.docsRoots) ? options.docsRoots.filter(Boolean) : [],
    qualityPrinciplesPath: options.qualityPrinciplesPath || null,
    changeGoal: options.changeGoal || null,
    changeset: normalizeChangesetOptions(options.changeset),
    requestedBy: options.requestedBy || null,
    createdAt: Number.isFinite(Number(options.createdAt)) ? Number(options.createdAt) : Date.now()
  };
}

function normalizeReviewerNodeOptions(options) {
  const runnerId = requireString(options.runnerId, "runnerId");
  return {
    runId: requireString(options.runId, "runId"),
    artifactRoot: requireString(options.artifactRoot, "artifactRoot"),
    runnerId,
    target: options.target || ".",
    outputArtifact: options.outputArtifact || `reviews/${safeArtifactName(runnerId)}.md`,
    parallelGroupId: requireString(options.parallelGroupId, "parallelGroupId"),
    lang: options.lang || null
  };
}

function normalizeChangesetOptions(changeset) {
  if (!changeset || typeof changeset !== "object") {
    return null;
  }
  const normalized = {};
  if (typeof changeset.base === "string" && changeset.base.trim()) {
    normalized.base = changeset.base.trim();
  }
  if (typeof changeset.head === "string" && changeset.head.trim()) {
    normalized.head = changeset.head.trim();
  }
  const maxPatchBytes = Number(changeset.maxPatchBytes);
  if (Number.isFinite(maxPatchBytes) && maxPatchBytes > 0) {
    normalized.maxPatchBytes = maxPatchBytes;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeReviewers(reviewers) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error("reviewers must include at least one runner id");
  }
  const unique = [];
  for (const reviewer of reviewers) {
    const value = String(reviewer || "").trim();
    if (!value) {
      continue;
    }
    if (!unique.includes(value)) {
      unique.push(value);
    }
  }
  if (unique.length === 0) {
    throw new Error("reviewers must include at least one runner id");
  }
  return unique;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function createContextCliArgs(options) {
  const args = [];
  if (options.projectRoot) {
    args.push("--project-root", options.projectRoot);
  }
  for (const docsRoot of options.docsRoots) {
    args.push("--docs-root", docsRoot);
  }
  if (options.qualityPrinciplesPath) {
    args.push("--quality-principles", options.qualityPrinciplesPath);
  }
  if (options.changeGoal) {
    args.push("--change-goal", options.changeGoal);
  }
  if (options.changeset?.base) {
    args.push("--diff-base", options.changeset.base);
  }
  if (options.changeset?.head) {
    args.push("--diff-head", options.changeset.head);
  }
  if (options.changeset?.maxPatchBytes) {
    args.push("--diff-max-patch-bytes", String(options.changeset.maxPatchBytes));
  }
  return args;
}

function defaultEvidenceRefs(artifactRoot) {
  return [
    `${artifactRoot}/manifest.json`,
    `${artifactRoot}/summary.md`,
    `${artifactRoot}/verify.md`
  ];
}

function hashStable(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
