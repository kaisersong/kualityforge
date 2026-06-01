# kualityfore

> KualityFore is an artifact-first quality gate system for multi-agent software delivery. It turns model reviews, human decisions, fixes, verification, tests, and eval evidence into deterministic release gates that can be called from Codex, Claude Code, xiaok, CI, or KSwarm workflows.

A local, auditable quality gate core for projects that need more than a single-agent code review.

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Status

KualityFore is in its bootstrap phase. The repository currently contains the first deterministic gate reducer slice:

- `manifest.json` / policy schema draft.
- `kualityfore init --artifact-root <path> --run-id <id>` CLI entry.
- `kualityfore gate --manifest <path>` and `kualityfore gate --artifact-root <path>` CLI entries.
- Review artifact ingestion through `kualityfore write-review`.
- Summary generation through `kualityfore synthesize`.
- Human decision, required check, and verification recording commands.
- Deterministic eval through `kualityfore eval`.
- Local artifact workflow through `kualityfore run`.
- Artifact reference validation rejects absolute paths and `..` traversal.
- Fail-closed reducer behavior for incomplete quality evidence.
- Unit tests for pass, reviewer shortage, invalid manifest, and non-independent verifier cases.
- Fixture, golden, CI, and E2E tests for artifact-root initialization, synthesis output, eval, and a clean passing run.
- Project docs via `docs -> ../mydocs/kualityfore`.

Live multi-agent runner dispatch and KSwarm orchestration are intentionally staged after the deterministic core. The local `run` command consumes already-created artifacts; it does not call models.

---

## Why KualityFore Exists

Modern AI coding workflows can generate code quickly, but release confidence is still fragile when quality checks are only chat transcripts or one model's opinion. KualityFore is built around a stricter premise:

**a quality gate should pass only when the evidence is complete, structured, independently verifiable, and reproducible.**

It is inspired by Viking's `review-forge` review / synthesize / fix / verify loop, but expands the idea into a general quality gate infrastructure:

- Multiple reviewers can inspect the same target independently.
- A synthesis step merges findings without losing dissent.
- A human decision gate chooses what is approved for fixing.
- Fixers may only fix approved findings.
- Independent verification checks that the fix actually addressed the approved scope.
- Required project checks and eval baselines become part of the release evidence.
- CI / ship workflows can consume a deterministic gate result instead of reading prose.

KualityFore is not a xiaok-only feature. The core is designed to be used by any project through a CLI, artifact folder, and policy file.

---

## Key Design Ideas

### 1. Artifact-First Quality

KualityFore treats files as the quality record. Reviews, synthesis, human decisions, fix plans, required checks, verification reports, and final gate status are written as artifacts under a run directory.

This gives the workflow three useful properties:

- It can be audited after the model session is gone.
- It can be resumed or re-reduced by another tool.
- It can be consumed by CI without asking a model to reinterpret chat history.

The intended artifact set is:

```text
docs/quality/<run-id>/
  manifest.json
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

### 2. Deterministic Gate, Non-Deterministic Reviewers

Model reviewers are allowed to be probabilistic. The gate reducer is not.

Given the same manifest, policy, and artifacts, `kualityfore gate` must always return the same status, reasons, and exit code. This keeps release automation stable even when the review phase uses different models or sessions.

Current gate statuses are intentionally conservative:

- `passed`: all required evidence is present and verified.
- `incomplete`: evidence is missing or unresolved.
- `failed`: a terminal failure or blocking condition exists.
- `invalid_artifact`: the manifest or artifact shape cannot be trusted.

### 3. Fail Closed

KualityFore should never turn missing evidence into success. Release-style profiles fail closed when any of these are missing or invalid:

- Required reviewer count.
- Human decision artifact.
- Required checks.
- Verification artifact.
- Independent verifier identity.
- Valid manifest shape.
- Resolved finding status.

This is a deliberate bias. A quality gate that occasionally blocks too much can be tuned; a gate that silently passes incomplete evidence cannot be trusted.

### 4. Human Decision Is the Fix Boundary

AI reviewers can find issues, but they should not decide unilaterally what gets changed. KualityFore keeps a hard boundary:

- Unchecked findings do not enter the fix queue.
- `wont_fix` and `risk_accepted` require an explicit decision record.
- Fix artifacts must not silently cover unapproved findings.
- Verification checks approved scope, not a vague claim that "everything is fine."

This preserves human judgment while still making review and verification automatable.

### 5. Independent Verification

For release profiles, the fixer and verifier must be different runner identities. A model or agent should not be allowed to fix a problem and then certify its own fix as the only evidence.

The first implementation enforces this at manifest level. Later KSwarm integration will enforce it at workflow scheduling level.

### 6. KSwarm as Orchestrator, KualityFore as Gate Core

KualityFore does not own durable workflow execution. That belongs in KSwarm.

The boundary is:

- KualityFore owns schemas, artifact parsing, reducers, CLI gates, tests, fixtures, and evals.
- KSwarm owns `kualityfore-flow`: fan-out, retries, resume, cancellation, decision gates, and node scheduling.
- Intent Broker owns runner dispatch and event correlation.
- xiaok owns desktop / CLI entry points and user-facing status.

This keeps the gate core usable outside xiaok and outside KSwarm.

### 7. Eval Is Part of the Product

KualityFore itself must be tested and evaluated. A quality gate system cannot rely on a few successful real-world runs as proof.

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
kualityfore/
  src/
    cli/
      index.mjs
    core/
      gate-reducer.mjs
    index.mjs
  schemas/
    manifest.schema.json
    policy.schema.json
  tests/
    kualityfore/
      unit/
      fixtures/
      golden/
      workflow/
      adapters/
      ci/
      e2e/
  evals/
    kualityfore/
      corpus/
      reports/
  docs -> ../mydocs/kualityfore
```

