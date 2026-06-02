#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
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
  runKswarmRuntimePlan,
  runDeterministicEval,
  synthesizeArtifactRoot,
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
    const context = readContextOptions(args) || {};
    const target = readOption(args, "--target") || ".";
    const requestedBy = readOption(args, "--requested-by");
    const createdAtText = readOption(args, "--created-at");
    const createdAt = createdAtText ? Number(createdAtText) : undefined;

    if (reviewers.length === 0) {
      throw new Error("kswarm-preview requires at least one --reviewer <runner-id>");
    }

    const workflowOptions = {
      projectId,
      runId,
      artifactRoot,
      reviewers,
      target,
      requestedBy,
      createdAt,
      ...context
    };
    const preview = createKswarmScriptPreview(workflowOptions);
    const runtimePlan = createKswarmRuntimePlan(workflowOptions);
    console.log(JSON.stringify({ preview, runtimePlan }, null, 2));
    process.exit(0);
  }

  if (command === "kswarm-run") {
    if (!args.includes("--offline")) {
      throw new Error("kswarm-run currently requires --offline; live KSwarm adapters are provided outside core");
    }
    const previewPath = requireOption(args, "--preview", "kswarm-run");
    const planPath = requireOption(args, "--plan", "kswarm-run");
    const reviewInputs = parseKeyValueOptions(readOptions(args, "--review"), "--review");
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
    const offlineKswarm = createOfflineKswarmClient();
    const result = await runKswarmRuntimePlan({
      preview,
      runtimePlan,
      kswarmClient: offlineKswarm,
      reviewerRunner: async ({ reviewer }) => {
        const input = reviewInputs.get(reviewer.runnerId);
        if (!input) {
          throw new Error(`kswarm-run missing --review ${reviewer.runnerId}=<path>`);
        }
        return readFile(input, "utf8");
      },
      decisionProvider: async () => readFile(decisionPath, "utf8"),
      checkRunner: async () => checks,
      verifierRunner: verifyPath
        ? async () => ({
            runnerId: verifierRunnerId,
            status: verifyStatus,
            markdown: await readFile(verifyPath, "utf8")
          })
        : undefined
    });

    console.log(
      JSON.stringify(
        {
          status: result.gate.status,
          artifactRoot: runtimePlan.artifactRoot,
          workflowRunId: result.workflowRunId,
          gate: result.gate,
          terminal: result.terminal,
          offlineKswarm: {
            calls: offlineKswarm.calls
          }
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

  if (
    !projectRoot &&
    docsRoots.length === 0 &&
    !qualityPrinciplesPath &&
    !changeGoal &&
    instructionFiles.length === 0 &&
    designEntrypoints.length === 0
  ) {
    return null;
  }

  return {
    projectRoot,
    docsRoots,
    qualityPrinciplesPath,
    changeGoal,
    instructionFiles,
    designEntrypoints
  };
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

function printHelp() {
  console.log(`KualityForge

Usage:
  kualityforge init --artifact-root <path> --run-id <id> [--profile <name>] [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>] [--instruction <path>] [--design-entrypoint <path>]
  kualityforge run --artifact-root <path> --run-id <id> --review <review.md>... --decision <decision.md> --check <name=status> --verify <verify.md> --verifier-runner-id <id> [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>]
  kualityforge write-review --artifact-root <path> --input <review.md>
  kualityforge synthesize --artifact-root <path>
  kualityforge decide --artifact-root <path> --input <decision.md>
  kualityforge record-check --artifact-root <path> --name <name> --status <status>
  kualityforge verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
  kualityforge gate --manifest <path>
  kualityforge gate --artifact-root <path> [--policy <path>]
  kualityforge kswarm-preview --project-id <id> --run-id <id> --artifact-root <path> --reviewer <runner-id>... [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>] [--target <path>] [--requested-by <id>]
  kualityforge kswarm-run --offline --preview <preview.json> --plan <runtime-plan.json> --review <runner-id=review.md>... --decision <decision.md> --check <name=status> [--verify <verify.md> --verifier-runner-id <id>]
  kualityforge eval [--corpus <dir>] [--report <path>]
`);
}
