import { join } from "node:path";
import {
  initializeArtifactRoot,
  loadManifestFromArtifactRoot,
  loadPolicyFile,
  recordCheckResult,
  recordDecisionFile,
  recordVerificationFile,
  reduceQualityGate,
  synthesizeArtifactRoot,
  writeReportFromArtifactRoot,
  writeReviewFileToArtifactRoot
} from "../index.mjs";

export const REVIEW_DIMENSIONS = [
  { id: "security-performance", label: { zh: "安全与性能", en: "Security & Performance" }, keywords: ["密钥管理", "IPC安全", "内存泄漏", "XSS", "注入", "key management", "IPC security", "memory leak", "injection"] },
  { id: "code-architecture", label: { zh: "代码质量与架构", en: "Code Quality & Architecture" }, keywords: ["模块耦合", "类型安全", "目录结构", "module coupling", "type safety", "directory structure"] },
  { id: "ui-ux", label: { zh: "UI/UX 与可维护性", en: "UI/UX & Maintainability" }, keywords: ["组件复用", "状态管理", "i18n", "component reuse", "state management"] },
  { id: "business-logic", label: { zh: "业务逻辑与迁移完整性", en: "Business Logic & Migration Integrity" }, keywords: ["数据流", "迁移状态", "业务规则", "data flow", "migration status"] },
  { id: "build-scripts", label: { zh: "构建/安装/部署脚本", en: "Build/Install/Deploy Scripts" }, keywords: ["DelTree", "rm-rf", "打包", "签名", "packaging", "signing", "installer"] }
];

export function assignDimensions(agentNames, { lang = "zh" } = {}) {
  if (!agentNames || agentNames.length === 0) {
    return [];
  }

  const count = agentNames.length;
  const dimensionCount = REVIEW_DIMENSIONS.length;

  const assignments = agentNames.map((name) => ({ agent: name, dimensions: [] }));

  if (count >= dimensionCount) {
    for (let i = 0; i < dimensionCount; i += 1) {
      assignments[i].dimensions.push(REVIEW_DIMENSIONS[i]);
    }
    for (let i = dimensionCount; i < count; i += 1) {
      assignments[i].dimensions.push(REVIEW_DIMENSIONS[i % dimensionCount]);
    }
  } else {
    for (let i = 0; i < dimensionCount; i += 1) {
      assignments[i % count].dimensions.push(REVIEW_DIMENSIONS[i]);
    }
  }

  return assignments.map(({ agent, dimensions }) => ({
    agent,
    dimensions: dimensions.map((d) => ({
      id: d.id,
      label: d.label[lang] || d.label.zh,
      keywords: d.keywords
    }))
  }));
}

export function planReview(agentNames, { projectRoot, lang = "zh" } = {}) {
  const assignments = assignDimensions(agentNames, { lang });
  return {
    projectRoot: projectRoot || ".",
    agentCount: agentNames.length,
    dimensionCount: REVIEW_DIMENSIONS.length,
    assignments,
    reviewType: "full-project"
  };
}

export async function runReviewWorkflow({
  projectRoot,
  artifactRoot,
  runId,
  profile,
  reviewers,
  decisionPath,
  checks,
  verifyPath,
  verifierRunnerId,
  report,
  html,
  lang,
  outDir,
  policyPath
}) {
  if (!reviewers || reviewers.length === 0) {
    throw new Error("review requires at least one --reviewer <runnerId=path>");
  }

  const resolvedRunId = runId || `review-${Date.now()}`;
  const resolvedArtifactRoot =
    artifactRoot || (projectRoot ? join(projectRoot, "docs", "quality", resolvedRunId) : undefined);

  if (!resolvedArtifactRoot) {
    throw new Error("review requires --project <path> or --artifact-root <path>");
  }

  const context = projectRoot ? { projectRoot, enableStructureScan: true, reviewType: "full-project" } : undefined;

  await initializeArtifactRoot(resolvedArtifactRoot, {
    runId: resolvedRunId,
    profile: profile || "default",
    context
  });

  for (const { runnerId, path } of reviewers) {
    await writeReviewFileToArtifactRoot(resolvedArtifactRoot, path);
  }

  await synthesizeArtifactRoot(resolvedArtifactRoot, { lang });

  if (decisionPath) {
    await recordDecisionFile(resolvedArtifactRoot, decisionPath);
  }

  if (checks && checks.length > 0) {
    for (const { name, status } of checks) {
      await recordCheckResult(resolvedArtifactRoot, name, status);
    }
  }

  if (verifyPath) {
    if (!verifierRunnerId) {
      throw new Error("review requires --verifier-runner-id <id> when --verify is provided");
    }
    await recordVerificationFile(resolvedArtifactRoot, verifyPath, {
      runnerId: verifierRunnerId,
      status: "verified"
    });
  }

  const { manifest } = await loadManifestFromArtifactRoot(resolvedArtifactRoot);
  const policy = policyPath ? await loadPolicyFile(policyPath) : undefined;
  const gate = reduceQualityGate(manifest, policy);

  let reportResult = null;
  if (report) {
    reportResult = await writeReportFromArtifactRoot(resolvedArtifactRoot, {
      outDir,
      html,
      lang,
      gate
    });
  }

  return {
    artifactRoot: resolvedArtifactRoot,
    runId: resolvedRunId,
    gate,
    report: reportResult
  };
}
