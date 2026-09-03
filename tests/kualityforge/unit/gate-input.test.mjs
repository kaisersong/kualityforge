import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGateInputFromArtifactRoot } from "../../../src/core/gate-input.mjs";
import { DEFAULT_RELEASE_POLICY } from "../../../src/core/gate-reducer.mjs";
import {
  bindDecision,
  decisionMarkdown,
  reviewMarkdown,
  verificationMarkdown
} from "../helpers/artifact-fixtures.mjs";

async function seedArtifactRoot(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-gate-input-"));
  await mkdir(join(root, "reviews"), { recursive: true });

  // A real frozen changeset rather than a manifest-only flag: `available` is derived from
  // this file's contents, so seeding the reference alone would test the derivation
  // against nothing. The context manifest comes with it because the pack reconciliation
  // refuses a context file no descriptor claims.
  await mkdir(join(root, "context"), { recursive: true });
  const changesetBody = `${JSON.stringify({ available: true, files: [], patch: "" }, null, 2)}\n`;
  await writeFile(join(root, "context", "changeset.json"), changesetBody, "utf8");
  const changesetHash = createHash("sha256").update(changesetBody, "utf8").digest("hex");
  const projectBriefBody = "# Project brief\n";
  await writeFile(join(root, "context", "project-brief.md"), projectBriefBody, "utf8");
  const projectBriefHash = createHash("sha256")
    .update(projectBriefBody, "utf8")
    .digest("hex");

  const descriptorBody = `${JSON.stringify(
    {
      files: {
        changeset: { artifact: "context/changeset.json", sha256: changesetHash },
        projectBrief: {
          artifact: "context/project-brief.md",
          sha256: projectBriefHash
        }
      }
    },
    null,
    2
  )}\n`;
  await writeFile(join(root, "context", "context-manifest.json"), descriptorBody, "utf8");
  const contextManifestHash = createHash("sha256")
    .update(descriptorBody, "utf8")
    .digest("hex");
  const rawFinding = {
    id: "QF-001",
    title: FINDING_TITLE,
    description:
      "A concern was found that may impact code quality, security, or maintainability if not addressed appropriately in a timely manner",
    suggestion:
      "Review the identified area and consider applying the recommended improvement to enhance overall code quality",
    severity: "info"
  };
  const decidedFinding = {
    ...rawFinding,
    type: "code",
    principleId: null,
    priority: null,
    status: "risk_accepted",
    duplicateKey: "potential issue identified during review requiring further investigation and resolution",
    sourceRunnerId: "claude:sonnet",
    sourceRunnerIds: ["claude:sonnet", "codex:gpt-5"],
    reviewerCount: 2,
    decisionReason: "accepted for this run"
  };
  await writeFile(
    join(root, "reviews", "codex.md"),
    reviewMarkdown({ runnerId: "codex:gpt-5", contextManifestHash, findings: [rawFinding] }),
    "utf8"
  );
  await writeFile(
    join(root, "reviews", "claude.md"),
    reviewMarkdown({ runnerId: "claude:sonnet", contextManifestHash, findings: [rawFinding] }),
    "utf8"
  );

  const manifest = bindDecision({
    runId: "gate-input-run",
    context: {
      contextManifest: {
        artifact: "context/context-manifest.json",
        sha256: contextManifestHash
      },
      changeset: { artifact: "context/changeset.json", sha256: changesetHash },
      projectBrief: {
        artifact: "context/project-brief.md",
        sha256: projectBriefHash
      }
    },
    status: "verified",
    reviewers: [
      {
        runnerId: "codex:gpt-5",
        artifact: "reviews/codex.md",
        status: "completed",
        contextProvenance: { contextManifestHash }
      },
      {
        runnerId: "claude:sonnet",
        artifact: "reviews/claude.md",
        status: "completed",
        contextProvenance: { contextManifestHash }
      }
    ],
    verification: {
      runnerId: "claude:verifier",
      status: "verified",
      artifact: "verify.md",
      verdicts: [{ findingId: "QF-001", status: "confirmed" }],
      verdictCount: 1,
      confirmedCount: 1,
      dismissedCount: 0,
      cannotVerifyCount: 0,
      coveredFindingIds: ["QF-001"],
      uncoveredOpenFindingIds: [],
      disputedFindings: []
    },
    findings: [decidedFinding],
    requiredChecks: [{ name: "npm test", status: "passed" }],
    ...overrides
  });
  await writeFile(
    join(root, "decision.md"),
    decisionMarkdown({ runId: manifest.runId, findings: manifest.findings, owner: manifest.humanDecision.owner }),
    "utf8"
  );
  await writeFile(
    join(root, "verify.md"),
    verificationMarkdown({
      runnerId: manifest.verification.runnerId,
      verdicts: manifest.verification.verdicts || []
    }),
    "utf8"
  );
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return root;
}

