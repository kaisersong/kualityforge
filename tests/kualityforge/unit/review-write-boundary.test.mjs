import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeArtifactRoot } from "../../../src/core/artifact-root.mjs";
import { writeReviewMarkdownToArtifactRoot } from "../../../src/core/artifact-operations.mjs";
import { reviewMarkdown } from "../helpers/artifact-fixtures.mjs";

async function withArtifactRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "kualityforge-write-boundary-"));
  try {
    await initializeArtifactRoot(root, { runId: "write-boundary", profile: "release" });
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("rejects a runner id that sanitizes to an empty artifact name", async () => {
  await withArtifactRoot(async (root) => {
    await assert.rejects(
      writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "!!!" })),
      /empty artifact name/
    );
  });
});

test("refuses to overwrite an artifact already owned by another runner", async () => {
  await withArtifactRoot(async (root) => {
    await writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }));

    // safeArtifactName maps both runner ids to codex-gpt-5.md.
    await assert.rejects(
      writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex/gpt-5" })),
      /artifact name collision/
    );

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.reviewers.map((reviewer) => reviewer.runnerId), ["codex:gpt-5"]);
  });
});

test("leaves the first reviewer file intact when a collision is rejected", async () => {
  await withArtifactRoot(async (root) => {
    await writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }));
    const before = await readFile(join(root, "reviews", "codex-gpt-5.md"), "utf8");

    await assert.rejects(
      writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex/gpt-5" })),
      /artifact name collision/
    );

    assert.equal(await readFile(join(root, "reviews", "codex-gpt-5.md"), "utf8"), before);
  });
});

test("compares claimed artifact paths by normalized key, not string equality", async () => {
  await withArtifactRoot(async (root) => {
    await writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }));

    for (const artifact of [
      "reviews\\codex-gpt-5.md",
      "reviews/CODEX-GPT-5.md",
      "reviews//codex-gpt-5.md"
    ]) {
      await assert.rejects(
        writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "claude:sonnet" }), {
          artifact
        }),
        /artifact name collision/,
        artifact
      );
    }
  });
});

test("accepts distinct runner ids with distinct artifact names", async () => {
  await withArtifactRoot(async (root) => {
    await writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }));
    await writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "claude:sonnet" }));

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    // Protocol form, not join(): replay enumerates the directory and compares
    // plain strings, so a host separator in the manifest would never match.
    assert.deepEqual(manifest.reviewers.map((reviewer) => reviewer.artifact), [
      "reviews/claude-sonnet.md",
      "reviews/codex-gpt-5.md"
    ]);
  });
});

test("refuses a reviewer artifact that does not live under reviews/", async () => {
  await withArtifactRoot(async (root) => {
    await assert.rejects(
      writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }), {
        artifact: "context/instructions/foo.md"
      }),
      /must live under reviews\//
    );

    await assert.rejects(readFile(join(root, "context", "instructions", "foo.md"), "utf8"), /ENOENT/);
  });
});

test("refuses a reviewer artifact that is not markdown", async () => {
  await withArtifactRoot(async (root) => {
    await assert.rejects(
      writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }), {
        artifact: "reviews/codex.txt"
      }),
      /must end with \.md/
    );
  });
});

test("accepts a reviewer artifact nested below reviews/", async () => {
  await withArtifactRoot(async (root) => {
    const result = await writeReviewMarkdownToArtifactRoot(
      root,
      reviewMarkdown({ runnerId: "codex:gpt-5" }),
      { artifact: "reviews/nested/codex.md" }
    );

    assert.equal(result.artifact, "reviews/nested/codex.md");
    assert.match(await readFile(join(root, "reviews", "nested", "codex.md"), "utf8"), /codex:gpt-5/);
  });
});

// The path that passed shape validation must be the path that reaches the disk,
// the manifest and the caller. Handing the raw string to join() creates a file
// with a literal backslash in its name on POSIX, which lives outside reviews/.
test("writes the protocol form of a claimed path, not the string it was given", async () => {
  await withArtifactRoot(async (root) => {
    const result = await writeReviewMarkdownToArtifactRoot(
      root,
      reviewMarkdown({ runnerId: "codex:gpt-5" }),
      { artifact: "reviews\\nested\\codex.md" }
    );

    assert.equal(result.artifact, "reviews/nested/codex.md");
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.reviewers[0].artifact, "reviews/nested/codex.md");
    assert.match(await readFile(join(root, "reviews", "nested", "codex.md"), "utf8"), /codex:gpt-5/);
  });
});

test("lets a runner replace its own artifact", async () => {
  await withArtifactRoot(async (root) => {
    await writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }));
    await writeReviewMarkdownToArtifactRoot(
      root,
      reviewMarkdown({
        runnerId: "codex:gpt-5",
        findings: [
          {
            id: "QF-009",
            title: "Replacement finding reported by the same runner on a second review pass",
            description:
              "The runner re-ran its review and reported a different concern that supersedes the earlier submission entirely",
            suggestion:
              "Treat the latest submission from a runner as authoritative and drop its previous findings",
            severity: "info"
          }
        ]
      })
    );

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.reviewers.length, 1);
    assert.deepEqual(manifest.findings.map((finding) => finding.id), ["QF-009"]);
  });
});

test("rejects a runner id mismatch before writing the artifact", async () => {
  await withArtifactRoot(async (root) => {
    await assert.rejects(
      writeReviewMarkdownToArtifactRoot(root, reviewMarkdown({ runnerId: "codex:gpt-5" }), {
        expectedRunnerId: "claude:sonnet"
      }),
      /review runnerId mismatch/
    );

    await assert.rejects(readFile(join(root, "reviews", "codex-gpt-5.md"), "utf8"), /ENOENT/);
  });
});
