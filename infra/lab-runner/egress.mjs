// Egress gate (spec §7.1, decision D5: data may be computed on but never
// copied out). Reads `out/` without following links and decides, per file,
// whether it may leave the lab (published), stays on lab storage (held), or
// is refused outright (rejected). No side effects: nothing is moved, deleted
// or written here.
//
// Policy (R03, held by default): only a `metrics.json` that passes
// `checkMetricsEgress` is published automatically. Any other output is held
// unless the dataset's egress policy names it in `autoPublishPaths` (set by a
// data steward). Extension, image, size and raw-dataset-hash checks apply to
// every candidate. The hash check is defence in depth only: content scanning
// cannot detect encoded, split or mixed copies, which is why the default is held.
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, sep } from "node:path";

import {
  EGRESS_HELD_DEFAULT_REASON, EGRESS_IMAGE_EXTENSIONS, LIMITS, METRICS_EGRESS_LIMITS, METRICS_EGRESS_PATH,
  checkMetricsEgress, matchAutoPublishPath, normalizeRepoPath,
} from "../../lib/research-loop/contracts.ts";

/** Extensions treated as images for `allowImages`: the shared contract list,
 * identical to the platform's re-check. */
export const IMAGE_EXTENSIONS = new Set(EGRESS_IMAGE_EXTENSIONS);
const TABLE_EXTENSIONS = new Set([".csv", ".tsv", ".parquet", ".xlsx", ".xls", ".feather", ".arrow"]);
const LOG_EXTENSIONS = new Set([".log", ".out", ".err"]);
const MODEL_EXTENSIONS = new Set([".pt", ".pth", ".ckpt", ".safetensors", ".onnx", ".h5", ".hdf5", ".pkl", ".joblib", ".bin", ".npz", ".npy"]);

export const METRICS_RELATIVE_PATH = METRICS_EGRESS_PATH;

/** Artifact kind from path/extension only (never from content). */
export function classifyKind(relativePath) {
  const lower = relativePath.toLowerCase();
  const extension = extname(lower);
  if (lower === METRICS_RELATIVE_PATH) return "metrics";
  if (IMAGE_EXTENSIONS.has(extension) || lower.startsWith("figures/")) return "figure";
  if (TABLE_EXTENSIONS.has(extension) || lower.startsWith("tables/")) return "table";
  if (LOG_EXTENSIONS.has(extension) || lower.startsWith("logs/")) return "log";
  if (MODEL_EXTENSIONS.has(extension) || lower.startsWith("models/") || lower.startsWith("checkpoints/")) return "model";
  return "other";
}

/**
 * Pure per-file decision for a regular file whose hash and size are known.
 * `metricsCheck` is the `checkMetricsEgress` result for `metrics.json` (the
 * caller reads the same bytes it hashed). Order matters: a raw-data copy is
 * rejected even if it would also be held; nothing is published without a
 * basis (trusted metrics or an explicit `autoPublishPaths` opt-in).
 */
export function decideRegularFile({ relativePath, sizeBytes, sha256, linkCount = 1, metricsCheck }, policy, datasetHashes, publishedBytesSoFar) {
  const extension = extname(relativePath).toLowerCase();
  if (policy.blockDatasetHashMatches !== false && datasetHashes.has(sha256)) {
    return { decision: "rejected", reason: "sha256 matches a dataset manifest entry (raw data copy)" };
  }
  if (linkCount > 1) return { decision: "held", reason: "hard link (link count > 1)" };
  let basis;
  if (relativePath === METRICS_RELATIVE_PATH) {
    if (!metricsCheck?.ok) {
      return { decision: "held", reason: `metrics.json 未通过可信指标校验，按默认策略扣留：${metricsCheck?.error ?? "未校验"}` };
    }
    basis = "可信指标 metrics.json（tanyan.metrics/v1 与外发约束校验通过）";
  } else {
    const pattern = matchAutoPublishPath(relativePath, policy);
    if (!pattern) return { decision: "held", reason: EGRESS_HELD_DEFAULT_REASON };
    basis = `数据持有方授权外发：autoPublishPaths 命中 "${pattern}"；扩展名、大小与数据集哈希检查已通过`;
  }
  const allowed = new Set((policy.allowedExtensions ?? []).map((value) => String(value).toLowerCase()));
  if (!extension || !allowed.has(extension)) return { decision: "held", reason: `extension ${extension || "(none)"} not allowlisted` };
  if (IMAGE_EXTENSIONS.has(extension) && policy.allowImages !== true) return { decision: "held", reason: "image output and allowImages=false" };
  if (sizeBytes > policy.maxFileBytes) return { decision: "held", reason: `size ${sizeBytes} exceeds maxFileBytes ${policy.maxFileBytes}` };
  if (sizeBytes > LIMITS.maxPublishedArtifactBytes) {
    return { decision: "held", reason: `size ${sizeBytes} exceeds maxPublishedArtifactBytes ${LIMITS.maxPublishedArtifactBytes}` };
  }
  if (publishedBytesSoFar + sizeBytes > policy.maxTotalBytes) {
    return { decision: "held", reason: `total published bytes would exceed maxTotalBytes ${policy.maxTotalBytes}` };
  }
  return { decision: "published", reason: basis };
}

