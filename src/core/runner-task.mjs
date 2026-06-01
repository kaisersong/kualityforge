import { safeArtifactName } from "./review-artifact.mjs";

export function createReviewTask({ runId, artifactRoot, runnerId, target }) {
  if (!runId) {
    throw new Error("runId is required");
  }
  if (!artifactRoot) {
    throw new Error("artifactRoot is required");
  }
  if (!runnerId) {
    throw new Error("runnerId is required");
  }

  return {
    kind: "kualityfore.review",
    runId,
    artifactRoot,
    runnerId,
    role: "reviewer",
    target,
    outputArtifact: `reviews/${safeArtifactName(runnerId)}.md`
  };
}
