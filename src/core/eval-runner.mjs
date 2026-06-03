import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { reduceQualityGate } from "./gate-reducer.mjs";
import { normalizePolicy } from "./policy.mjs";

export async function loadEvalCases(corpusDir) {
  const entries = await readdir(corpusDir, { withFileTypes: true });
  const cases = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const content = JSON.parse(await readFile(join(corpusDir, entry.name), "utf8"));
    if (Array.isArray(content)) {
      cases.push(...content);
    } else {
      cases.push(content);
    }
  }

  return cases;
}

export function runDeterministicEvalCases(cases) {
  const results = cases.map((testCase) => {
    const policy = normalizePolicy(testCase.policy || {});
    const actual = reduceQualityGate(testCase.manifest, policy);
    const expected = testCase.expected;

    const statusMatch = actual.status === expected.status && actual.exitCode === expected.exitCode;
    const reasonsText = Array.isArray(actual.reasons) ? actual.reasons.join("\n") : "";
    const warningsText = Array.isArray(actual.warnings) ? actual.warnings.join("\n") : "";
    const reasonsMatch = includesAll(reasonsText, expected.reasonsInclude);
    const warningsMatch = includesAll(warningsText, expected.warningsInclude);
    const passed = statusMatch && reasonsMatch && warningsMatch;

    return {
      name: testCase.name,
      passed,
      expected,
      actual
    };
  });

  const passed = results.filter((item) => item.passed).length;
  const failed = results.length - passed;

  return {
    status: failed === 0 ? "passed" : "failed",
    total: results.length,
    passed,
    failed,
    cases: results
  };
}

function includesAll(haystack, needles) {
  if (!Array.isArray(needles)) {
    return true;
  }
  return needles.every((needle) => haystack.includes(needle));
}

export async function runDeterministicEval(corpusDir) {
  return runDeterministicEvalCases(await loadEvalCases(corpusDir));
}
