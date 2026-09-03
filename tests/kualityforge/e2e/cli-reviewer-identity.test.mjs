import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { reviewMarkdown } from "../helpers/artifact-fixtures.mjs";

const cliPath = resolve("src/cli/index.mjs");

test("write-review refuses to take reviewer identity from the artifact alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-identity-"));
  try {
    assert.equal(runCli(["init", "--artifact-root", root, "--run-id", "identity-run"]).status, 0);

    const review = join(root, "codex.md");
    await writeFile(review, reviewMarkdown({ runnerId: "codex:gpt-5" }), "utf8");

    const bare = runCli(["write-review", "--artifact-root", root, "--input", review]);
    assert.equal(bare.status, 64, bare.stderr);
    assert.match(bare.stderr, /--expected-runner-id/);

    const mismatch = runCli([
      "write-review",
      "--artifact-root",
      root,
      "--input",
      review,
      "--expected-runner-id",
      "claude:sonnet"
    ]);
    assert.equal(mismatch.status, 64, mismatch.stderr);
    assert.match(mismatch.stderr, /review runnerId mismatch/);

    const declared = runCli([
      "write-review",
      "--artifact-root",
      root,
      "--input",
      review,
      "--expected-runner-id",
      "codex:gpt-5"
    ]);
    assert.equal(declared.status, 0, declared.stderr);
    assert.equal(JSON.parse(declared.stdout).runnerId, "codex:gpt-5");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run rejects a bare --review path and requires runnerId=path", async () => {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-identity-run-"));
  try {
    const review = join(root, "codex.md");
    await writeFile(review, reviewMarkdown({ runnerId: "codex:gpt-5" }), "utf8");

    const bare = runCli([
      "run",
      "--artifact-root",
      join(root, "quality"),
      "--run-id",
      "identity-run",
      "--review",
      review,
      "--decision",
      join(root, "decision.md"),
      "--owner",
      "kai",
      "--verify",
      join(root, "verify.md"),
      "--verifier-runner-id",
      "claude:verifier"
    ]);

    assert.equal(bare.status, 64, bare.stderr);
    assert.match(bare.stderr, /--review must use <key>=<value>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}
