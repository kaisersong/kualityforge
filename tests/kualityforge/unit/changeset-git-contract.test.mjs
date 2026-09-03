import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { promisify } from "node:util";
import { computeChangeset } from "../../../src/core/changeset.mjs";
import { installFakeGit, runFixtureGit } from "../helpers/git-env.mjs";

const execFileAsync = promisify(execFile);

const skip = platform === "win32" ? "fake git is a POSIX shell script" : false;

// The fake git records its argv, so the determinism flags the production code
// relies on are asserted directly instead of being inferred from diff output.
test("every git invocation from computeChangeset disables quotepath", { skip }, async () => {
  const fake = await installFakeGit();
  try {
    await computeChangeset({ projectRoot: fake.dir, base: "HEAD", head: "WORKTREE" });

    const invocations = (await readFile(fake.logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);

    assert.ok(invocations.length > 0, "expected computeChangeset to invoke git");
    for (const invocation of invocations) {
      assert.match(invocation, /^-c core\.quotepath=false /, invocation);
    }
  } finally {
    fake.restore();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("computeChangeset probes the work tree before diffing", { skip }, async () => {
  const fake = await installFakeGit();
  try {
    await computeChangeset({ projectRoot: fake.dir, base: "HEAD", head: "WORKTREE" });

    const invocations = (await readFile(fake.logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);

    assert.match(invocations[0], /rev-parse --is-inside-work-tree$/);
  } finally {
    fake.restore();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

// Only well-formed KEY=value lines are kept: a multi-line value somewhere in the
// host environment would otherwise shift every following line into the wrong key.
function parseEnvLog(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      env[match[1]] = match[2];
    }
  }
  return env;
}

// The fixture's own git calls run under an explicitly isolated env so that the
// hostile config a test injects afterwards cannot change how the repo was built —
// otherwise a failure could not be attributed to the code under test.
async function seedRepo() {
  const dir = await mkdtemp(join(tmpdir(), "kualityforge-changeset-repo-"));

  await runFixtureGit(dir, ["init"]);
  await writeFile(join(dir, "tracked.txt"), "first\n", "utf8");
  await runFixtureGit(dir, ["add", "tracked.txt"]);
  await runFixtureGit(dir, [
    "-c",
    "user.name=KualityForge",
    "-c",
    "user.email=kualityforge@example.invalid",
    "commit",
    "-m",
    "seed"
  ]);
  await writeFile(join(dir, "tracked.txt"), "first\nsecond\n", "utf8");

  return dir;
}

async function writeHostileGitConfig(path) {
  await writeFile(path, "[diff]\n\tnoprefix = true\n", "utf8");
}

test("computeChangeset neutralizes the host git environment for its child", { skip }, async () => {
  const fake = await installFakeGit();
  const previous = process.env.GIT_CONFIG_COUNT;
  process.env.GIT_CONFIG_COUNT = "1";
  try {
    await computeChangeset({ projectRoot: fake.dir, base: "HEAD", head: "WORKTREE" });

    const env = parseEnvLog(await readFile(fake.envLogPath, "utf8"));

    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.ok(env.GIT_CONFIG_GLOBAL, "expected the >= 2.32 isolation layer to be set");
    assert.ok(env.HOME, "expected the pre-2.32 isolation layer to be set");
    assert.equal(env.XDG_CONFIG_HOME, env.HOME);
    assert.equal(
      env.GIT_CONFIG_COUNT,
      undefined,
      "a host GIT_* injection must not reach the child"
    );
    // Stripping PATH would make git unresolvable, which surfaces only as an
    // unavailable changeset rather than as an error.
    assert.ok(env.PATH, "expected PATH to survive the GIT_* strip");
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

test("a hostile GIT_CONFIG_GLOBAL cannot change the frozen patch", { skip }, async () => {
  const repo = await seedRepo();
  const configDir = await mkdtemp(join(tmpdir(), "kualityforge-hostile-config-"));
  const configPath = join(configDir, "hostile.gitconfig");
  await writeHostileGitConfig(configPath);

  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  try {
    // Non-vacuity: prove this entry point is honored by the host git before
    // asserting that the code under test is unaffected by it.
    const raw = await execFileAsync("git", ["diff"], { cwd: repo, env: process.env });
    assert.doesNotMatch(raw.stdout, /^--- a\//m, "hostile config was not honored at all");

    const changeset = await computeChangeset({ projectRoot: repo, base: "HEAD", head: "WORKTREE" });

    assert.equal(changeset.available, true);
    assert.match(changeset.patch, /^--- a\/tracked\.txt$/m);
    assert.match(changeset.patch, /^\+\+\+ b\/tracked\.txt$/m);
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previous;
    }
    await rm(repo, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a hostile HOME cannot change the frozen patch", { skip }, async () => {
  const repo = await seedRepo();
  const homeDir = await mkdtemp(join(tmpdir(), "kualityforge-hostile-home-"));
  await writeHostileGitConfig(join(homeDir, ".gitconfig"));

  const previousHome = process.env.HOME;
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = homeDir;
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const raw = await execFileAsync("git", ["diff"], { cwd: repo, env: process.env });
    assert.doesNotMatch(raw.stdout, /^--- a\//m, "hostile HOME config was not honored at all");

    const changeset = await computeChangeset({ projectRoot: repo, base: "HEAD", head: "WORKTREE" });

    assert.equal(changeset.available, true);
    assert.match(changeset.patch, /^--- a\/tracked\.txt$/m);
    assert.match(changeset.patch, /^\+\+\+ b\/tracked\.txt$/m);
  } finally {
    process.env.HOME = previousHome;
    if (previousGlobal !== undefined) {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
    if (previousXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
    await rm(repo, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a frozen changeset states whether isolation held", { skip }, async () => {
  const repo = await seedRepo();
  try {
    const changeset = await computeChangeset({ projectRoot: repo, base: "HEAD", head: "WORKTREE" });

    assert.equal(changeset.available, true);
    // Explicitly false, not absent: the gate refuses to pass a run whose git could
    // not be isolated, and a missing field would read as falsy and pass silently.
    assert.equal(changeset.deterministicEnvDegraded, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("an unavailable changeset makes no isolation claim", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kualityforge-not-a-repo-"));
  try {
    const changeset = await computeChangeset({ projectRoot: dir, base: "HEAD", head: "WORKTREE" });

    assert.equal(changeset.available, false);
    assert.equal(
      "deterministicEnvDegraded" in changeset,
      false,
      "git never ran, so there is nothing to claim about its environment"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
