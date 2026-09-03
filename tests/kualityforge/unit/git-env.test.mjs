import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import {
  resolveDeterministicGitEnv,
  resolveDeterministicGitOverrides,
  stripGitVars
} from "../../../src/core/git-env.mjs";
import { applyDeterministicGitEnv } from "../helpers/git-env.mjs";

test("stripGitVars drops every GIT_ variable that could redirect git", () => {
  const stripped = stripGitVars({
    PATH: "/usr/bin",
    GIT_DIR: "/evil/.git",
    GIT_WORK_TREE: "/evil",
    GIT_INDEX_FILE: "/evil/index",
    GIT_OBJECT_DIRECTORY: "/evil/objects",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "diff.noprefix",
    GIT_CONFIG_VALUE_0: "true"
  });

  assert.deepEqual(Object.keys(stripped), ["PATH"]);
});

// Removing this one makes git fail to start on Nix and Homebrew installs, and an
// unavailable changeset is indistinguishable from a repo with no changes.
test("stripGitVars preserves GIT_EXEC_PATH", () => {
  const stripped = stripGitVars({ GIT_EXEC_PATH: "/opt/git/libexec", GIT_DIR: "/evil/.git" });
  assert.deepEqual(stripped, { GIT_EXEC_PATH: "/opt/git/libexec" });
});

test("the overrides neutralize both the modern and the legacy global config entry points", async () => {
  const { overrides, degraded } = resolveDeterministicGitOverrides();

  assert.equal(degraded, false);
  assert.equal(overrides.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(overrides.LC_ALL, "C");
  assert.equal(overrides.TZ, "UTC");
  assert.equal(overrides.GIT_TERMINAL_PROMPT, "0");

  // Git >= 2.32 reads GIT_CONFIG_GLOBAL; older git and Git for Windows read the
  // home entry points instead. Both layers must be set because we deliberately
  // do not probe the git version.
  assert.equal(await readFile(overrides.GIT_CONFIG_GLOBAL, "utf8"), "");
  assert.equal(overrides.XDG_CONFIG_HOME, overrides.HOME);
  assert.equal(overrides.USERPROFILE, overrides.HOME);
  assert.ok((await stat(overrides.HOME)).isDirectory());
});

// Git for Windows resolves %HOMEDRIVE%%HOMEPATH% by concatenation, and an
// invalid result is skipped silently rather than reported, which would drop one
// isolation layer while looking healthy.
test("HOMEDRIVE and HOMEPATH concatenate back to exactly HOME", () => {
  const { overrides } = resolveDeterministicGitOverrides();
  assert.equal(`${overrides.HOMEDRIVE}${overrides.HOMEPATH}`, overrides.HOME);
});

test("the isolation root is a process singleton rather than one directory per git call", () => {
  const first = resolveDeterministicGitOverrides();
  const second = resolveDeterministicGitOverrides();
  assert.equal(first.overrides.HOME, second.overrides.HOME);
  assert.equal(first.overrides.GIT_CONFIG_GLOBAL, second.overrides.GIT_CONFIG_GLOBAL);
});

// Order matters: overriding first and filtering second would strip the very
// variables the recipe just set.
test("the env filters the host before layering the deterministic values on top", () => {
  const previous = process.env.GIT_CONFIG_COUNT;
  process.env.GIT_CONFIG_COUNT = "1";
  try {
    const { env } = resolveDeterministicGitEnv();
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.ok(env.GIT_CONFIG_GLOBAL);
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_CONFIG_COUNT;
    } else {
      process.env.GIT_CONFIG_COUNT = previous;
    }
  }
});

// One recipe, two injection sites: production hands an env to the child, while
// the test helper must mutate process.env because the code under test spawns git
// itself. Only the recipe is shared, and this pins that it stays shared.
test("the test helper injects the production recipe instead of its own copy", async () => {
  const { overrides } = resolveDeterministicGitOverrides();
  const applied = await applyDeterministicGitEnv();

  assert.deepEqual(applied, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    assert.equal(process.env[key], value, key);
  }
});
