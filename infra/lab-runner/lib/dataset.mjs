// Dataset binding: the lab's dataset manifest file must hash to exactly what
// the approved RunSpec names, and its per-file hashes feed the egress gate.
import { readFile, stat } from "node:fs/promises";

import { sha256File } from "./fsutil.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA256SUM_LINE = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;
const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;

export class DataBindingError extends Error {}

/**
 * Verifies the configured manifest (and split manifest when the spec names
 * one) against the spec. Throws DataBindingError with a precise reason.
 */
export async function verifyDatasetBinding(spec, datasetConfig) {
  if (!datasetConfig) throw new DataBindingError(`dataset ${spec.dataset.versionId} is not hosted by this runner`);
  if (spec.dataset.mount !== "read_only") throw new DataBindingError("spec.dataset.mount must be read_only");
  const actual = await sha256File(datasetConfig.manifestPath).catch((error) => {
    throw new DataBindingError(`cannot read dataset manifest: ${error.code ?? error.message}`);
  });
  if (actual !== spec.dataset.manifestSha256) {
    throw new DataBindingError(`dataset manifest sha256 mismatch: expected ${spec.dataset.manifestSha256}, found ${actual}`);
  }
  let splitActual = "";
  if (spec.dataset.splitManifestSha256) {
    if (!datasetConfig.splitManifestPath) throw new DataBindingError("spec requires a split manifest but none is configured");
    splitActual = await sha256File(datasetConfig.splitManifestPath).catch((error) => {
      throw new DataBindingError(`cannot read split manifest: ${error.code ?? error.message}`);
    });
    if (splitActual !== spec.dataset.splitManifestSha256) {
      throw new DataBindingError(`split manifest sha256 mismatch: expected ${spec.dataset.splitManifestSha256}, found ${splitActual}`);
    }
  }
  return { manifestSha256: actual, splitManifestSha256: splitActual };
}

/**
 * Extracts every per-file sha256 from a dataset manifest. Supported formats:
 *  - JSON: any object property named `sha256` (at any depth) with a hex value;
 *  - text: `sha256sum` output lines (`<hex>  <path>`).
 * An empty result is an error: the raw-data-copy check would be meaningless.
 */
export async function loadDatasetFileHashes(manifestPath) {
  const info = await stat(manifestPath);
  if (info.size > MAX_MANIFEST_BYTES) throw new DataBindingError("dataset manifest too large to index");
  const text = await readFile(manifestPath, "utf8");
  const hashes = new Set();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    const stack = [parsed];
    while (stack.length) {
      const value = stack.pop();
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (key === "sha256" && typeof item === "string" && SHA256.test(item.toLowerCase())) hashes.add(item.toLowerCase());
          else if (item && typeof item === "object") stack.push(item);
        }
      }
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const match = SHA256SUM_LINE.exec(line.trim());
      if (match) hashes.add(match[1].toLowerCase());
    }
  }
  if (!hashes.size) throw new DataBindingError("dataset manifest lists no per-file sha256 values; egress raw-copy check impossible");
  return hashes;
}
