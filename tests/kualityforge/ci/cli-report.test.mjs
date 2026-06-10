import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = resolve("src/cli/index.mjs");

test("report command writes Markdown and HTML with scores and induced sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-report-"));
  const outDir = join(root, "out");
  try {
    assert.equal(
      runCli(["init", "--artifact-root", root, "--run-id", "report-run", "--profile", "release"]).status,
      0
    );

    const codexReview = await writeReview(root, "codex.md", "codex:gpt-5");
    const claudeReview = await writeReview(root, "claude.md", "claude:sonnet");
    assert.equal(runCli(["write-review", "--artifact-root", root, "--input", codexReview]).status, 0);
    assert.equal(runCli(["write-review", "--artifact-root", root, "--input", claudeReview]).status, 0);

    const synthesize = runCli(["synthesize", "--artifact-root", root]);
    assert.equal(synthesize.status, 0, synthesize.stderr);

    const report = runCli(["report", "--artifact-root", root, "--out", outDir, "--html"]);
    assert.equal(report.status, 0, report.stderr);

    const result = JSON.parse(report.stdout);
    assert.equal(result.status, "report_written");
    assert.ok(result.markdownPath.endsWith("report-run-report.md"));
    assert.ok(result.htmlPath.endsWith("report-run-report.html"));

    const markdown = await readFile(result.markdownPath, "utf8");
    assert.match(markdown, /评审员评分/);
    assert.match(markdown, /归纳质量原则候选/);

    const html = await readFile(result.htmlPath, "utf8");
    assert.match(html, /评审员评分/);
    assert.match(html, /归纳质量原则候选/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report command honors KUALITYFORGE_REPORT_OUT_DIR when no flag is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-report-env-"));
  const envOutDir = join(root, "env-out");
  try {
    assert.equal(
      runCli(["init", "--artifact-root", root, "--run-id", "env-run", "--profile", "release"]).status,
      0
    );
    const codexReview = await writeReview(root, "codex.md", "codex:gpt-5");
    const claudeReview = await writeReview(root, "claude.md", "claude:sonnet");
    assert.equal(runCli(["write-review", "--artifact-root", root, "--input", codexReview]).status, 0);
    assert.equal(runCli(["write-review", "--artifact-root", root, "--input", claudeReview]).status, 0);
    assert.equal(runCli(["synthesize", "--artifact-root", root]).status, 0);

    const report = runCli(["report", "--artifact-root", root], {
      KUALITYFORGE_REPORT_OUT_DIR: envOutDir
    });
    assert.equal(report.status, 0, report.stderr);

    const result = JSON.parse(report.stdout);
    assert.ok(result.markdownPath.startsWith(envOutDir), result.markdownPath);
    await readFile(result.markdownPath, "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeReview(root, filename, runnerId) {
  const path = join(root, filename);
  await writeFile(
    path,
    `# Review

\`\`\`kualityforge-review
{
  "runnerId": "${runnerId}",
  "status": "completed",
  "contextRead": { "user_quality_principles": true, "project_brief": true },
  "contextConfidence": "high",
  "findings": [
    {
      "id": "${runnerId}-F1",
      "title": "Shared cache needs locking to prevent race conditions during concurrent access from multiple threads",
      "description": "The shared cache module does not implement proper synchronization which may lead to data corruption or inconsistent reads when accessed concurrently",
      "suggestion": "Add appropriate locking mechanisms such as mutexes or read-write locks around cache operations to ensure thread-safe access",
      "severity": "blocker",
      "status": "risk_accepted",
      "duplicateKey": "race-cache"
    }
  ]
}
\`\`\`
`,
    "utf8"
  );
  return path;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env
  });
}
