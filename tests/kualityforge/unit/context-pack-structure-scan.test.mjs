import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import {
  computeStructureScan,
  renderStructureScanMarkdown
} from "../../../src/core/context-pack.mjs";
import { installFakeGit, runFixtureGit } from "../helpers/git-env.mjs";

const skip = platform === "win32" ? "fake git is a POSIX shell script" : false;

async function seedRepo(files) {
  const dir = await mkdtemp(join(tmpdir(), "kualityforge-scan-repo-"));
  await runFixtureGit(dir, ["init"]);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

test("computeStructureScan isolates git from the host environment", { skip }, async () => {
  const fake = await installFakeGit();
  const previous = process.env.GIT_CONFIG_COUNT;
  process.env.GIT_CONFIG_COUNT = "1";
  try {
    await computeStructureScan(fake.dir, {});

    const invocations = (await readFile(fake.logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    const env = (await readFile(fake.envLogPath, "utf8"))
      .split("\n")
      .reduce((acc, line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (match) {
          acc[match[1]] = match[2];
        }
        return acc;
      }, {});

    assert.match(invocations[0], /^-c core\.quotepath=false ls-files /);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.ok(env.GIT_CONFIG_GLOBAL, "expected the >= 2.32 isolation layer to be set");
    assert.ok(env.HOME, "expected the pre-2.32 isolation layer to be set");
    assert.equal(env.GIT_CONFIG_COUNT, undefined, "a host GIT_* injection must not reach git");
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_CONFIG_COUNT;
    } else {
      process.env.GIT_CONFIG_COUNT = previous;
    }
    fake.restore();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("suspicious pattern counts are occurrences", { skip }, async () => {
  // Three hits on one line: a line-oriented scan reports 1 here.
  const repo = await seedRepo({ "a.js": "// TODO TODO TODO\n" });
  try {
    const scan = await computeStructureScan(repo, {});
    const todo = scan.suspiciousPatterns.find((pattern) => pattern.pattern === "TODO");

    assert.equal(todo.totalOccurrences, 3);
    assert.deepEqual(todo.files, [{ path: "a.js", count: 3 }]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// The scan's file set is decided by `git ls-files` plus a source-extension filter.
// There is deliberately no include/exclude glob configuration: passing one must not
// look like it works.
test("the scanned file set comes from git, not from caller-supplied globs", { skip }, async () => {
  const repo = await seedRepo({
    "a.js": "// TODO\n",
    "notes.md": "TODO\n",
    "ignored.js": "// TODO\n",
    ".gitignore": "ignored.js\n"
  });
  try {
    const scan = await computeStructureScan(repo, {
      includePatterns: ["**/*.md"],
      excludePatterns: ["**/*.js"]
    });

    assert.deepEqual(scan.fileList, ["a.js"]);
    assert.equal(scan.totalFiles, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the rendered scan marks expected self-hits visibly", () => {
  const markdown = renderStructureScanMarkdown({
    totalFiles: 2,
    truncated: false,
    suspiciousPatterns: [
      {
        pattern: "TODO",
        totalOccurrences: 3,
        filesTruncated: false,
        files: [
          { path: "src/core/suspicious-patterns.mjs", count: 2, expectedSelfHit: true },
          { path: "src/app.js", count: 1 }
        ]
      }
    ],
    fileCategories: {},
    symbolMap: {}
  });

  const selfLine = markdown
    .split("\n")
    .find((line) => line.startsWith("- src/core/suspicious-patterns.mjs"));
  const otherLine = markdown.split("\n").find((line) => line.startsWith("- src/app.js"));

  // Reviewers read the markdown, so a marker present only in the JSON is invisible
  // to the only consumer that acts on it.
  assert.notEqual(selfLine, undefined);
  assert.notEqual(selfLine, "- src/core/suspicious-patterns.mjs (2x)");
  assert.equal(otherLine, "- src/app.js (1x)");
});

test("the rendered scan only claims more files when the list was cut", () => {
  const notTruncated = renderStructureScanMarkdown({
    totalFiles: 1,
    truncated: false,
    suspiciousPatterns: [
      {
        pattern: "TODO",
        totalOccurrences: 9,
        filesTruncated: false,
        files: [{ path: "src/app.js", count: 9 }]
      }
    ],
    fileCategories: {},
    symbolMap: {}
  });
  const truncated = renderStructureScanMarkdown({
    totalFiles: 21,
    truncated: false,
    suspiciousPatterns: [
      {
        pattern: "TODO",
        totalOccurrences: 21,
        filesTruncated: true,
        files: [{ path: "src/app.js", count: 1 }]
      }
    ],
    fileCategories: {},
    symbolMap: {}
  });

  assert.doesNotMatch(notTruncated, /and more/);
  assert.match(truncated, /and more/);
});
