import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { resolveDeterministicGitOverrides } from "../../../src/core/git-env.mjs";

const execFileAsync = promisify(execFile);

// A fixture repo must be built under its own isolation, not under the host config
// and not under whatever a test injected: otherwise a failure cannot be attributed
// to the code under test.
export async function runFixtureGit(dir, args) {
  return execFileAsync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(dir, "absent.gitconfig"),
      GIT_TERMINAL_PROMPT: "0"
    }
  });
}

// A frozen changeset is derived from a repository with real uncommitted work, so a fixture
// that needs one has to be a repository. Hand-setting `available` instead would test the
// derivation against nothing. Callers whose code under test spawns git itself still need
// applyDeterministicGitEnv(): this only isolates the setup.
export async function createChangesetProject() {
  const dir = await mkdtemp(join(tmpdir(), "kualityforge-project-"));
  await runFixtureGit(dir, ["init", "-q"]);
  await runFixtureGit(dir, ["config", "user.email", "test@example.com"]);
  await runFixtureGit(dir, ["config", "user.name", "Test"]);
  await runFixtureGit(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "# Fixture project\n", "utf8");
  await runFixtureGit(dir, ["add", "README.md"]);
  await runFixtureGit(dir, ["commit", "-qm", "initial"]);
  await writeFile(join(dir, "README.md"), "# Fixture project\n\nuncommitted edit\n", "utf8");
  return dir;
}

// Mutates process.env because the code under test spawns git itself and inherits
// the parent environment; passing an env object would only isolate the fixture
// setup and leave the real invocation exposed to the host config. Production
// builds the child env directly, so it shares this recipe but not this injection
// site. Node runs each test file in its own process, so the mutation stays local.
export async function applyDeterministicGitEnv() {
  const { overrides } = resolveDeterministicGitOverrides();
  Object.assign(process.env, overrides);
  return overrides;
}

// PATH shadowing instead of a mock library: the fake git records the argv it was
// handed, so a test can assert the argument contract of the real code path.
export async function installFakeGit() {
  const dir = await mkdtemp(join(tmpdir(), "kualityforge-fakegit-"));
  const logPath = join(dir, "git-args.log");
  const envLogPath = join(dir, "git-env.log");
  const gitPath = join(dir, "git");

  await writeFile(
    gitPath,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${logPath}"`,
      // Overwrites rather than appends: every invocation in one run receives the
      // same env, so the last one is representative and stays parseable.
      `env > "${envLogPath}"`,
      'case "$*" in',
      "  *is-inside-work-tree*) echo true ;;",
      `  *rev-parse*) echo ${"0".repeat(40)} ;;`,
      "  *) : ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(gitPath, 0o755);
  await writeFile(logPath, "", "utf8");
  await writeFile(envLogPath, "", "utf8");

  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath}`;

  return {
    dir,
    logPath,
    envLogPath,
    restore() {
      process.env.PATH = previousPath;
    }
  };
}
