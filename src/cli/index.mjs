#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createKswarmHttpClient,
  createOfflineKswarmClient,
  initializeArtifactRoot,
  loadPolicyFile,
  loadManifestFromArtifactRoot,
  createKswarmRuntimePlan,
  createKswarmScriptPreview,
  recordCheckResult,
  recordDecisionFile,
  recordVerificationFile,
  reduceQualityGate,
  runKswarmBrokeredRuntimePlan,
  runKswarmRuntimePlan,
  runDeterministicEval,
  synthesizeArtifactRoot,
  writeReportFromArtifactRoot,
  writeReviewFileToArtifactRoot
} from "../index.mjs";

const [, , command, ...args] = process.argv;

try {
  if (!command || command === "help" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  if (command === "init") {
    const artifactRoot = readOption(args, "--artifact-root");
    const runId = readOption(args, "--run-id");
    const profile = readOption(args, "--profile") || "default";
    const context = readContextOptions(args);

    if (!artifactRoot) {
      throw new Error("init requires --artifact-root <path>");
    }

    if (!runId) {
      throw new Error("init requires --run-id <id>");
    }

    const result = await initializeArtifactRoot(artifactRoot, { runId, profile, context });
    console.log(
      JSON.stringify(
        {
          status: "initialized",
          artifactRoot: result.artifactRoot,
          manifestPath: result.manifestPath
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (command === "run") {
    const artifactRoot = requireOption(args, "--artifact-root", "run");
    const runId = requireOption(args, "--run-id", "run");
    const profile = readOption(args, "--profile") || "default";
    const context = readContextOptions(args);
    const reviews = readOptions(args, "--review");
    const decision = requireOption(args, "--decision", "run");
    const checks = readOptions(args, "--check");
    const verify = requireOption(args, "--verify", "run");
    const verifierRunnerId = requireOption(args, "--verifier-runner-id", "run");
    const verifyStatus = readOption(args, "--verify-status") || "verified";
    const policyPath = readOption(args, "--policy");

    if (reviews.length === 0) {
      throw new Error("run requires at least one --review <path>");
    }

    await initializeArtifactRoot(artifactRoot, { runId, profile, context });
    for (const review of reviews) {
      await writeReviewFileToArtifactRoot(artifactRoot, review);
    }
    await synthesizeArtifactRoot(artifactRoot);
    await recordDecisionFile(artifactRoot, decision);
    for (const check of checks) {
      const { name, status } = parseCheckOption(check);
      await recordCheckResult(artifactRoot, name, status);
    }
    await recordVerificationFile(artifactRoot, verify, { runnerId: verifierRunnerId, status: verifyStatus });

    const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
    const policy = policyPath ? await loadPolicyFile(policyPath) : undefined;
    const gate = reduceQualityGate(manifest, policy);
    console.log(
      JSON.stringify(
        {
          status: gate.status,
          artifactRoot,
          manifestPath: join(artifactRoot, "manifest.json"),
          gate
        },
        null,
        2
      )
    );
    process.exit(gate.exitCode);
  }

  if (command === "gate") {
    const manifestPath = readOption(args, "--manifest");
    const artifactRoot = readOption(args, "--artifact-root");
    const policyPath = readOption(args, "--policy");

    if (manifestPath && artifactRoot) {
      throw new Error("gate accepts either --manifest or --artifact-root, not both");
    }

    if (!manifestPath && !artifactRoot) {
      throw new Error("gate requires --manifest <path> or --artifact-root <path>");
    }

    const manifest = artifactRoot
      ? (await loadManifestFromArtifactRoot(artifactRoot)).manifest
      : JSON.parse(await readFile(manifestPath, "utf8"));
    const policy = policyPath ? await loadPolicyFile(policyPath) : undefined;
    const result = reduceQualityGate(manifest, policy);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.exitCode);
  }

  if (command === "kswarm-preview") {
    const projectId = requireOption(args, "--project-id", "kswarm-preview");
    const runId = requireOption(args, "--run-id", "kswarm-preview");
    const artifactRoot = requireOption(args, "--artifact-root", "kswarm-preview");
    const reviewers = readOptions(args, "--reviewer");
    const advisoryReviewers = readOptions(args, "--advisory-reviewer");
    const quorumMinText = readOption(args, "--quorum-min");
    const context = readContextOptions(args) || {};
    const target = readOption(args, "--target") || ".";
    const requestedBy = readOption(args, "--requested-by");
    const createdAtText = readOption(args, "--created-at");
    const createdAt = createdAtText ? Number(createdAtText) : undefined;

    if (reviewers.length === 0) {
      throw new Error("kswarm-preview requires at least one --reviewer <runner-id>");
    }

    const reviewPolicy = buildReviewPolicy(reviewers, advisoryReviewers, quorumMinText);
    const dispatchedReviewers = reviewPolicy
      ? [...reviewPolicy.requiredReviewers, ...reviewPolicy.advisoryReviewers]
      : reviewers;

    const workflowOptions = {
      projectId,
      runId,
      artifactRoot,
      reviewers: dispatchedReviewers,
      target,
      requestedBy,
      createdAt,
      ...context
    };
    const preview = createKswarmScriptPreview(workflowOptions);
    const runtimePlan = createKswarmRuntimePlan(workflowOptions);
    const output = { preview, runtimePlan };
    if (reviewPolicy) {
      output.reviewPolicy = reviewPolicy;
    }
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  if (command === "kswarm-run") {
    const mode = resolveKswarmRunMode(args);
    const previewPath = requireOption(args, "--preview", "kswarm-run");
    const planPath = requireOption(args, "--plan", "kswarm-run");
    const decisionPath = requireOption(args, "--decision", "kswarm-run");
    const checks = readOptions(args, "--check").map(parseCheckOption);
    const verifyPath = readOption(args, "--verify");
    const verifierRunnerId = readOption(args, "--verifier-runner-id");
    const verifyStatus = readOption(args, "--verify-status") || "verified";
    if (verifyPath && !verifierRunnerId) {
      throw new Error("kswarm-run requires --verifier-runner-id <id> when --verify is provided");
    }

    const preview = JSON.parse(await readFile(previewPath, "utf8"));
    const runtimePlan = JSON.parse(await readFile(planPath, "utf8"));

    const advisoryReviewers = readOptions(args, "--advisory-reviewer");
    const quorumMinText = readOption(args, "--quorum-min");
    const planReviewers = Array.isArray(runtimePlan.reviewers)
      ? runtimePlan.reviewers.map((reviewer) => reviewer.runnerId)
      : [];
    const advisorySet = new Set(advisoryReviewers);
    const requiredReviewers = planReviewers.filter((runnerId) => !advisorySet.has(runnerId));
    const reviewPolicy = buildReviewPolicy(requiredReviewers, advisoryReviewers, quorumMinText);
    const policy = reviewPolicy ? { review: reviewPolicy } : undefined;

    const sharedProviders = {
      decisionProvider: async () => readFile(decisionPath, "utf8"),
      checkRunner: async () => checks,
      verifierRunner: verifyPath
        ? async () => ({
            runnerId: verifierRunnerId,
            status: verifyStatus,
            markdown: await readFile(verifyPath, "utf8")
          })
        : undefined
    };

    if (mode === "brokered") {
      if (readOptions(args, "--review").length > 0) {
        throw new Error("--review runner=file.md is only valid in offline mode; brokered reviewers write artifacts via KSwarm");
      }
      const kswarmUrl = requireOption(args, "--kswarm-url", "kswarm-run --mode brokered");
      const pollIntervalMs = Number(readOption(args, "--poll-interval-ms")) || undefined;
      const timeoutMs = Number(readOption(args, "--timeout-ms")) || undefined;
      const kswarmClient = createKswarmHttpClient({ baseUrl: kswarmUrl });
      const result = await runKswarmBrokeredRuntimePlan({
        preview,
        runtimePlan,
        kswarmClient,
        pollIntervalMs,
        timeoutMs,
        policy,
        ...sharedProviders
      });

      const brokeredReport = args.includes("--report")
        ? await writeReportFromArtifactRoot(runtimePlan.artifactRoot, {
            outDir: readOption(args, "--report-out") || undefined,
            html: args.includes("--html"),
            gate: result.gate
          })
        : null;

      console.log(
        JSON.stringify(
          {
            status: result.gate.status,
            mode: "brokered",
            artifactRoot: runtimePlan.artifactRoot,
            workflowRunId: result.workflowRunId,
            gate: result.gate,
            terminal: result.terminal,
            completionResult: result.completionResult,
            ...(brokeredReport ? { report: brokeredReport } : {})
          },
          null,
          2
        )
      );
      process.exit(result.gate.exitCode);
    }

    const reviewInputs = parseKeyValueOptions(readOptions(args, "--review"), "--review");
    const offlineKswarm = createOfflineKswarmClient();
    const result = await runKswarmRuntimePlan({
      preview,
      runtimePlan,
      kswarmClient: offlineKswarm,
      policy,
      reviewerRunner: async ({ reviewer, role }) => {
        const input = reviewInputs.get(reviewer.runnerId);
        if (!input) {
          if (role === "advisory") {
            return null;
          }
          throw new Error(`kswarm-run missing --review ${reviewer.runnerId}=<path>`);
        }
        return readFile(input, "utf8");
      },
      ...sharedProviders
    });

    const offlineReport = args.includes("--report")
      ? await writeReportFromArtifactRoot(runtimePlan.artifactRoot, {
          outDir: readOption(args, "--report-out") || undefined,
          html: args.includes("--html"),
          gate: result.gate
        })
      : null;

    console.log(
      JSON.stringify(
        {
          status: result.gate.status,
          mode: "offline",
          artifactRoot: runtimePlan.artifactRoot,
          workflowRunId: result.workflowRunId,
          gate: result.gate,
          terminal: result.terminal,
          offlineKswarm: {
            calls: offlineKswarm.calls
          },
          ...(offlineReport ? { report: offlineReport } : {})
        },
        null,
        2
      )
    );
    process.exit(result.gate.exitCode);
  }

  if (command === "write-review") {
    const artifactRoot = requireOption(args, "--artifact-root", "write-review");
    const input = requireOption(args, "--input", "write-review");
    const output = await writeReviewFileToArtifactRoot(artifactRoot, input);

    console.log(
      JSON.stringify(
        {
          status: "review_written",
          runnerId: output.runnerId,
          artifact: output.artifact,
          findingCount: output.findingCount
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (command === "synthesize") {
    const artifactRoot = requireOption(args, "--artifact-root", "synthesize");
    const output = await synthesizeArtifactRoot(artifactRoot);
    console.log(JSON.stringify({ status: "synthesized", ...output }, null, 2));
    process.exit(0);
  }

  if (command === "decide") {
    const artifactRoot = requireOption(args, "--artifact-root", "decide");
    const input = requireOption(args, "--input", "decide");
    const artifact = await recordDecisionFile(artifactRoot, input);
    console.log(JSON.stringify({ status: "decision_recorded", artifact }, null, 2));
    process.exit(0);
  }

  if (command === "record-check") {
    const artifactRoot = requireOption(args, "--artifact-root", "record-check");
    const name = requireOption(args, "--name", "record-check");
    const status = requireOption(args, "--status", "record-check");
    await recordCheckResult(artifactRoot, name, status);
    console.log(JSON.stringify({ status: "check_recorded", name }, null, 2));
    process.exit(0);
  }

  if (command === "verify") {
    const artifactRoot = requireOption(args, "--artifact-root", "verify");
    const runnerId = requireOption(args, "--runner-id", "verify");
    const status = requireOption(args, "--status", "verify");
    const input = requireOption(args, "--input", "verify");
    const artifact = await recordVerificationFile(artifactRoot, input, { runnerId, status });
    console.log(JSON.stringify({ status: "verification_recorded", artifact }, null, 2));
    process.exit(0);
  }

  if (command === "report") {
    const artifactRoot = requireOption(args, "--artifact-root", "report");
    const outDir = readOption(args, "--out") || readOption(args, "--report-out") || undefined;
    const html = args.includes("--html");
    const result = await writeReportFromArtifactRoot(artifactRoot, { outDir, html });
    console.log(JSON.stringify({ status: "report_written", ...result }, null, 2));
    process.exit(0);
  }

  if (command === "eval") {
    const corpusDir = readOption(args, "--corpus") || resolve("evals/kualityforge/corpus");
    const report = readOption(args, "--report");
    const result = await runDeterministicEval(corpusDir);
    if (report) {
      await writeFile(report, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "passed" ? 0 : 1);
  }

  throw new Error(`unknown command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] || null;
}

function readOptions(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function readContextOptions(args) {
  const projectRoot = readOption(args, "--project-root");
  const docsRoots = readOptions(args, "--docs-root");
  const qualityPrinciplesPath = readOption(args, "--quality-principles");
  const changeGoal = readOption(args, "--change-goal");
  const instructionFiles = readOptions(args, "--instruction");
  const designEntrypoints = readOptions(args, "--design-entrypoint");
  const diffBase = readOption(args, "--diff-base");
  const diffHead = readOption(args, "--diff-head");
  const diffMaxPatchBytesText = readOption(args, "--diff-max-patch-bytes");
  const changeset = buildChangesetOptions(diffBase, diffHead, diffMaxPatchBytesText);

  if (
    !projectRoot &&
    docsRoots.length === 0 &&
    !qualityPrinciplesPath &&
    !changeGoal &&
    instructionFiles.length === 0 &&
    designEntrypoints.length === 0 &&
    !changeset
  ) {
    return null;
  }

  return {
    projectRoot,
    docsRoots,
    qualityPrinciplesPath,
    changeGoal,
    instructionFiles,
    designEntrypoints,
    ...(changeset ? { changeset } : {})
  };
}

function buildChangesetOptions(base, head, maxPatchBytesText) {
  const changeset = {};
  if (base) {
    changeset.base = base;
  }
  if (head) {
    changeset.head = head;
  }
  if (maxPatchBytesText !== null && maxPatchBytesText !== undefined) {
    const maxPatchBytes = Number(maxPatchBytesText);
    if (!Number.isFinite(maxPatchBytes) || maxPatchBytes <= 0) {
      throw new Error("--diff-max-patch-bytes must be a positive number");
    }
    changeset.maxPatchBytes = maxPatchBytes;
  }
  return Object.keys(changeset).length > 0 ? changeset : null;
}

function resolveKswarmRunMode(args) {
  const mode = readOption(args, "--mode");
  if (mode) {
    if (mode !== "offline" && mode !== "brokered") {
      throw new Error(`kswarm-run --mode must be offline or brokered, got ${mode}`);
    }
    return mode;
  }
  if (args.includes("--offline")) {
    return "offline";
  }
  throw new Error("kswarm-run requires --offline or --mode brokered --kswarm-url <url>");
}

function requireOption(args, name, commandName) {
  const value = readOption(args, name);
  if (!value) {
    throw new Error(`${commandName} requires ${name} <value>`);
  }
  return value;
}

function parseCheckOption(value) {
  const separator = value.indexOf("=");
  if (separator === -1) {
    throw new Error("--check must use <name>=<status>");
  }

  return {
    name: value.slice(0, separator),
    status: value.slice(separator + 1)
  };
}

function parseKeyValueOptions(values, name) {
  const result = new Map();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator === -1) {
      throw new Error(`${name} must use <key>=<value>`);
    }
    result.set(value.slice(0, separator), value.slice(separator + 1));
  }
  return result;
}

function buildReviewPolicy(requiredReviewers, advisoryReviewers, quorumMinText) {
  const advisory = dedupe(advisoryReviewers || []);
  const required = dedupe(requiredReviewers || []);
  const hasQuorum = quorumMinText !== null && quorumMinText !== undefined;
  if (advisory.length === 0 && !hasQuorum) {
    return null;
  }
  for (const runnerId of advisory) {
    if (required.includes(runnerId)) {
      throw new Error(`--advisory-reviewer ${runnerId} cannot downgrade a required reviewer`);
    }
  }
  const mode = hasQuorum ? "quorum" : "required_all";
  const review = {
    mode,
    requiredReviewers: required,
    advisoryReviewers: advisory
  };
  if (mode === "quorum") {
    review.quorumMembers = [...required, ...advisory];
    review.quorumMin = Number(quorumMinText);
  }
  return review;
}

function dedupe(values) {
  const out = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

function printHelp() {
  console.log(`KualityForge

Usage:
  kualityforge init --artifact-root <path> --run-id <id> [--profile <name>] [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>] [--instruction <path>] [--design-entrypoint <path>] [--diff-base <ref>] [--diff-head <ref|WORKTREE>] [--diff-max-patch-bytes <n>]
  kualityforge run --artifact-root <path> --run-id <id> --review <review.md>... --decision <decision.md> --check <name=status> --verify <verify.md> --verifier-runner-id <id> [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>]
  kualityforge write-review --artifact-root <path> --input <review.md>
  kualityforge synthesize --artifact-root <path>
  kualityforge decide --artifact-root <path> --input <decision.md>
  kualityforge record-check --artifact-root <path> --name <name> --status <status>
  kualityforge verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
  kualityforge gate --manifest <path>
  kualityforge gate --artifact-root <path> [--policy <path>]
  kualityforge report --artifact-root <path> [--out <dir>|--report-out <dir>] [--html]
  kualityforge kswarm-preview --project-id <id> --run-id <id> --artifact-root <path> --reviewer <runner-id>... [--advisory-reviewer <runner-id>...] [--quorum-min <n>] [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>] [--target <path>] [--requested-by <id>]
  kualityforge kswarm-run --offline --preview <preview.json> --plan <runtime-plan.json> --review <runner-id=review.md>... [--advisory-reviewer <runner-id>...] [--quorum-min <n>] --decision <decision.md> --check <name=status> [--verify <verify.md> --verifier-runner-id <id>]
  kualityforge kswarm-run --mode brokered --kswarm-url <url> --preview <preview.json> --plan <runtime-plan.json> [--advisory-reviewer <runner-id>...] [--quorum-min <n>] --decision <decision.md> --check <name=status> [--verify <verify.md> --verifier-runner-id <id>] [--poll-interval-ms <ms>] [--timeout-ms <ms>]
  kualityforge eval [--corpus <dir>] [--report <path>]

Reports:
  report output directory precedence: --out/--report-out flag, then KUALITYFORGE_REPORT_OUT_DIR env var, then the built-in default.

Quorum review:
  --reviewer marks a required reviewer; --advisory-reviewer marks an advisory (non-blocking) reviewer.
  --advisory-reviewer cannot downgrade a runner already declared as --reviewer (required); doing so is rejected.
  --quorum-min <n> enables quorum mode: at least n of the quorum members (required + advisory) must succeed.
  Required reviewers are never exempted: a missing or failed required reviewer always blocks the gate,
  while advisory absence only records warnings.
`);
}
