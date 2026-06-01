import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = resolve("src/cli/index.mjs");

test("eval --report writes deterministic eval output", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-eval-report-"));
  try {
    const reportPath = join(root, "report.json");
    const result = spawnSync(process.execPath, [cliPath, "eval", "--report", reportPath], {
      cwd: resolve("."),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.status, "passed");
    assert.equal(report.total, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
