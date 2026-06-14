import assert from "node:assert/strict";
import test from "node:test";
import { renderHelpText } from "../../../src/cli/help.mjs";

test("renderHelpText includes stable CLI usage sections", () => {
  const help = renderHelpText();
  assert.match(help, /^KualityForge\n\nUsage:/);
  assert.match(help, /kualityforge report --input <manifest\.json> \[--html\] \[--lang <zh\|en>\] \[--output <file>\]/);
  assert.match(help, /KSwarm URL:/);
  assert.match(help, /Quorum review:/);
  assert.match(help, /--advisory-reviewer cannot downgrade a runner already declared as --reviewer/);
  assert.ok(help.endsWith("\n"));
});
