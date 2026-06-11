#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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
  runReviewWorkflow,
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

  if (command === "review") {
    const projectRoot = readOption(args, "--project");
    const artifactRoot = readOption(args, "--artifact-root");
    const runId = readOption(args, "--run-id");
    const profile = readOption(args, "--profile");
    const decisionPath = readOption(args, "--decision");
    const verifyPath = readOption(args, "--verify");
    const verifierRunnerId = readOption(args, "--verifier-runner-id");
    const policyPath = readOption(args, "--policy");
    const outDir = readOption(args, "--out") || readOption(args, "--report-out") || undefined;
    const hasReport = args.includes("--report");
    const html = args.includes("--html");
    const lang = readOption(args, "--lang") || undefined;

    const agentArgs = readOptions(args, "--agent");
    const reviewerArgs = readOptions(args, "--reviewer");
    const checkArgs = readOptions(args, "--check");

    if (agentArgs.length === 0 && reviewerArgs.length === 0) {
      throw new Error("review requires at least one --agent <name> or --agent <name=path>");
    }

    const { planReview: planReviewFn } = await import("../core/review-workflow.mjs");

    const parsedAgents = parseAgentOptions(agentArgs);
    const plainAgents = [];
    const pathAgents = [];
    for (const { name, path } of parsedAgents) {
      if (path) {
        pathAgents.push({ runnerId: name, path });
      } else {
        plainAgents.push(name);
      }
    }

    const reviewerMap = parseKeyValueOptions(reviewerArgs, "--reviewer");
    const pathReviewers = [...reviewerMap].map(([runnerId, path]) => ({ runnerId, path }));

    const allPathReviewers = [...pathAgents, ...pathReviewers];

    if (plainAgents.length > 0 && allPathReviewers.length === 0) {
      const resolvedRunId = runId || `review-${Date.now()}`;
      const stagingDir = artifactRoot
        ? join(artifactRoot, "staging")
        : projectRoot
          ? join(projectRoot, "docs", "quality", resolvedRunId, "staging")
          : join("/tmp", `kualityforge-staging-${resolvedRunId}`);
      const plan = planReviewFn(plainAgents, { projectRoot, lang: lang || undefined });
      const assignments = plan.assignments.map((a) => ({
        agent: a.agent,
        dimensions: a.dimensions,
        reviewPath: join(stagingDir, `${a.agent}.md`)
      }));
      const nextCommand = [
        "kualityforge review",
        projectRoot ? `--project ${projectRoot}` : `--artifact-root ${artifactRoot}`,
        ...assignments.map((a) => `--agent ${a.agent}=${a.reviewPath}`),
        ...(reviewerArgs.length > 0 ? reviewerArgs.map((r) => `--reviewer ${r}`) : []),
        ...(decisionPath ? [`--decision ${decisionPath}`] : []),
        ...(checkArgs.length > 0 ? checkArgs.map((c) => `--check ${c}`) : []),
        ...(verifyPath ? [`--verify ${verifyPath}`] : []),
        ...(verifierRunnerId ? [`--verifier-runner-id ${verifierRunnerId}`] : []),
        ...(hasReport ? ["--report"] : []),
        ...(html ? ["--html"] : []),
        ...(lang ? [`--lang ${lang}`] : []),
        ...(outDir ? [`--out ${outDir}`] : [])
      ].join(" \\\n  ");

      console.log(
        JSON.stringify(
          {
            status: "plan_created",
            stagingDir,
            runId: resolvedRunId,
            assignments,
            nextCommand
          },
          null,
          2
        )
      );
      process.exit(0);
    }

    if (allPathReviewers.length === 0) {
      throw new Error("review requires at least one --agent <name=path> or --reviewer <runnerId=path> to run the workflow");
    }

    const checks = checkArgs.map(parseCheckOption);

    if (verifyPath && !verifierRunnerId) {
      throw new Error("review requires --verifier-runner-id <id> when --verify is provided");
    }

    const result = await runReviewWorkflow({
      projectRoot,
      artifactRoot,
      runId,
      profile,
      reviewers: allPathReviewers,
      decisionPath,
      checks,
      verifyPath,
      verifierRunnerId,
      report: hasReport,
      html,
      lang,
      outDir,
      policyPath
    });

    console.log(
      JSON.stringify(
        {
          status: result.gate.status,
          artifactRoot: result.artifactRoot,
          runId: result.runId,
          gate: result.gate,
          ...(result.report ? { report: result.report } : {})
        },
        null,
        2
      )
    );
    process.exit(result.gate.exitCode);
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
    const context = readContextOptions(args) || {};
    const projectRoot = context.projectRoot || readOption(args, "--project-root") || null;

    const projectId = readOption(args, "--project-id") ||
      (projectRoot ? basename(resolve(projectRoot)) : basename(process.cwd()));

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const runId = readOption(args, "--run-id") || `${projectId}-${today}`;

    const defaultArtifactRoot = process.env.KUALITYFORGE_ARTIFACT_ROOT_BASE
      ? join(process.env.KUALITYFORGE_ARTIFACT_ROOT_BASE, projectId, "quality", runId)
      : join(process.cwd(), "kualityforge-runs", runId);
    const artifactRoot = readOption(args, "--artifact-root") || defaultArtifactRoot;

    const reviewerArgs = readOptions(args, "--reviewer");
    const advisoryReviewers = readOptions(args, "--advisory-reviewer");
    const quorumMinText = readOption(args, "--quorum-min");
    const target = readOption(args, "--target") || ".";
    const requestedBy = readOption(args, "--requested-by");
    const createdAtText = readOption(args, "--created-at");
    const createdAt = createdAtText ? Number(createdAtText) : undefined;

    let reviewers = reviewerArgs.map(normalizeReviewerShortName);

    if (reviewers.length === 0) {
      const kswarmUrl = readOption(args, "--kswarm-url") || process.env.KSWARM_URL;
      if (kswarmUrl) {
        const discoveredReviewers = await discoverOnlineReviewers(kswarmUrl);
        if (discoveredReviewers.length === 0) {
          throw new Error(
            "No online reviewers found in KSwarm. Start at least one agent (codex, claude, qoder, xiaok) or pass --reviewer <name> explicitly."
          );
        }
        reviewers = discoveredReviewers;
        process.stderr.write(`Auto-selected reviewers from KSwarm: ${reviewers.join(", ")}\n`);
      } else {
        throw new Error(
          "kswarm-preview requires at least one --reviewer <name> (e.g. codex, claude, qoder, xiaok), or set KSWARM_URL to auto-discover online agents."
        );
      }
    }

    const reviewPolicy = buildReviewPolicy(reviewers, advisoryReviewers.map(normalizeReviewerShortName), quorumMinText);
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
    process.stderr.write(`Project:       ${projectId}\n`);
    process.stderr.write(`Run ID:        ${runId}\n`);
    process.stderr.write(`Artifact root: ${artifactRoot}\n`);
    process.stderr.write(`Reviewers:     ${dispatchedReviewers.join(", ")}\n`);
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  if (command === "kswarm-run") {
    const mode = resolveKswarmRunMode(args);
    const previewPath = readOption(args, "--preview");
    const planPath = readOption(args, "--plan");
    const decisionPath = readOption(args, "--decision");
    const checks = readOptions(args, "--check").map(parseCheckOption);
    const verifyPath = readOption(args, "--verify");
    const verifierRunnerId = readOption(args, "--verifier-runner-id");
    const verifyStatus = readOption(args, "--verify-status") || "verified";
    if (verifyPath && !verifierRunnerId) {
      throw new Error("kswarm-run requires --verifier-runner-id <id> when --verify is provided");
    }

    let preview, runtimePlan;

    if (previewPath && planPath) {
      preview = JSON.parse(await readFile(previewPath, "utf8"));
      runtimePlan = JSON.parse(await readFile(planPath, "utf8"));
    } else if (!previewPath && !planPath) {
      if (mode !== "brokered") {
        throw new Error("kswarm-run --offline requires --preview <preview.json> and --plan <runtime-plan.json>");
      }
      const context = readContextOptions(args) || {};
      const projectRoot = context.projectRoot || readOption(args, "--project-root") || null;
      const projectId = readOption(args, "--project-id") ||
        (projectRoot ? basename(resolve(projectRoot)) : basename(process.cwd()));
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const runId = readOption(args, "--run-id") || `${projectId}-${today}`;
      const defaultArtifactRoot = process.env.KUALITYFORGE_ARTIFACT_ROOT_BASE
        ? join(process.env.KUALITYFORGE_ARTIFACT_ROOT_BASE, projectId, "quality", runId)
        : join(process.cwd(), "kualityforge-runs", runId);
      const artifactRoot = readOption(args, "--artifact-root") || defaultArtifactRoot;

      const reviewerArgs = readOptions(args, "--reviewer");
      let reviewers = reviewerArgs.map(normalizeReviewerShortName);
      if (reviewers.length === 0) {
        const kswarmUrl = readOption(args, "--kswarm-url") || process.env.KSWARM_URL;
        if (kswarmUrl) {
          const discovered = await discoverOnlineReviewers(kswarmUrl);
          if (discovered.length === 0) {
            throw new Error("No online reviewers found in KSwarm. Start agents or pass --reviewer <name>.");
          }
          reviewers = discovered;
          process.stderr.write(`Auto-selected reviewers: ${reviewers.join(", ")}\n`);
        } else {
          throw new Error("kswarm-run requires --reviewer <name> or KSWARM_URL to auto-discover agents.");
        }
      }

      const advisoryReviewers = readOptions(args, "--advisory-reviewer").map(normalizeReviewerShortName);
      const quorumMinText = readOption(args, "--quorum-min");
      const reviewPolicy = buildReviewPolicy(reviewers, advisoryReviewers, quorumMinText);
      const dispatchedReviewers = reviewPolicy
        ? [...reviewPolicy.requiredReviewers, ...reviewPolicy.advisoryReviewers]
        : reviewers;

      const workflowOptions = {
        projectId,
        runId,
        artifactRoot,
        reviewers: dispatchedReviewers,
        target: readOption(args, "--target") || ".",
        requestedBy: readOption(args, "--requested-by"),
        ...context
      };
      preview = createKswarmScriptPreview(workflowOptions);
      runtimePlan = createKswarmRuntimePlan(workflowOptions);

      process.stderr.write(`Project:       ${projectId}\n`);
      process.stderr.write(`Run ID:        ${runId}\n`);
      process.stderr.write(`Artifact root: ${artifactRoot}\n`);
      process.stderr.write(`Reviewers:     ${dispatchedReviewers.join(", ")}\n`);
    } else {
      throw new Error("kswarm-run: provide both --preview and --plan, or neither (inline mode).");
    }

    const advisoryReviewers = readOptions(args, "--advisory-reviewer").map(normalizeReviewerShortName);
    const quorumMinText = readOption(args, "--quorum-min");
    const planReviewers = Array.isArray(runtimePlan.reviewers)
      ? runtimePlan.reviewers.map((reviewer) => reviewer.runnerId)
      : [];
    const advisorySet = new Set(advisoryReviewers);
    const requiredReviewers = planReviewers.filter((runnerId) => !advisorySet.has(runnerId));
    const reviewPolicy = buildReviewPolicy(requiredReviewers, advisoryReviewers, quorumMinText);
    const policy = reviewPolicy ? { review: reviewPolicy } : undefined;

    const sharedProviders = {
      decisionProvider: decisionPath
        ? async () => readFile(decisionPath, "utf8")
        : undefined,
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
      const kswarmUrl = readOption(args, "--kswarm-url") || process.env.KSWARM_URL || (() => {
        throw new Error("kswarm-run --mode brokered requires --kswarm-url <url> or KSWARM_URL env var");
      })();
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
        lang: readOption(args, "--lang") || undefined,
        ...sharedProviders
      });

      const noReport = args.includes("--no-report");
      const wantHtml = !args.includes("--no-html");
      const explicitReportOut = readOption(args, "--report-out");
      const defaultReportOut = dirname(runtimePlan.artifactRoot);
      const reportOutDir = explicitReportOut || defaultReportOut;

      const brokeredReport = !noReport
        ? await writeReportFromArtifactRoot(runtimePlan.artifactRoot, {
            outDir: reportOutDir,
            html: wantHtml,
            lang: readOption(args, "--lang") || undefined,
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
      lang: readOption(args, "--lang") || undefined,
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
          lang: readOption(args, "--lang") || undefined,
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
    const lang = readOption(args, "--lang") || undefined;
    const output = await synthesizeArtifactRoot(artifactRoot, { lang });
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
    const artifactRoot = readOption(args, "--artifact-root");
    const inputPath = readOption(args, "--input");
    const outDir = readOption(args, "--out") || readOption(args, "--report-out") || undefined;
    const outputFile = readOption(args, "--output");
    const html = args.includes("--html");
    const lang = readOption(args, "--lang") || undefined;

    if (inputPath) {
      const raw = JSON.parse(await readFile(inputPath, "utf8"));
      const { buildReportModel, renderReportHtml, renderReportMarkdown } = await import("../core/report.mjs");
      const model = buildReportModel({
        manifest: raw.manifest || raw,
        summaryMarkdown: raw.summaryMarkdown || "",
        scores: raw.scores || null,
        inducedPrinciples: raw.inducedPrinciples || null,
        changeset: raw.changeset || null,
        gate: raw.gate || null,
        reviewType: raw.reviewType || "changeset",
        projectOverview: raw.projectOverview || null,
        reviewerDetails: raw.reviewerDetails || null,
        riskMatrix: raw.riskMatrix || null,
        actionPlan: raw.actionPlan || null,
        overallGrade: raw.overallGrade || null
      });
      const langOpt = { lang };
      const runId = model.runId || "run";

      if (outputFile) {
        const content = html ? renderReportHtml(model, langOpt) : renderReportMarkdown(model, langOpt);
        await writeFile(outputFile, content, "utf8");
        console.log(JSON.stringify({ status: "report_written", path: outputFile, format: html ? "html" : "markdown" }, null, 2));
      } else {
        const content = html ? renderReportHtml(model, langOpt) : renderReportMarkdown(model, langOpt);
        process.stdout.write(content);
      }
      process.exit(0);
    }

    if (!artifactRoot) {
      throw new Error("report requires --artifact-root <path> or --input <manifest.json>");
    }
    const result = await writeReportFromArtifactRoot(artifactRoot, { outDir, html, lang });
    console.log(JSON.stringify({ status: "report_written", ...result }, null, 2));
    process.exit(0);
  }

  if (command === "eval") {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const corpusDir = readOption(args, "--corpus") || resolve(moduleDir, "..", "..", "evals", "kualityforge", "corpus");
    const report = readOption(args, "--report");
    const result = await runDeterministicEval(corpusDir);
    if (report) {
      await writeFile(report, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "passed" ? 0 : 1);
  }

  if (command === "list-agents") {
    const kswarmUrl = readOption(args, "--kswarm-url") || process.env.KSWARM_URL || (() => {
      throw new Error("list-agents requires --kswarm-url <url> or KSWARM_URL env var");
    })();
    const client = createKswarmHttpClient({ baseUrl: kswarmUrl });

    const [agentsResult, livenessResult, participantsResult] = await Promise.allSettled([
      client.listAgents(),
      client.listAgentsLiveness(),
      client.listParticipants()
    ]);

    const agents = agentsResult.status === "fulfilled" ? (agentsResult.value.agents || []) : [];
    const liveness = livenessResult.status === "fulfilled" ? (livenessResult.value.liveness || {}) : {};
    const participants = participantsResult.status === "fulfilled"
      ? (participantsResult.value.participants || participantsResult.value || [])
      : [];
    const participantIds = new Set(participants.map((p) => p.participantId || p.id).filter(Boolean));

    if (args.includes("--json")) {
      console.log(JSON.stringify({ agents, liveness, participants }, null, 2));
      process.exit(0);
    }

    if (agents.length === 0 && participants.length === 0) {
      console.log("No agents or participants found.");
      process.exit(0);
    }

    const col = (s, w) => String(s ?? "").padEnd(w).slice(0, w);
    const header = `${"ID".padEnd(28)}  ${"NAME".padEnd(24)}  ${"RUNTIME TYPE".padEnd(18)}  ${"ONLINE".padEnd(7)}  PARTICIPANT`;
    const sep = "-".repeat(header.length);
    console.log(header);
    console.log(sep);

    for (const agent of agents) {
      const live = liveness[agent.id] || {};
      const online = live.online ? "yes" : (live.lastSeen ? "no" : "—");
      const isParticipant = participantIds.has(agent.id) ? "broker" : "";
      console.log(
        `${col(agent.id, 28)}  ${col(agent.name, 24)}  ${col(agent.runtimeType || agent.type || "", 18)}  ${col(online, 7)}  ${isParticipant}`
      );
    }

    if (participants.length > 0) {
      const knownAgentIds = new Set(agents.map((a) => a.id));
      const brokerOnly = participants.filter((p) => {
        const id = p.participantId || p.id;
        return id && !knownAgentIds.has(id);
      });
      if (brokerOnly.length > 0) {
        console.log("");
        console.log("Broker-only participants (not in agent store):");
        for (const p of brokerOnly) {
          const id = p.participantId || p.id || "?";
          const name = p.name || p.participantId || "";
          console.log(`  ${col(id, 28)}  ${name}`);
        }
      }
    }

    if (agentsResult.status === "rejected") {
      console.error(`\nWarning: could not fetch agents: ${agentsResult.reason?.message}`);
    }
    if (participantsResult.status === "rejected") {
      console.error(`Warning: could not fetch participants (broker may be offline): ${participantsResult.reason?.message}`);
    }

    process.exit(0);
  }

  throw new Error(`unknown command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(64);
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
  const enableStructureScan = args.includes("--enable-structure-scan");
  const reviewType = readOption(args, "--review-type");

  if (
    !projectRoot &&
    docsRoots.length === 0 &&
    !qualityPrinciplesPath &&
    !changeGoal &&
    instructionFiles.length === 0 &&
    designEntrypoints.length === 0 &&
    !changeset &&
    !enableStructureScan &&
    !reviewType
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
    ...(changeset ? { changeset } : {}),
    ...(enableStructureScan ? { enableStructureScan } : {}),
    ...(reviewType ? { reviewType } : {})
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

function parseAgentOptions(values) {
  const result = [];
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator === -1) {
      result.push({ name: value, path: null });
    } else {
      result.push({ name: value.slice(0, separator), path: value.slice(separator + 1) });
    }
  }
  return result;
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

function normalizeReviewerShortName(name) {
  return String(name || "").trim();
}

async function discoverOnlineReviewers(kswarmUrl) {
  const client = createKswarmHttpClient({ baseUrl: kswarmUrl });
  const [agentsResult, livenessResult] = await Promise.allSettled([
    client.listAgents(),
    client.listAgentsLiveness()
  ]);

  if (agentsResult.status === "rejected") {
    throw new Error(`Cannot reach KSwarm at ${kswarmUrl}: ${agentsResult.reason?.message}`);
  }

  const agents = agentsResult.value.agents || [];
  const liveness = livenessResult.status === "fulfilled" ? (livenessResult.value.liveness || {}) : {};

  const EXCLUDED_RUNTIME_TYPES = new Set(["xiaok", "xiaok-cli", "builtin"]);
  const seen = new Set();
  const reviewers = [];

  for (const agent of agents) {
    if (agent.archivedAt) continue;
    const rt = agent.runtimeType;
    if (!rt || EXCLUDED_RUNTIME_TYPES.has(rt) || seen.has(rt)) continue;
    const live = liveness[agent.id] || {};
    if (!live.online) continue;
    seen.add(rt);
    reviewers.push(rt);
  }

  return reviewers;
}

function printHelp() {
  console.log(`KualityForge

Usage:
  kualityforge init --artifact-root <path> --run-id <id> [--profile <name>] [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>] [--instruction <path>] [--design-entrypoint <path>] [--diff-base <ref>] [--diff-head <ref|WORKTREE>] [--diff-max-patch-bytes <n>]
  kualityforge run --artifact-root <path> --run-id <id> --review <review.md>... --decision <decision.md> --check <name=status> --verify <verify.md> --verifier-runner-id <id> [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>]
  kualityforge review --project <path> --agent <name>... [--agent <name=path.md>]... [--report] [--html] [--lang <zh|en>] [--out <dir>]
  kualityforge write-review --artifact-root <path> --input <review.md>
  kualityforge synthesize --artifact-root <path>
  kualityforge decide --artifact-root <path> --input <decision.md>
  kualityforge record-check --artifact-root <path> --name <name> --status <status>
  kualityforge verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
  kualityforge gate --manifest <path>
  kualityforge gate --artifact-root <path> [--policy <path>]
  kualityforge report --artifact-root <path> [--out <dir>|--report-out <dir>] [--html]
  kualityforge report --input <manifest.json> [--html] [--lang <zh|en>] [--output <file>]
  kualityforge kswarm-preview [--project-id <id>] [--run-id <id>] [--artifact-root <path>] [--reviewer <name>...] [--advisory-reviewer <name>...] [--quorum-min <n>] [--kswarm-url <url>] [--project-root <path>] [--docs-root <path>] [--quality-principles <json>] [--change-goal <text>] [--target <path>] [--requested-by <id>]
  kualityforge kswarm-run --offline --preview <preview.json> --plan <runtime-plan.json> --review <runner-id=review.md>... [--advisory-reviewer <runner-id>...] [--quorum-min <n>] --decision <decision.md> --check <name=status> [--verify <verify.md> --verifier-runner-id <id>]
  kualityforge kswarm-run --mode brokered [--kswarm-url <url>] [--preview <preview.json> --plan <runtime-plan.json>] [--reviewer <name>...] [--advisory-reviewer <name>...] [--quorum-min <n>] [--decision <decision.md>] [--check <name=status>] [--verify <verify.md> --verifier-runner-id <id>] [--report-out <dir>] [--no-report] [--no-html] [--lang <zh|en>] [--poll-interval-ms <ms>] [--timeout-ms <ms>]
  kualityforge list-agents [--kswarm-url <url>] [--json]
  kualityforge eval [--corpus <dir>] [--report <path>]

Reports:
  report output directory precedence: --report-out flag, then KUALITYFORGE_REPORT_OUT_DIR env var, then the built-in default.

KSwarm URL:
  --kswarm-url can be omitted when KSWARM_URL env var is set. Affects: kswarm-run --mode brokered, kswarm-preview (auto-discover), list-agents.

Smart defaults (kswarm-preview and kswarm-run --mode brokered):
  --project-id    defaults to the directory name of --project-root (or cwd if omitted).
  --run-id        defaults to <project-id>-<YYYYMMDD>.
  --artifact-root defaults to $KUALITYFORGE_ARTIFACT_ROOT_BASE/<project-id>/quality/<run-id> if env var set,
                  otherwise ./kualityforge-runs/<run-id> relative to cwd.
  --reviewer      if omitted and KSWARM_URL/--kswarm-url is set, all online non-xiaok agents are auto-selected.
  --preview/--plan omit both for inline mode: kswarm-run builds them from the same args as kswarm-preview.
  --decision      optional in brokered mode; omit if no human-decision artifact is available.
  --report-out    defaults to the parent of artifact-root (the quality/<run-id>/../ dir).
  HTML report is generated by default; use --no-report or --no-html to suppress.
  Reviewer names accept short forms: codex, claude, qoder, xiaok (KSwarm routes to the active agent).

Quorum review:
  --reviewer marks a required reviewer; --advisory-reviewer marks an advisory (non-blocking) reviewer.
  --advisory-reviewer cannot downgrade a runner already declared as --reviewer (required); doing so is rejected.
  --quorum-min <n> enables quorum mode: at least n of the quorum members (required + advisory) must succeed.
  Required reviewers are never exempted: a missing or failed required reviewer always blocks the gate,
  while advisory absence only records warnings.
`);
}
