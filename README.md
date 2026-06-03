# kualityforge

> KualityForge is an artifact-first quality gate system for multi-agent software delivery. It turns model reviews, human decisions, fixes, verification, tests, and eval evidence into deterministic release gates that can be called from Codex, Claude Code, xiaok, CI, or KSwarm workflows.

A local, auditable quality gate core for projects that need more than a single-agent code review.

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Status

KualityForge is in its bootstrap phase. The repository currently contains the first deterministic gate reducer slice:

- `manifest.json` / policy schema draft.
- `kualityforge init --artifact-root <path> --run-id <id>` CLI entry.
- `kualityforge gate --manifest <path>` and `kualityforge gate --artifact-root <path>` CLI entries.
- Review artifact ingestion through `kualityforge write-review`.
- Summary generation through `kualityforge synthesize`.
- Human decision, required check, and verification recording commands.
- Deterministic eval through `kualityforge eval`.
- Local artifact workflow through `kualityforge run`.
- Context pack freezing through `kualityforge init --project-root ... --docs-root ... --quality-principles ...`.
- KSwarm dynamic workflow preview and runtime plan generation through `kualityforge kswarm-preview`.
- KSwarm runtime executor core and offline smoke command through `kualityforge kswarm-run --offline`.
- Frozen unified changeset so every reviewer judges the identical file set, via `init --diff-base/--diff-head/--diff-max-patch-bytes` and `context/changeset.{json,md}`.
- Advisory per-reviewer scoring written to `scores.json` (deterministic, never blocks the gate).
- Per-round induced quality-principle candidates written to `induced-principles.{json,md}` (advisory; human decides adoption).
- Human report generation through `kualityforge report` (Markdown default, `--html` optional) with a fixed F#/G#/P# table template.
- Review artifact context acknowledgement, context provenance, context gaps, and quality principle violation parsing.
- Artifact reference validation rejects absolute paths and `..` traversal.
- Fail-closed reducer behavior for incomplete quality evidence.
- Unit tests for pass, reviewer shortage, invalid manifest, non-independent verifier, missing context, missing reviewer acknowledgement, low context confidence, and unresolved must-principle cases.
- Fixture, golden, CI, and E2E tests for artifact-root initialization, synthesis output, eval, and a clean passing run.
- Project docs via `docs -> ../mydocs/kualityforge`.

Live multi-agent runner dispatch is intentionally outside the deterministic core. The local `run` command consumes already-created artifacts; it does not call models. `kswarm-preview` emits the KSwarm `script_generated` preview and KualityForge runtime plan. `kswarm-run --offline` executes that plan against an in-memory KSwarm client for contract and artifact smoke testing; live KSwarm / Intent Broker adapters are separate integration work.

---

## Why KualityForge Exists

Modern AI coding workflows can generate code quickly, but release confidence is still fragile when quality checks are only chat transcripts or one model's opinion. KualityForge is built around a stricter premise:

**a quality gate should pass only when the evidence is complete, structured, independently verifiable, and reproducible.**

It is inspired by Viking's `review-forge` review / synthesize / fix / verify loop, but expands the idea into a general quality gate infrastructure:

- Multiple reviewers can inspect the same target independently.
- A synthesis step merges findings without losing dissent.
- A human decision gate chooses what is approved for fixing.
- Fixers may only fix approved findings.
- Independent verification checks that the fix actually addressed the approved scope.
- Required project checks and eval baselines become part of the release evidence.
- CI / ship workflows can consume a deterministic gate result instead of reading prose.

KualityForge is not a xiaok-only feature. The core is designed to be used by any project through a CLI, artifact folder, and policy file.

---

## Key Design Ideas

### 1. Artifact-First Quality

KualityForge treats files as the quality record. Reviews, synthesis, human decisions, fix plans, required checks, verification reports, and final gate status are written as artifacts under a run directory.

This gives the workflow three useful properties:

- It can be audited after the model session is gone.
- It can be resumed or re-reduced by another tool.
- It can be consumed by CI without asking a model to reinterpret chat history.

The intended artifact set is:

