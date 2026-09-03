import assert from "node:assert/strict";
import test from "node:test";
import { parseRawReviewFence } from "../../../src/core/raw-review-fence.mjs";
import { parseReviewArtifact } from "../../../src/core/review-artifact.mjs";

function fence(body) {
  return `# Review\n\n\`\`\`kualityforge-review\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

const HONEST_BODY = {
  runnerId: "codex:gpt-5",
  status: "completed",
  findings: [
    {
      id: "codex:QF-001",
      title: "A finding title long enough to look like real reviewer prose",
      severity: "warning",
      description: "Body text",
      suggestion: "Do the thing"
    }
  ]
};

test("the raw document keeps the fields the write path would have overwritten", () => {
  const document = parseRawReviewFence(
    fence({
      ...HONEST_BODY,
      findings: [
        {
          ...HONEST_BODY.findings[0],
          sourceRunnerId: "someone:else",
          duplicateKey: "a-key-the-reviewer-chose"
        }
      ]
    })
  );

  // The write path forces sourceRunnerId to the top-level runnerId and derives
  // duplicateKey from the title. If replay read the mapped copy instead of these
  // bytes, both sides of the comparison would come from the same transform and the
  // check would be an identity.
  assert.equal(document.findings[0].sourceRunnerId, "someone:else");
  assert.equal(document.findings[0].duplicateKey, "a-key-the-reviewer-chose");
  assert.equal(document.runnerId, "codex:gpt-5");
  assert.equal(document.status, "completed");
});

test("a raw document is not given the defaults the write path supplies", () => {
  const document = parseRawReviewFence(
    fence({
      runnerId: "codex:gpt-5",
      status: "completed",
      findings: [{ title: "No severity, no status, no type declared" }]
    })
  );

  const finding = document.findings[0];
  assert.equal(finding.severity, undefined);
  assert.equal(finding.status, undefined);
  assert.equal(finding.type, undefined);
  assert.equal(finding.id, undefined);
});

test("replay refuses a transcript with more than one review block", () => {
  const markdown = fence(HONEST_BODY) + fence({ ...HONEST_BODY, runnerId: "claude:sonnet" });

  // The write boundary deliberately tolerates this: a KSwarm handoff transcript
  // routinely carries earlier fences from diffs and embedded context. Replay cannot,
  // because "which block is the evidence" would become the attacker's choice.
  assert.equal(parseReviewArtifact(markdown).runnerId, "claude:sonnet");
  assert.throws(() => parseRawReviewFence(markdown), /exactly one kualityforge-review block/);
});

test("replay refuses an unclosed block instead of reading to the end of the file", () => {
  const markdown = `# Review\n\n\`\`\`kualityforge-review\n${JSON.stringify(HONEST_BODY)}\n`;

  assert.equal(parseReviewArtifact(markdown).runnerId, "codex:gpt-5");
  assert.throws(() => parseRawReviewFence(markdown), /must be closed/);
});

test("replay refuses a closed block followed by an unclosed one", () => {
  const markdown = `${fence(HONEST_BODY)}\n\`\`\`kualityforge-review\n{"runnerId":"x"}\n`;

  assert.throws(() => parseRawReviewFence(markdown), /must be closed/);
});

for (const [name, markdown, pattern] of [
  ["a body that is not a review artifact at all", "not a KualityForge artifact\n", /must include/],
  ["a block that is not valid JSON", "```kualityforge-review\nnot json\n```\n", /SyntaxError|JSON/],
  [
    "a block whose JSON is not an object",
    "```kualityforge-review\n[1, 2]\n```\n",
    /must be a JSON object/
  ],
  [
    "a block with no runnerId",
    `\`\`\`kualityforge-review\n${JSON.stringify({ status: "completed", findings: [] })}\n\`\`\`\n`,
    /runnerId is required/
  ],
  [
    "a block whose findings are not an array",
    `\`\`\`kualityforge-review\n${JSON.stringify({ runnerId: "a", status: "completed", findings: {} })}\n\`\`\`\n`,
    /findings must be an array/
  ]
]) {
  test(`replay refuses ${name}`, () => {
    assert.throws(() => parseRawReviewFence(markdown), pattern);
  });
}
