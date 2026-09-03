// Replay reads the bytes the reviewer wrote. The write path's parser is the wrong
// tool for that job: it overwrites sourceRunnerId, derives duplicateKey from the
// title and supplies defaults, so a manifest field and the artifact it claims to
// summarise would both come out of the same transform and agree by construction.
//
// The strictness here is deliberately asymmetric with the write boundary. A KSwarm
// handoff transcript honestly carries several kualityforge-review fences, so the
// write path takes the last valid one and tolerates a missing closing fence. On
// replay both of those would hand an attacker the choice of which bytes count as
// evidence.

const CLOSED_BLOCK_PATTERN = /```kualityforge-review\s*([\s\S]*?)```/g;
const OPEN_TOKEN_PATTERN = /```kualityforge-review/g;

export function parseRawReviewFence(markdown) {
  if (typeof markdown !== "string") {
    throw new Error("review artifact must include exactly one kualityforge-review block");
  }

  const openCount = countMatches(markdown, OPEN_TOKEN_PATTERN);
  const blocks = [...markdown.matchAll(CLOSED_BLOCK_PATTERN)].map((match) => match[1]);

  if (openCount === 0) {
    throw new Error("review artifact must include exactly one kualityforge-review block");
  }
  if (openCount !== blocks.length) {
    throw new Error("every kualityforge-review block must be closed");
  }
  if (blocks.length !== 1) {
    throw new Error("review artifact must include exactly one kualityforge-review block");
  }

  const document = JSON.parse(blocks[0]);
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("review artifact must be a JSON object");
  }
  if (typeof document.runnerId !== "string" || document.runnerId.trim() === "") {
    throw new Error("review runnerId is required");
  }
  if (!Array.isArray(document.findings)) {
    throw new Error("review findings must be an array");
  }

  return document;
}

function countMatches(value, pattern) {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(value) !== null) {
    count += 1;
  }
  pattern.lastIndex = 0;
  return count;
}