---

## Quick Start

Run tests:

```bash
cd /Users/song/projects/kualityfore
npm test
```

Run the current gate CLI against a manifest:

```bash
node src/cli/index.mjs gate --manifest path/to/manifest.json
```

After linking the package locally:

```bash
cd /Users/song/projects/kualityfore
npm link
```

the command shape becomes:

```bash
kualityfore gate --manifest path/to/manifest.json
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
kualityfore init --artifact-root <path> --run-id <id> [--profile <name>]
kualityfore run --artifact-root <path> --run-id <id> --review <review.md>... --decision <decision.md> --check <name=status> --verify <verify.md> --verifier-runner-id <id>
kualityfore write-review --artifact-root <path> --input <review.md>
kualityfore synthesize --artifact-root <path>
kualityfore decide --artifact-root <path> --input <decision.md>
kualityfore record-check --artifact-root <path> --name <name> --status <status>
kualityfore verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
kualityfore gate --manifest <path>
kualityfore gate --artifact-root <path>
kualityfore eval [--corpus <dir>] [--report <path>]
```

Planned public commands:

```bash
kualityfore run --workflow kswarm
kualityfore adapter codex
kualityfore adapter claude
kualityfore adapter xiaok
```

Planned test commands:

```bash
npm run test:kualityfore:unit
npm run test:kualityfore:fixtures
npm run test:kualityfore:golden
npm run test:kualityfore:workflow
npm run test:kualityfore:adapters
npm run test:kualityfore:ci
npm run test:kualityfore:e2e
npm run eval:kualityfore
```

---

## Using KualityFore from Codex

Today, Codex can call the deterministic gate directly:

```bash
node /Users/song/projects/kualityfore/src/cli/index.mjs gate \
  --manifest docs/quality/<run-id>/manifest.json
```

The long-term shape is:

```bash
kualityfore run \
  --target . \
  --artifact-root docs/quality/<run-id> \
  --profile release \
  --workflow kswarm
```

Codex should not claim a full KualityFore gate pass unless the multi-agent artifact chain is complete: independent reviews, synthesis, human decision, approved-only fix, required checks, and independent verification.

A single Codex run can be recorded as a baseline, but it is not a completed multi-agent gate.

For local artifacts that already exist, Codex can run a deterministic local workflow today:

```bash
kualityfore run \
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

---

## Documentation

Project documentation lives in `mydocs` through a symlink:

```text
/Users/song/projects/kualityfore/docs -> ../mydocs/kualityfore
```

Main docs:

- [Docs index](docs/README.md)
- [Bootstrap design](docs/design/2026-06-01-kualityfore-project-bootstrap-design.md)
- [Quality records](docs/quality/README.md)
- [Eval records](docs/evals/README.md)

---

## Development Rules

See:

- [AGENTS.md](AGENTS.md)
- [CLAUDE.md](CLAUDE.md)

Important rules:

- New behavior starts with design docs.
- High-risk core behavior needs adversarial review.
- Tests come before production changes.
- KualityFore core must stay project-agnostic.
- Project-specific release policy belongs in policy/profile files, not hardcoded reducer logic.