```text
docs/quality/<run-id>/
  manifest.json
  context/
    context-manifest.json
    quality-principles.json
    project-context.json
    project-brief.md
    docs-index.json
    instructions/
  reviews/
    codex.md
    claude.md
    xiaok.md
  summary.md
  decision.md
  fix-plan.md
  checks/
  verify.md
```

### 2. User Principles Above Project Goals

KualityForge can freeze user quality principles and project context before review starts. User quality principles are cross-project constraints; project goals explain what this project or change is trying to do.

When they conflict, user quality principles win. A reviewer cannot pass a release just because the local project goal says "ship quickly" if a must-level user principle requires independent verification, multi-reviewer evidence, or eval coverage.

The context pack captures:

- User quality principles.
- Project root and docs roots.
- `AGENTS.md`, `CLAUDE.md`, README, and selected instruction files.
- Design entrypoints and docs index.
- Change goal, non-goals, related repos, and required checks.
- Reviewer acknowledgement and context provenance.

### 3. Deterministic Gate, Non-Deterministic Reviewers

Model reviewers are allowed to be probabilistic. The gate reducer is not.

Given the same manifest, policy, and artifacts, `kualityforge gate` must always return the same status, reasons, and exit code. This keeps release automation stable even when the review phase uses different models or sessions.

Current gate statuses are intentionally conservative:

- `passed`: all required evidence is present and verified.
- `incomplete`: evidence is missing or unresolved.
- `failed`: a terminal failure or blocking condition exists.
- `invalid_artifact`: the manifest or artifact shape cannot be trusted.

### 4. Fail Closed

KualityForge should never turn missing evidence into success. Release-style profiles fail closed when any of these are missing or invalid:

- Required reviewer count.
- Human decision artifact.
- Required checks.
- Verification artifact.
- Independent verifier identity.
- Valid manifest shape.
- Resolved finding status.
- Required project context and user quality principles when policy requires them.
- Reviewer acknowledgement of required context.
- Matching context provenance when policy requires it.

This is a deliberate bias. A quality gate that occasionally blocks too much can be tuned; a gate that silently passes incomplete evidence cannot be trusted.

### 5. Human Decision Is the Fix Boundary

AI reviewers can find issues, but they should not decide unilaterally what gets changed. KualityForge keeps a hard boundary:

- Unchecked findings do not enter the fix queue.
- `wont_fix` and `risk_accepted` require an explicit decision record.
- Fix artifacts must not silently cover unapproved findings.
- Verification checks approved scope, not a vague claim that "everything is fine."

This preserves human judgment while still making review and verification automatable.

### 6. Independent Verification

For release profiles, the fixer and verifier must be different runner identities. A model or agent should not be allowed to fix a problem and then certify its own fix as the only evidence.

The first implementation enforces this at manifest level. Later KSwarm integration will enforce it at workflow scheduling level.

### 7. KSwarm as Orchestrator, KualityForge as Gate Core

KualityForge does not own durable workflow execution. That belongs in KSwarm.

The boundary is:

- KualityForge owns schemas, artifact parsing, reducers, CLI gates, tests, fixtures, and evals.
- KualityForge can generate a KSwarm `script_generated` workflow preview and a runtime plan.
- KualityForge provides an injectable runtime executor that can run the plan without hardcoding any model runner.
- KSwarm owns `kualityforge-flow`: fan-out state, retries, resume, cancellation, decision gates, and node scheduling.
- Intent Broker owns runner dispatch and event correlation.
- xiaok owns desktop / CLI entry points and user-facing status.

This keeps the gate core usable outside xiaok and outside KSwarm.

### 8. Eval Is Part of the Product

KualityForge itself must be tested and evaluated. A quality gate system cannot rely on a few successful real-world runs as proof.

The planned verification layers are:

- Unit / contract tests for schema, parser, reducer, status transitions, and exit codes.
- Fixture / golden tests for known artifact sets and expected gate results.
- Workflow tests for KSwarm node order, resume, retry, and human decision blocking.
- Adapter tests for Codex, Claude Code, and xiaok runner handoff.
- CI tests for machine-readable output and release blocking.
- E2E smoke tests with mock reviewers, fixer, and verifier.
- Deterministic eval over seeded bug and adversarial artifact corpora.
- Model-assisted eval as a release or nightly signal, not as the only gate evidence.

