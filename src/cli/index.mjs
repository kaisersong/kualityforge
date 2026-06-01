#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  initializeArtifactRoot,
  loadPolicyFile,
  loadManifestFromArtifactRoot,
  parseReviewArtifact,
  renderSummaryMarkdown,
  reduceQualityGate,
  runDeterministicEval,
  safeArtifactName,
  saveManifestToArtifactRoot,
  synthesizeFindings
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

    if (!artifactRoot) {
      throw new Error("init requires --artifact-root <path>");
    }

    if (!runId) {
      throw new Error("init requires --run-id <id>");
    }

    const result = await initializeArtifactRoot(artifactRoot, { runId, profile });
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

    await initializeArtifactRoot(artifactRoot, { runId, profile });
    for (const review of reviews) {
      await writeReviewArtifact(artifactRoot, review);
    }
    await synthesizeArtifactRoot(artifactRoot);
    await recordDecision(artifactRoot, decision);
    for (const check of checks) {
      const { name, status } = parseCheckOption(check);
      await recordCheck(artifactRoot, name, status);
    }
    await recordVerification(artifactRoot, verifierRunnerId, verifyStatus, verify);

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

  if (command === "write-review") {
    const artifactRoot = requireOption(args, "--artifact-root", "write-review");
    const input = requireOption(args, "--input", "write-review");
    const output = await writeReviewArtifact(artifactRoot, input);

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
    const artifact = await recordDecision(artifactRoot, input);
    console.log(JSON.stringify({ status: "decision_recorded", artifact }, null, 2));
    process.exit(0);
  }

  if (command === "record-check") {
    const artifactRoot = requireOption(args, "--artifact-root", "record-check");
    const name = requireOption(args, "--name", "record-check");
    const status = requireOption(args, "--status", "record-check");
    await recordCheck(artifactRoot, name, status);
    console.log(JSON.stringify({ status: "check_recorded", name }, null, 2));
    process.exit(0);
  }

  if (command === "verify") {
    const artifactRoot = requireOption(args, "--artifact-root", "verify");
    const runnerId = requireOption(args, "--runner-id", "verify");
    const status = requireOption(args, "--status", "verify");
    const input = requireOption(args, "--input", "verify");
    const artifact = await recordVerification(artifactRoot, runnerId, status, input);
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

function requireOption(args, name, commandName) {
  const value = readOption(args, name);
  if (!value) {
    throw new Error(`${commandName} requires ${name} <value>`);
  }
  return value;
}

async function writeReviewArtifact(artifactRoot, input) {
  const markdown = await readFile(input, "utf8");
  const review = parseReviewArtifact(markdown);
  const artifactName = `${safeArtifactName(review.runnerId || basename(input))}.md`;
  const artifact = join("reviews", artifactName);
  await mkdir(join(artifactRoot, "reviews"), { recursive: true });
  await writeFile(join(artifactRoot, artifact), markdown, "utf8");

  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const reviewers = manifest.reviewers.filter((item) => item.runnerId !== review.runnerId);
  reviewers.push({
    runnerId: review.runnerId,
    status: review.status,
    artifact
  });
  reviewers.sort((a, b) => a.runnerId.localeCompare(b.runnerId));

  const findings = manifest.findings.filter((item) => item.sourceRunnerId !== review.runnerId);
  findings.push(...review.findings);

  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    reviewers,
    findings
  });

  return {
    runnerId: review.runnerId,
    artifact,
    findingCount: review.findings.length
  };
}

async function synthesizeArtifactRoot(artifactRoot) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const findings = synthesizeFindings(manifest.findings);
  const summary = renderSummaryMarkdown({ runId: manifest.runId, findings });
  const artifact = "summary.md";
  await writeFile(join(artifactRoot, artifact), summary, "utf8");
  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    findings,
    synthesis: {
      artifact,
      status: "completed"
    }
  });
  return { artifact, findingCount: findings.length };
}

async function recordDecision(artifactRoot, input) {
  const artifact = "decision.md";
  await writeFile(join(artifactRoot, artifact), await readFile(input, "utf8"), "utf8");
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    humanDecision: {
      artifact,
      status: "recorded"
    }
  });
  return artifact;
}

async function recordCheck(artifactRoot, name, status) {
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  const requiredChecks = manifest.requiredChecks.filter((check) => check.name !== name);
  requiredChecks.push({ name, status });
  requiredChecks.sort((a, b) => a.name.localeCompare(b.name));
  await saveManifestToArtifactRoot(artifactRoot, { ...manifest, requiredChecks });
}

async function recordVerification(artifactRoot, runnerId, status, input) {
  const artifact = "verify.md";
  await writeFile(join(artifactRoot, artifact), await readFile(input, "utf8"), "utf8");
  const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
  await saveManifestToArtifactRoot(artifactRoot, {
    ...manifest,
    verification: {
      runnerId,
      status,
      artifact
    }
  });
  return artifact;
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

function printHelp() {
  console.log(`KualityForge

Usage:
  kualityforge init --artifact-root <path> --run-id <id> [--profile <name>]
  kualityforge run --artifact-root <path> --run-id <id> --review <review.md>... --decision <decision.md> --check <name=status> --verify <verify.md> --verifier-runner-id <id>
  kualityforge write-review --artifact-root <path> --input <review.md>
  kualityforge synthesize --artifact-root <path>
  kualityforge decide --artifact-root <path> --input <decision.md>
  kualityforge record-check --artifact-root <path> --name <name> --status <status>
  kualityforge verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
  kualityforge gate --manifest <path>
  kualityforge gate --artifact-root <path> [--policy <path>]
  kualityforge eval [--corpus <dir>] [--report <path>]
`);
}
