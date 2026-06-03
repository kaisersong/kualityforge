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
