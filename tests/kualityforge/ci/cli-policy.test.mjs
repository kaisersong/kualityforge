import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  deriveManifestVerification,
  parseVerificationArtifact
} from "../../../src/core/verification-artifact.mjs";
import {
  decisionMarkdown,
  reviewMarkdown,
  synthesizeReviewFindings,
  verificationMarkdown
} from "../helpers/artifact-fixtures.mjs";

const cliPath = resolve("src/cli/index.mjs");
const POLICY_FINDINGS = synthesizeReviewFindings([
  {
    runnerId: "codex",
    findings: [
      {
        title: "Potential issue identified during review requiring further investigation and resolution",
        description:
          "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
        suggestion:
          "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
        severity: "info"
      }
    ]
  }
]);

// gate only reads an artifact root now, so a policy test has to put the backing
// evidence on disk rather than hand the reducer a bare manifest. The review files are
// derived from the manifest's reviewers because the gate reconciles the two: a file
// with no reviewer entry, or an entry naming another runner, is an integrity error.
async function seedArtifactRoot(prefix, manifestOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "reviews"), { recursive: true });
  await writeFile(
    join(root, "decision.md"),
    decisionMarkdown({ runId: "policy-run", findings: POLICY_FINDINGS }),
    "utf8"
  );
  const verificationBody = verificationMarkdown({ runnerId: "verifier" });
  await writeFile(
    join(root, "verify.md"),
    verificationBody,
    "utf8"
  );

  await mkdir(join(root, "context"), { recursive: true });
  const changesetBody = `${JSON.stringify({ available: true, files: [], patch: "" }, null, 2)}\n`;
  await writeFile(join(root, "context", "changeset.json"), changesetBody, "utf8");
  const changesetHash = createHash("sha256").update(changesetBody, "utf8").digest("hex");
  const projectBriefBody = "# Project brief\n";
  await writeFile(join(root, "context", "project-brief.md"), projectBriefBody, "utf8");
  const projectBriefHash = createHash("sha256").update(projectBriefBody, "utf8").digest("hex");
  const descriptorBody = `${JSON.stringify(
    {
      files: {
        changeset: { artifact: "context/changeset.json", sha256: changesetHash },
        projectBrief: { artifact: "context/project-brief.md", sha256: projectBriefHash }
      }
    },
    null,
    2
  )}\n`;
  await writeFile(join(root, "context", "context-manifest.json"), descriptorBody, "utf8");
  const contextManifestHash = createHash("sha256").update(descriptorBody, "utf8").digest("hex");

  const manifest = {
    runId: "policy-run",
    context: {
      contextManifest: {
        artifact: "context/context-manifest.json",
        sha256: contextManifestHash
      },
      changeset: { artifact: "context/changeset.json", sha256: changesetHash },
      projectBrief: { artifact: "context/project-brief.md", sha256: projectBriefHash }
    },
    status: "verified",
    humanDecision: {
      artifact: "decision.md",
      status: "parsed",
      owner: "kai",
      runId: "policy-run",
      findingSetDigest: "sha256:placeholder-replayed-from-decision",
      decidedAt: "2026-08-30T10:00:00Z"
    },
    reviewers: [
      {
        runnerId: "codex",
        artifact: "reviews/codex.md",
        status: "completed",
        contextProvenance: { contextManifestHash }
      },
      {
        runnerId: "claude",
        artifact: "reviews/claude.md",
        status: "completed",
        contextProvenance: { contextManifestHash }
      }
    ],
    verification: {
      runnerId: "verifier",
      status: "verified",
      artifact: "verify.md",
      verdicts: []
    },
    findings: POLICY_FINDINGS,
    requiredChecks: [{ name: "npm test", status: "passed" }],
    ...manifestOverrides
  };
  const canonicalFindings = synthesizeReviewFindings(
    manifest.reviewers.map(({ runnerId }) => ({
      runnerId,
      findings: [
        {
          title: "Potential issue identified during review requiring further investigation and resolution",
          description:
            "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
          suggestion:
            "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
          severity: "info"
        }
      ]
    }))
  );
  manifest.findings = canonicalFindings.map((finding) => ({
    ...finding,
    status: "risk_accepted",
    decisionReason: "accepted for this run"
  }));
  manifest.verification = deriveManifestVerification(
    parseVerificationArtifact(verificationBody),
    manifest.findings,
    { artifact: "verify.md" }
  );
  await writeFile(
    join(root, "decision.md"),
    decisionMarkdown({ runId: "policy-run", findings: canonicalFindings }),
    "utf8"
  );
  manifest.reviewers = manifest.reviewers.map((reviewer) => ({
    ...reviewer,
    contextProvenance: { contextManifestHash }
  }));
  for (const reviewer of manifest.reviewers) {
    await writeFile(
      join(root, reviewer.artifact),
      reviewMarkdown({ runnerId: reviewer.runnerId, contextManifestHash }),
      "utf8"
    );
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return root;
}

test("gate --policy applies project-specific reviewer threshold", async () => {
  const root = await seedArtifactRoot("kualityforge-policy-cli-", {
    reviewers: [{ runnerId: "codex", artifact: "reviews/codex.md", status: "completed" }]
  });
  try {
    const policyPath = join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({ minReviewers: 1 }, null, 2), "utf8");

    const result = spawnSync(
      process.execPath,
      [cliPath, "gate", "--artifact-root", root, "--policy", policyPath],
      { cwd: resolve("."), encoding: "utf8" }
    );

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate --policy rejects valid JSON with an invalid policy shape", async () => {
  const root = await seedArtifactRoot("kualityforge-invalid-policy-cli-");
  try {
    const policyPath = join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({ minReviewers: 0 }, null, 2), "utf8");

    const result = spawnSync(
      process.execPath,
      [cliPath, "gate", "--artifact-root", root, "--policy", policyPath],
      { cwd: resolve("."), encoding: "utf8" }
    );

    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "invalid_artifact");
    assert.match(output.reasons.join("\n"), /policy\.minReviewers must be an integer greater than or equal to 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate --policy enforces required project context", async () => {
  const root = await seedArtifactRoot("kualityforge-context-policy-cli-");
  try {
    const policyPath = join(root, "policy.json");
    await writeFile(
      policyPath,
      JSON.stringify(
        {
          context: {
            projectContextRequired: true,
            qualityPrinciplesRequired: true
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [cliPath, "gate", "--artifact-root", root, "--policy", policyPath],
      { cwd: resolve("."), encoding: "utf8" }
    );

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "incomplete");
    assert.match(output.reasons.join("\n"), /quality principles artifact is required/);
    assert.match(output.reasons.join("\n"), /project context artifact is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