function sanitizeForReport(path) {
  return [...path].map((char) => (char.charCodeAt(0) < 0x20 || char === "\\" ? "?" : char)).join("");
}

function describeSpecial(stats) {
  if (stats.isSymbolicLink()) return "symbolic link (not followed)";
  if (stats.isFIFO()) return "named pipe";
  if (stats.isSocket()) return "socket";
  if (stats.isBlockDevice() || stats.isCharacterDevice()) return "device file";
  return "special file";
}

/** Hashes a regular file opened without following links. With `keepBytes`,
 * also returns the exact bytes hashed (used for the small metrics file, so
 * the content check sees what the hash covers). */
async function hashRegularFileNoFollow(absolutePath, expectedIno, keepBytes = false) {
  const handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.ino !== expectedIno) throw new Error("file changed during egress scan");
    const hash = createHash("sha256");
    const chunks = [];
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      if (keepBytes) chunks.push(chunk);
    }
    return { sha256: hash.digest("hex"), bytes: keepBytes ? Buffer.concat(chunks) : null };
  } finally {
    await handle.close();
  }
}

/**
 * Walks `outDir` with lstat. Returns { artifacts, published, truncated } where
 * `artifacts` are ManifestArtifact records (sorted, published first when the
 * `maxArtifacts` cap applies) and `published` lists files eligible for inline
 * upload as { relativePath, absolutePath, sha256, sizeBytes }.
 */
export async function evaluateEgress({ outDir, policy, datasetHashes, locatorPrefix, maxArtifacts = 500 }) {
  if (!policy || policy.schema !== "tanyan.egress/v1") throw new Error("egress policy missing or not tanyan.egress/v1");
  if (!(datasetHashes instanceof Set)) throw new TypeError("datasetHashes must be a Set");
  const root = await realpath(outDir);
  const entries = [];

  async function walk(directory, prefix) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolutePath = join(directory, name);
      const rawRelative = prefix ? `${prefix}/${name}` : name;
      const stats = await lstat(absolutePath);
      let relativePath;
      try {
        relativePath = normalizeRepoPath(rawRelative);
      } catch {
        entries.push({ relativePath: sanitizeForReport(rawRelative), special: "path is not a normalized relative path" });
        continue;
      }
      if (stats.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        entries.push({ relativePath, special: describeSpecial(stats) });
        continue;
      }
      const resolved = await realpath(absolutePath);
      if (resolved !== join(root, ...relativePath.split("/")) || !resolved.startsWith(root + sep)) {
        entries.push({ relativePath, special: "resolved path escapes out/" });
        continue;
      }
      const isMetrics = relativePath === METRICS_RELATIVE_PATH;
      const keepBytes = isMetrics && stats.size <= METRICS_EGRESS_LIMITS.maxBytes;
      const { sha256, bytes } = await hashRegularFileNoFollow(absolutePath, stats.ino, keepBytes);
      const metricsCheck = !isMetrics ? undefined
        : bytes ? checkMetricsEgress(bytes)
          : { ok: false, error: `metrics.json 大小 ${stats.size} 超过可信指标上限 ${METRICS_EGRESS_LIMITS.maxBytes}` };
      entries.push({ relativePath, absolutePath, sizeBytes: stats.size, sha256, linkCount: stats.nlink, metricsCheck });
    }
  }

  await walk(root, "");
  entries.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));

  let publishedBytes = 0;
  const artifacts = [];
  const published = [];
  for (const entry of entries) {
    const labLocator = `${locatorPrefix}/${entry.relativePath}`;
    if (entry.special) {
      artifacts.push({
        relativePath: entry.relativePath,
        sha256: "",
        sizeBytes: 0,
        kind: classifyKind(entry.relativePath),
        egressDecision: "rejected",
        egressReason: entry.special,
        labLocator,
      });
      continue;
    }
    const { decision, reason } = decideRegularFile(entry, policy, datasetHashes, publishedBytes);
    if (decision === "published") {
      publishedBytes += entry.sizeBytes;
      published.push({ relativePath: entry.relativePath, absolutePath: entry.absolutePath, sha256: entry.sha256, sizeBytes: entry.sizeBytes });
    }
    artifacts.push({
      relativePath: entry.relativePath,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      kind: classifyKind(entry.relativePath),
      egressDecision: decision,
      egressReason: reason,
      labLocator,
    });
  }

  let truncated = 0;
  let listed = artifacts;
  if (artifacts.length > maxArtifacts) {
    const rank = { published: 0, rejected: 1, held: 2 };
    listed = [...artifacts].sort((left, right) => rank[left.egressDecision] - rank[right.egressDecision]).slice(0, maxArtifacts);
    const keep = new Set(listed.map((artifact) => artifact.relativePath));
    truncated = artifacts.length - listed.length;
    listed = artifacts.filter((artifact) => keep.has(artifact.relativePath));
  }
  const listedPaths = new Set(listed.map((artifact) => artifact.relativePath));
  return { artifacts: listed, published: published.filter((file) => listedPaths.has(file.relativePath)), truncated };
}
