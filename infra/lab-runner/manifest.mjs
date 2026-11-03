// RunManifest builder. Every field is copied from the claim/spec or measured
// on the execution node; nothing is invented. Unknown hardware facts are "".
import { imageDigestFromRef, seedsFromParams } from "./lib/container.mjs";

export function buildManifest({ work, runnerId, schedulerJobId, environment, status, artifacts, metricsArtifactPath, dataBinding }) {
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
      // R02: digest of the input bytes verified before submit (lib/dataset.mjs);
      // omitted when no verification record exists for this run.
      ...(dataBinding?.dataDigest ? { dataDigest: dataBinding.dataDigest, dataVerification: dataBinding.dataVerification } : {}),
    },
    environment: {
      imageDigest: imageDigestFromRef(spec.entrypoint.imageRef),
      driverVersion: typeof environment?.driverVersion === "string" ? environment.driverVersion : "",
      gpuModel: typeof environment?.gpuModel === "string" ? environment.gpuModel : "",
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
