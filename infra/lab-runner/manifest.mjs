// RunManifest builder. Every field is copied from the claim/spec or measured
// on the execution node; nothing is invented. Unknown hardware facts are "".
import { imageDigestFromRef, seedsFromParams } from "./lib/container.mjs";

export function buildManifest({ work, runnerId, schedulerJobId, environment, image, status, artifacts, metricsArtifactPath }) {
  const spec = work.spec;
  return {
    schema: "tanyan.manifest/v1",
    runId: work.runId,
    attempt: work.attempt,
    runSpecSha256: work.runSpecSha256,
    approvalId: work.approvalId,
    repository: { repositoryId: spec.repository.repositoryId, executedCommitSha: spec.executedCommitSha },
    inputs: {
      datasetVersionId: spec.dataset.versionId,
      manifestSha256: spec.dataset.manifestSha256,
      splitManifestSha256: spec.dataset.splitManifestSha256,
      evaluationProtocolSha256: spec.evaluationProtocolSha256,
      seeds: seedsFromParams(spec.entrypoint.params),
    },
    environment: {
      imageDigest: imageDigestFromRef(spec.entrypoint.imageRef),
      driverVersion: typeof environment?.driverVersion === "string" ? environment.driverVersion : "",
      gpuModel: typeof environment?.gpuModel === "string" ? environment.gpuModel : "",
      // Batch 7 (G02): the SIF file the runner verified before submit, and its
      // recorded provenance. Absent for legacy (unverified) image entries.
      ...(typeof image?.sifSha256 === "string" && /^[0-9a-f]{64}$/.test(image.sifSha256) ? { imageFileSha256: image.sifSha256 } : {}),
      ...(typeof image?.source === "string" && image.source ? { imageSource: image.source.slice(0, 300) } : {}),
    },
    execution: {
      runnerId,
      schedulerJobId,
      submitTag: work.submitTag,
      entrypointId: spec.entrypoint.id,
      startedAt: status.startedAt,
      endedAt: status.endedAt ?? "",
      exitCode: status.exitCode,
    },
    metricsArtifactPath,
    artifacts,
  };
}