---

## Repository Layout

```text
kualityforge/
  src/
    cli/
      index.mjs
    core/
      gate-reducer.mjs
    index.mjs
  schemas/
    manifest.schema.json
    policy.schema.json
    context-manifest.schema.json
    project-context.schema.json
    quality-principles.schema.json
  tests/
    kualityforge/
      unit/
      fixtures/
      golden/
      workflow/
      adapters/
      ci/
      e2e/
  evals/
    kualityforge/
      corpus/
      reports/
  docs -> ../mydocs/kualityforge
```

---

## Quick Start

Run tests:

```bash
cd /Users/song/projects/kualityforge
npm test
```

Run the current gate CLI against a manifest:

```bash
node src/cli/index.mjs gate --manifest path/to/manifest.json
```

Initialize a run with frozen project context:

```bash
node src/cli/index.mjs init \
  --artifact-root docs/quality/<run-id> \
  --run-id <run-id> \
  --project-root /path/to/project \
  --docs-root /path/to/docs \
  --quality-principles /path/to/quality-principles.json \
  --change-goal "Review this release against the declared quality profile" \
  --instruction AGENTS.md \
  --instruction CLAUDE.md
```

After linking the package locally:

```bash
cd /Users/song/projects/kualityforge
npm link
```

the command shape becomes:

```bash
kualityforge gate --manifest path/to/manifest.json
```

Expected successful output:

```json
{
  "status": "passed",
  "exitCode": 0,
  "reasons": []
}
```

An incomplete run returns a non-zero exit code:

```json
{
  "status": "incomplete",
  "exitCode": 2,
  "reasons": [
    "reviewer shortage: expected at least 2, got 1",
    "verification artifact is required"
  ]
}
```

---

## Commands

Currently implemented:

```bash
kualityforge init --artifact-root <path> --run-id <id> [--profile <name>] [--diff-base <ref>] [--diff-head <ref|WORKTREE>] [--diff-max-patch-bytes <n>]
kualityforge run --artifact-root <path> --run-id <id> --review <review.md>... --decision <decision.md> --check <name=status> --verify <verify.md> --verifier-runner-id <id>
kualityforge write-review --artifact-root <path> --input <review.md>
kualityforge synthesize --artifact-root <path>
kualityforge decide --artifact-root <path> --input <decision.md>
kualityforge record-check --artifact-root <path> --name <name> --status <status>
kualityforge verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
kualityforge gate --manifest <path>
kualityforge gate --artifact-root <path>
kualityforge report --artifact-root <path> [--out <dir>|--report-out <dir>] [--html]
kualityforge kswarm-preview --project-id <id> --run-id <id> --artifact-root <path> --reviewer <runner-id>...
kualityforge kswarm-run --offline --preview <preview.json> --plan <runtime-plan.json> --review <runner-id=review.md>... --decision <decision.md> --check <name=status> [--verify <verify.md> --verifier-runner-id <id>]
kualityforge eval [--corpus <dir>] [--report <path>]
```

