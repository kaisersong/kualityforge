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
    const markdown = await readFile(input, "utf8");
    const review = parseReviewArtifact(markdown);
    const artifactName = `${safeArtifactName(review.runnerId || basename(input))}.md`;
    const artifactPath = join(artifactRoot, "reviews", artifactName);
    await mkdir(join(artifactRoot, "reviews"), { recursive: true });
    await writeFile(artifactPath, markdown, "utf8");

    const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
    const reviewers = manifest.reviewers.filter((item) => item.runnerId !== review.runnerId);
    reviewers.push({
      runnerId: review.runnerId,
      status: review.status,
      artifact: join("reviews", artifactName)
    });
    reviewers.sort((a, b) => a.runnerId.localeCompare(b.runnerId));

    const findings = manifest.findings.filter((item) => item.sourceRunnerId !== review.runnerId);
    findings.push(...review.findings);

    const nextManifest = {
      ...manifest,
      reviewers,
      findings
    };
    await saveManifestToArtifactRoot(artifactRoot, nextManifest);

    console.log(
      JSON.stringify(
        {
          status: "review_written",
          runnerId: review.runnerId,
          artifact: join("reviews", artifactName),
          findingCount: review.findings.length
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (command === "synthesize") {
    const artifactRoot = requireOption(args, "--artifact-root", "synthesize");
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
    console.log(JSON.stringify({ status: "synthesized", artifact, findingCount: findings.length }, null, 2));
    process.exit(0);
  }

  if (command === "decide") {
    const artifactRoot = requireOption(args, "--artifact-root", "decide");
    const input = requireOption(args, "--input", "decide");
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
    console.log(JSON.stringify({ status: "decision_recorded", artifact }, null, 2));
    process.exit(0);
  }

  if (command === "record-check") {
    const artifactRoot = requireOption(args, "--artifact-root", "record-check");
    const name = requireOption(args, "--name", "record-check");
    const status = requireOption(args, "--status", "record-check");
    const { manifest } = await loadManifestFromArtifactRoot(artifactRoot);
    const requiredChecks = manifest.requiredChecks.filter((check) => check.name !== name);
    requiredChecks.push({ name, status });
    requiredChecks.sort((a, b) => a.name.localeCompare(b.name));
    await saveManifestToArtifactRoot(artifactRoot, { ...manifest, requiredChecks });
    console.log(JSON.stringify({ status: "check_recorded", name }, null, 2));
    process.exit(0);
  }

  if (command === "verify") {
    const artifactRoot = requireOption(args, "--artifact-root", "verify");
    const runnerId = requireOption(args, "--runner-id", "verify");
    const status = requireOption(args, "--status", "verify");
    const input = requireOption(args, "--input", "verify");
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
    console.log(JSON.stringify({ status: "verification_recorded", artifact }, null, 2));
    process.exit(0);
  }

  if (command === "eval") {
    const corpusDir = readOption(args, "--corpus") || resolve("evals/kualityfore/corpus");
    const result = await runDeterministicEval(corpusDir);
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

function requireOption(args, name, commandName) {
  const value = readOption(args, name);
  if (!value) {
    throw new Error(`${commandName} requires ${name} <value>`);
  }
  return value;
}

function printHelp() {
  console.log(`KualityFore

Usage:
  kualityfore init --artifact-root <path> --run-id <id> [--profile <name>]
  kualityfore write-review --artifact-root <path> --input <review.md>
  kualityfore synthesize --artifact-root <path>
  kualityfore decide --artifact-root <path> --input <decision.md>
  kualityfore record-check --artifact-root <path> --name <name> --status <status>
  kualityfore verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
  kualityfore gate --manifest <path>
  kualityfore gate --artifact-root <path> [--policy <path>]
  kualityfore eval [--corpus <dir>]
`);
}
