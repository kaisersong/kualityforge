import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { computeChangeset, renderChangesetMarkdown } from "../../../src/core/changeset.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

async function initRepo() {
  const dir = await mkdtemp(join(tmpdir(), "kf-changeset-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

test("computeChangeset captures working-tree file statuses and stats", async () => {
  const dir = await initRepo();
  try {
    await writeFile(join(dir, "keep.txt"), "line1\nline2\n", "utf8");
    await git(dir, ["add", "keep.txt"]);
    await git(dir, ["commit", "-q", "-m", "base"]);

    await writeFile(join(dir, "keep.txt"), "line1\nchanged\nline3\n", "utf8");
    await writeFile(join(dir, "added.txt"), "new file\n", "utf8");

    const changeset = await computeChangeset({ projectRoot: dir });
    assert.equal(changeset.available, true);
    assert.equal(changeset.dirty, true);
    assert.equal(changeset.head, "WORKTREE");
    assert.match(changeset.baseSha, /^[a-f0-9]{40}$/);

    const byPath = new Map(changeset.files.map((file) => [file.path, file]));
    assert.equal(byPath.get("added.txt").status, "A");
    assert.equal(byPath.get("keep.txt").status, "M");
    assert.ok(changeset.totals.added >= 2);
    assert.equal(changeset.patchTruncated, false);
    assert.ok(changeset.patch.includes("added.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeChangeset truncates an oversized patch", async () => {
  const dir = await initRepo();
  try {
    await writeFile(join(dir, "base.txt"), "seed\n", "utf8");
    await git(dir, ["add", "base.txt"]);
    await git(dir, ["commit", "-q", "-m", "base"]);

    const big = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join("\n");
    await writeFile(join(dir, "big.txt"), `${big}\n`, "utf8");

    const changeset = await computeChangeset({ projectRoot: dir, maxPatchBytes: 256 });
    assert.equal(changeset.available, true);
    assert.equal(changeset.patchTruncated, true);
    assert.ok(changeset.patchBytes > 256);
    assert.ok(Buffer.byteLength(changeset.patch, "utf8") <= 256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeChangeset returns unavailable for a non-git directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kf-nogit-"));
  try {
    const changeset = await computeChangeset({ projectRoot: dir });
    assert.equal(changeset.available, false);
    assert.ok(typeof changeset.reason === "string" && changeset.reason.length > 0);
    const markdown = renderChangesetMarkdown(changeset);
    assert.match(markdown, /No changeset could be frozen/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeChangeset requires a projectRoot", async () => {
  const changeset = await computeChangeset({});
  assert.equal(changeset.available, false);
  assert.match(changeset.reason, /projectRoot/);
});

test("renderChangesetMarkdown uses a fence that cannot be broken by backticks in the patch", () => {
  const changeset = {
    schemaVersion: 1,
    available: true,
    base: "HEAD",
    head: "WORKTREE",
    baseSha: "abc1234567890",
    headSha: "def1234567890",
    dirty: true,
    fileCount: 1,
    files: [{ path: "a.md", status: "M", added: 1, deleted: 0 }],
    totals: { added: 1, deleted: 0 },
    patch: "+const fence = \"```diff\"; // contains a triple backtick run\n",
    patchBytes: 50,
    patchTruncated: false,
    generatedAt: "2026-06-03T00:00:00.000Z"
  };
  const markdown = renderChangesetMarkdown(changeset);
  // The opening fence must be longer than any backtick run inside the patch.
  assert.match(markdown, /````+diff/);
  // The patch body (with its embedded triple backticks) must be present intact.
  assert.ok(markdown.includes("```diff\"; // contains a triple backtick run"));
});