The `report` command renders a human report aggregating the gate result, frozen changeset, findings (F#), consensus findings (G#), advisory reviewer scores, and induced principle candidates (P#). Output directory precedence is the `--out`/`--report-out` flag, then the `KUALITYFORGE_REPORT_OUT_DIR` env var, then the built-in default.

Planned public commands:

```bash
kualityforge run --workflow kswarm
kualityforge adapter codex
kualityforge adapter claude
kualityforge adapter xiaok
```

Planned test commands:

```bash
npm run test:kualityforge:unit
npm run test:kualityforge:fixtures
npm run test:kualityforge:golden
npm run test:kualityforge:workflow
npm run test:kualityforge:adapters
npm run test:kualityforge:ci
npm run test:kualityforge:e2e
npm run eval:kualityforge
```

---

## Using KualityForge from Codex

Today, Codex can call the deterministic gate directly:

```bash
node /Users/song/projects/kualityforge/src/cli/index.mjs gate \
  --manifest docs/quality/<run-id>/manifest.json
```

The long-term shape is:

```bash
kualityforge run \
  --target . \
  --artifact-root docs/quality/<run-id> \
  --profile release \
  --workflow kswarm
```

Codex should not claim a full KualityForge gate pass unless the multi-agent artifact chain is complete: independent reviews, synthesis, human decision, approved-only fix, required checks, and independent verification.

A single Codex run can be recorded as a baseline, but it is not a completed multi-agent gate.

For local artifacts that already exist, Codex can run a deterministic local workflow today:

```bash
kualityforge run \
  --artifact-root docs/quality/<run-id> \
  --run-id <run-id> \
  --profile release \
  --review codex-review.md \
  --review claude-review.md \
  --decision decision.md \
  --check "npm test=passed" \
  --verify verify.md \
  --verifier-runner-id claude:verifier
```

To hand off orchestration to KSwarm dynamic workflow, Codex can first generate a script preview and runtime plan:

```bash
kualityforge kswarm-preview \
  --project-id <kswarm-project-id> \
  --run-id <run-id> \
  --artifact-root docs/quality/<run-id> \
  --reviewer codex:gpt-5 \
  --reviewer claude:sonnet \
  --project-root /path/to/project \
  --docs-root /path/to/project/docs \
  --quality-principles /path/to/quality-principles.json \
  --change-goal "Review this release against the declared quality profile"
```

The output contains:

- `preview`: the KSwarm `script_generated` workflow preview, including stable `scriptHash`, phases, scope, and fan-out analysis.
- `runtimePlan`: the KualityForge execution plan for the external runtime. It tells the runtime how to initialize artifacts, begin the KSwarm parallel reviewer group, dispatch reviewer nodes, write review artifacts, synthesize, verify, run the deterministic gate, and map the gate result back to KSwarm terminal status.

The runtime plan is not gate evidence by itself. Reviewer node output must still be written as KualityForge review artifacts and registered in `manifest.json`.

For a local smoke run against the runtime executor without connecting to a live KSwarm service:

```bash
kualityforge kswarm-run --offline \
  --preview preview.json \
  --plan runtime-plan.json \
  --review codex:gpt-5=codex-review.md \
  --review claude:sonnet=claude-review.md \
  --decision decision.md \
  --check "npm test=passed" \
  --verify verify.md \
  --verifier-runner-id claude:verifier
```

`--offline` uses an in-memory KSwarm client and is intended for contract smoke testing. It does not dispatch real agents.

---

## Documentation

Project documentation lives in `mydocs` through a symlink:

```text
/Users/song/projects/kualityforge/docs -> ../mydocs/kualityforge
```

Main docs:

- [Docs index](docs/README.md)
- [Artifact protocol](docs/protocol.md)
- [Bootstrap design](docs/design/2026-06-01-kualityforge-project-bootstrap-design.md)
- [KSwarm dynamic workflow integration](docs/design/2026-06-02-kswarm-dynamic-workflow-integration.md)
- [KSwarm dynamic workflow adversarial review](docs/design/2026-06-02-kswarm-dynamic-workflow-integration-adversarial-review.md)
- [KSwarm runtime executor design](docs/design/2026-06-02-kswarm-runtime-executor-design.md)
- [KSwarm runtime executor adversarial review](docs/design/2026-06-02-kswarm-runtime-executor-adversarial-review.md)
- [Quality records](docs/quality/README.md)
- [Eval records](docs/evals/README.md)

The report template spec is tracked in the repository itself (not under the `docs` symlink) so users can follow it to author reports:

- [Report template spec](templates/report-template.md)

---

## Development Rules

See:

- [AGENTS.md](AGENTS.md)
- [CLAUDE.md](CLAUDE.md)

Important rules:

- New behavior starts with design docs.
- High-risk core behavior needs adversarial review.
- Tests come before production changes.
- KualityForge core must stay project-agnostic.
- Project-specific release policy belongs in policy/profile files, not hardcoded reducer logic.
