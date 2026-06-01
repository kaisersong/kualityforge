import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = resolve("src/cli/index.mjs");

test("eval command runs deterministic corpus and exits zero when cases match", () => {
  const result = spawnSync(process.execPath, [cliPath, "eval"], {
    cwd: resolve("."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "passed");
  assert.equal(output.total, 6);
});