test("a fully backed artifact root reduces to a passed gate", async () => {
  const root = await seedArtifactRoot();
  try {
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, []);
    assert.equal(gate.status, "passed", gate.reasons.join("; "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reviewer artifact that does not exist on disk is an invalid artifact", async () => {
  const root = await seedArtifactRoot();
  try {
    await rm(join(root, "reviews", "claude.md"));
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, ["reviewers[1].artifact reviews/claude.md does not exist"]);
    assert.equal(gate.status, "invalid_artifact");
    assert.equal(gate.exitCode, 1);
    assert.match(gate.reasons.join("\n"), /reviews\/claude\.md does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty artifact file is not evidence", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(join(root, "verify.md"), "", "utf8");
    const { gate } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(gate.reasons.join("\n"), /verification\.artifact verify\.md is empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an artifact reference pointing at a directory is not evidence", async () => {
  const root = await seedArtifactRoot();
  try {
    await mkdir(join(root, "reviews", "dir.md"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.reviewers[0].artifact = "reviews/dir.md";
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    const { gate } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(gate.reasons.join("\n"), /reviews\/dir\.md is not a file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a filesystem permission failure is a process fault, not a gate verdict", async () => {
  const root = await seedArtifactRoot();
  const locked = join(root, "reviews", "locked");
  try {
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, "codex.md"), "codex review body", "utf8");
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.reviewers[0].artifact = "reviews/locked/codex.md";
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await chmod(locked, 0o000);
    await assert.rejects(() => loadGateInputFromArtifactRoot(root), /EACCES|EPERM/);
  } finally {
    await chmod(locked, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing artifact field is reported before the path is joined", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({ runId: "gate-input-run", status: "verified", reviewers: [{ runnerId: "a" }], findings: [], requiredChecks: [] }, null, 2),
      "utf8"
    );
    const { gate } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(gate.reasons.join("\n"), /reviewers\[0\]\.artifact must be a non-empty string/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Mutates the seeded manifest rather than writing a fresh one, so the context the root
// was seeded with stays claimed. A from-scratch manifest drops those declarations and the
// case then reports unclaimed context files it was never about.
async function seedWithReviewerArtifact(artifact) {
  const root = await seedArtifactRoot();
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  manifest.reviewers[0].artifact = artifact;
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return root;
}

// The reference names a path that does not exist outside the root, so probing it
// would report "does not exist". An empty integrityErrors proves the join never
// happened rather than merely that the verdict came out right.
for (const [name, artifact] of [
  ["a traversal reference", "../../kualityforge-outside-probe.md"],
  ["an absolute reference", "/kualityforge-outside-probe.md"],
  ["a Windows drive reference", "C:\\kualityforge-outside-probe.md"]
]) {
  test(`${name} is never probed on disk and still fails the gate closed`, async () => {
    const root = await seedWithReviewerArtifact(artifact);
    try {
      const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
      assert.deepEqual(integrityErrors, []);
      assert.equal(gate.status, "invalid_artifact");
      assert.match(gate.reasons.join("\n"), /reviewers\[0\]\.artifact must stay within artifact root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a symlink that escapes the artifact root is not evidence", async () => {
  const outside = await mkdtemp(join(tmpdir(), "kualityforge-outside-"));
  const root = await seedWithReviewerArtifact("reviews/escape.md");
  try {
    await writeFile(join(outside, "planted.md"), "planted review body", "utf8");
    await symlink(join(outside, "planted.md"), join(root, "reviews", "escape.md"));
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, [
      "reviewers[0].artifact reviews/escape.md resolves outside the artifact root"
    ]);
    assert.equal(gate.status, "invalid_artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a reference that is not already in canonical protocol form is rejected", async () => {
  const root = await seedWithReviewerArtifact("reviews/./codex.md");
  try {
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, [
      "reviewers[0].artifact reviews/./codex.md is not a canonical artifact path"
    ]);
    assert.equal(gate.status, "invalid_artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A permission field is a claim about what a runner was allowed to do. Nothing in
// this repository enforces such a claim, so accepting one as gate input would let a
// manifest or policy assert an enforcement that does not exist. The six frozen keys
// include the `permissions` container, which is what stops an unknown inner key from
// arriving through a field nobody has enumerated yet.
const PERMISSION_CELLS = [
  {
    name: "a manifest declaring deniedCommands at the top level",
    manifest: { deniedCommands: ["git diff"] },
    reason: "manifest.deniedCommands"
  },
  {
    name: "a manifest carrying a permissions container",
    manifest: { permissions: { deniedCommands: ["git diff"] } },
    reason: "manifest.permissions"
  },
  {
    name: "a manifest declaring allowShell at the top level",
    manifest: { allowShell: true },
    reason: "manifest.allowShell"
  }
];

for (const cell of PERMISSION_CELLS) {
  test(`${cell.name} is refused as gate input`, async () => {
    const root = await seedArtifactRoot(cell.manifest);
    try {
      const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
      assert.deepEqual(integrityErrors, [
        `${cell.reason} declares permissions the gate cannot enforce`
      ]);
      assert.equal(gate.status, "invalid_artifact");
      assert.equal(gate.exitCode, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a permissions container nested under an array index is refused as gate input", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-gate-input-"));
  try {
    await mkdir(join(root, "reviews"), { recursive: true });
    await writeFile(
      join(root, "reviews", "codex.md"),
      reviewMarkdown({ runnerId: "codex:gpt-5", findings: [] }),
      "utf8"
    );
    await writeFile(
      join(root, "reviews", "claude.md"),
      reviewMarkdown({ runnerId: "claude:sonnet", findings: [] }),
      "utf8"
    );
    const manifest = bindDecision({
      runId: "gate-input-run",
      status: "verified",
      reviewers: [
        {
          runnerId: "codex:gpt-5",
          artifact: "reviews/codex.md",
          status: "completed",
          isVacuous: true,
          permissions: { allowShell: true }
        },
        {
          runnerId: "claude:sonnet",
          artifact: "reviews/claude.md",
          status: "completed",
          isVacuous: true
        }
      ],
      verification: {
        runnerId: "claude:verifier",
        status: "verified",
        artifact: "verify.md",
        verdicts: [],
        verdictCount: 0,
        confirmedCount: 0,
        dismissedCount: 0,
        cannotVerifyCount: 0,
        coveredFindingIds: [],
        uncoveredOpenFindingIds: [],
        disputedFindings: []
      },
      findings: [],
      requiredChecks: [{ name: "npm test", status: "passed" }]
    });
    await writeFile(
      join(root, "decision.md"),
      decisionMarkdown({ runId: manifest.runId, findings: manifest.findings }),
      "utf8"
    );
    await writeFile(
      join(root, "verify.md"),
      verificationMarkdown({ runnerId: "claude:verifier", verdicts: [] }),
      "utf8"
    );
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, [
      "manifest.reviewers[0].permissions declares permissions the gate cannot enforce"
    ]);
    assert.equal(gate.status, "invalid_artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, policy, reason] of [
  [
    "a policy declaring deniedCommands at the top level",
    { ...DEFAULT_RELEASE_POLICY, deniedCommands: ["git diff"] },
    "policy.deniedCommands"
  ],
  [
    "a policy declaring deniedCommands under context",
    {
      ...DEFAULT_RELEASE_POLICY,
      context: { ...DEFAULT_RELEASE_POLICY.context, deniedCommands: ["git diff"] }
    },
    "policy.context.deniedCommands"
  ]
]) {
  test(`${name} is refused as gate input`, async () => {
    const root = await seedArtifactRoot();
    try {
      const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root, policy);
      assert.deepEqual(integrityErrors, [`${reason} declares permissions the gate cannot enforce`]);
      assert.equal(gate.status, "invalid_artifact");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a payload nested deeper than the scan can reach fails closed instead of being skipped", async () => {
  // Without a depth verdict a deep enough payload starves the scan and the gate
  // silently returns to its pre-B8 behaviour, so the limit is itself a judgement.
  let nested = { permissions: { deniedCommands: ["git diff"] } };
  for (let index = 0; index < 8; index += 1) {
    nested = { wrapper: nested };
  }
  const root = await seedArtifactRoot({ trailer: nested });
  try {
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(integrityErrors.length, 1);
    assert.match(integrityErrors[0], /exceeds the maximum permission scan depth/);
    assert.equal(gate.status, "invalid_artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an artifact root with no permission claims stays clean", async () => {
  const root = await seedArtifactRoot();
  try {
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, []);
    assert.equal(gate.status, "passed", gate.reasons.join("; "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Stat answers "is there a file here", which is the wrong question. Every cell below
// leaves a reference that exists, is a non-empty regular file and resolves inside the
// root, and every one of them used to reduce to a passed gate.
test("a reviewer artifact whose bytes are not a review is not evidence", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(join(root, "reviews", "codex.md"), "not a KualityForge artifact", "utf8");
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.equal(gate.exitCode, 1);
    assert.match(
      integrityErrors.join("\n"),
      /reviewers\[0\]\.artifact reviews\/codex\.md is not a replayable review artifact/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reviewer artifact written by a different runner is not that reviewer's evidence", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(
      join(root, "reviews", "codex.md"),
      reviewMarkdown({ runnerId: "claude:sonnet" }),
      "utf8"
    );
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.deepEqual(integrityErrors, [
      "reviewers[0].artifact reviews/codex.md was written by claude:sonnet, not codex:gpt-5"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The write path deliberately takes the last of several fences, because a KSwarm
// handoff transcript honestly carries more than one. Replay must not, or the attacker
// picks which bytes count as the evidence.
test("a reviewer artifact carrying two review fences is not evidence", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(
      join(root, "reviews", "codex.md"),
      reviewMarkdown({ runnerId: "claude:sonnet" }) + reviewMarkdown({ runnerId: "codex:gpt-5" }),
      "utf8"
    );
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(integrityErrors.join("\n"), /exactly one kualityforge-review block/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reviewer artifact that does not map to protocol findings is not evidence", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(
      join(root, "reviews", "codex.md"),
      reviewMarkdown({
        runnerId: "codex:gpt-5",
        findings: [{ title: "t", description: "d", suggestion: "s", severity: "high" }]
      }),
      "utf8"
    );
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(
      integrityErrors.join("\n"),
      /reviews\/codex\.md does not map to protocol findings/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A reference into context/ passes every other check, and context/ holds files copied
// out of the project under review — so without a mandated location a malicious
// project can plant its own "review".
test("a reviewer artifact outside reviews/ is refused before its bytes are trusted", async () => {
  const root = await seedArtifactRoot();
  try {
    await mkdir(join(root, "context", "instructions"), { recursive: true });
    await writeFile(
      join(root, "context", "instructions", "planted.md"),
      reviewMarkdown({ runnerId: "codex:gpt-5" }),
      "utf8"
    );
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.reviewers[0].artifact = "context/instructions/planted.md";
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(
      integrityErrors.join("\n"),
      /reviewers\[0\]\.artifact context\/instructions\/planted\.md must live under reviews\//
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reviewer artifact that is not markdown is refused", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(
      join(root, "reviews", "codex.txt"),
      reviewMarkdown({ runnerId: "codex:gpt-5" }),
      "utf8"
    );
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.reviewers[0].artifact = "reviews/codex.txt";
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(integrityErrors.join("\n"), /reviews\/codex\.txt must end with \.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Dropping the reviewer entry that carried a blocker leaves no trace anywhere in the
// manifest: the artifact is still on disk, still valid, still reachable. With the
// default minReviewers of 2, three reviewers minus one still satisfies the count.
test("a review artifact on disk that the manifest does not claim fails the gate closed", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(
      join(root, "reviews", "xiaok.md"),
      reviewMarkdown({ runnerId: "xiaok" }),
      "utf8"
    );
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, [
      "reviews/ contains reviews/xiaok.md, which no manifest reviewer claims"
    ]);
    assert.equal(gate.status, "invalid_artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unclaimed review artifact hidden in a subdirectory is still found", async () => {
  const root = await seedArtifactRoot();
  try {
    await mkdir(join(root, "reviews", "hidden"), { recursive: true });
    await writeFile(
      join(root, "reviews", "hidden", "xiaok.md"),
      reviewMarkdown({ runnerId: "xiaok" }),
      "utf8"
    );
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, [
      "reviews/ contains reviews/hidden/xiaok.md, which no manifest reviewer claims"
    ]);
    assert.equal(gate.status, "invalid_artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the .gitkeep every artifact root is initialized with is not an unclaimed review", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(join(root, "reviews", ".gitkeep"), "", "utf8");
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.deepEqual(integrityErrors, []);
    assert.equal(gate.status, "passed", gate.reasons.join("; "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reviewer status the artifact does not report is not evidence", async () => {
  const root = await seedArtifactRoot();
  try {
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.reviewers[0].status = "failed";
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(
      integrityErrors.join("\n"),
      /reviewers\[0\]\.status failed does not match completed in reviews\/codex\.md/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// isVacuous decides whether a review counts toward the quorum, and it is derived from
// the length of the finding text. Recomputing it from the manifest copy would let a
// padded description in the manifest flip an empty review into a substantive one.
test("an empty review cannot claim to be substantive", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(
      join(root, "reviews", "codex.md"),
      reviewMarkdown({ runnerId: "codex:gpt-5", findings: [] }),
      "utf8"
    );
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(
      integrityErrors.join("\n"),
      /reviewers\[0\]\.isVacuous false does not match true derived from reviews\/codex\.md/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a review whose findings are too short to be substantive cannot claim otherwise", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(
      join(root, "reviews", "codex.md"),
      reviewMarkdown({
        runnerId: "codex:gpt-5",
        findings: [{ title: "too short", description: "brief", suggestion: "fix", severity: "info" }]
      }),
      "utf8"
    );
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(integrityErrors.join("\n"), /isVacuous false does not match true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [field, forgedValue] of [
  ["contextRead", { projectBrief: true }],
  ["contextConfidence", "high"],
  ["contextGaps", ["forged manifest-only gap"]],
  ["contextProvenance", { contextManifestHash: "0".repeat(64) }],
  ["principleAlignment", { principleId: "forged" }]
]) {
  test(`reviewer ${field} is bound to the raw review document`, async () => {
    const root = await seedArtifactRoot();
    try {
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      manifest.reviewers[0][field] = forgedValue;
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

      const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
      assert.equal(gate.status, "invalid_artifact");
      assert.match(integrityErrors.join("\n"), new RegExp(field));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("manifest findings must equal the synthesized and decided raw review projection", async () => {
  const root = await seedArtifactRoot();
  try {
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    manifest.findings = [{
      id: "QF-FORGED",
      type: "code",
      principleId: null,
      priority: null,
      title: "Forged blocker",
      severity: "blocker",
      status: "risk_accepted",
      sourceRunnerId: "codex:gpt-5",
      sourceRunnerIds: ["codex:gpt-5"]
    }];
    bindDecision(manifest);
    await writeFile(
      join(root, "decision.md"),
      decisionMarkdown({ runId: manifest.runId, findings: manifest.findings }),
      "utf8"
    );
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(integrityErrors.join("\n"), /findings/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decision artifact is strictly replayed instead of trusting manifest decision fields", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(join(root, "decision.md"), "# prose only\n", "utf8");
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(integrityErrors.join("\n"), /decision.*machine-readable|replayable decision/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification artifact is strictly replayed into the derived manifest", async () => {
  const root = await seedArtifactRoot();
  try {
    await writeFile(join(root, "verify.md"), "# prose only\n", "utf8");
    const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
    assert.equal(gate.status, "invalid_artifact");
    assert.match(integrityErrors.join("\n"), /verification artifact must include/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [field, tamper] of [
  ["runnerId", (verification) => { verification.runnerId = "mallory:verifier"; }],
  ["status", (verification) => { verification.status = "disputed"; }],
  ["verdictCount", (verification) => { verification.verdictCount = 2; }],
  ["confirmedCount", (verification) => { verification.confirmedCount = 0; }],
  ["dismissedCount", (verification) => { verification.dismissedCount = 1; }],
  ["cannotVerifyCount", (verification) => { verification.cannotVerifyCount = 1; }],
  ["coveredFindingIds", (verification) => { verification.coveredFindingIds = []; }],
  ["uncoveredOpenFindingIds", (verification) => { verification.uncoveredOpenFindingIds = ["QF-001"]; }],
  ["disputedFindings", (verification) => { verification.disputedFindings = ["QF-001"]; }],
  ["verdict notes", (verification) => {
    verification.verdicts[0].notes = "forged manifest-only note";
  }],
  ["verdicts", (verification) => {
    verification.verdicts = [{ findingId: "QF-001", status: "dismissed" }];
  }]
]) {
  test(`manifest verification ${field} must match replayed verification`, async () => {
    const root = await seedArtifactRoot();
    try {
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      tamper(manifest.verification);
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

      const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
      assert.equal(gate.status, "invalid_artifact");
      assert.match(integrityErrors.join("\n"), /manifest verification does not match replayed verification/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const status of ["fixed", "verification_failed"]) {
  test(`manifest-only ${status} finding fails closed without a machine-readable fix artifact`, async () => {
    const root = await seedArtifactRoot();
    try {
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      manifest.findings = [{
        id: "QF-001",
        type: "code",
        principleId: null,
        priority: null,
        title: FINDING_TITLE,
        severity: "info",
        status,
        sourceRunnerId: "codex:gpt-5",
        sourceRunnerIds: ["codex:gpt-5", "claude:sonnet"]
      }];
      bindDecision(manifest);
      await writeFile(
        join(root, "decision.md"),
        decisionMarkdown({ runId: manifest.runId, findings: manifest.findings }),
        "utf8"
      );
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

      const { gate, integrityErrors } = await loadGateInputFromArtifactRoot(root);
      assert.equal(gate.status, "invalid_artifact");
      assert.match(integrityErrors.join("\n"), /findings/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const FINDING_TITLE =
  "Potential issue identified during review requiring further investigation and resolution";
