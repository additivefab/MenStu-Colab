// Builds the container command as an argv array (never a shell string).
//
// Parameter passing rule (documented in README):
//   spec.entrypoint.params are appended to spec.entrypoint.argv as
//   `--<key>=<value>`, keys sorted by UTF-16 code unit; booleans become
//   `true`/`false`, numbers use JavaScript's String(). Keys must match
//   /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/. Values are passed verbatim as single argv
//   elements, so shell metacharacters have no meaning.
//
// Fixed mount points inside the container:
//   /src  code checkout (read-only)   /data dataset (read-only)   /out outputs (read-write)

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const CONTAINER_SRC = "/src";
export const CONTAINER_DATA = "/data";
export const CONTAINER_OUT = "/out";

/** Default isolation flags; see README "Isolation" for privilege notes. */
export const DEFAULT_ISOLATION_FLAGS = ["--containall", "--cleanenv", "--no-home", "--net", "--network", "none"];

const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const IMAGE_DIGEST = /@(sha256:[0-9a-f]{64})$/;

export function imageDigestFromRef(imageRef) {
  const match = IMAGE_DIGEST.exec(String(imageRef ?? ""));
  return match ? match[1] : "";
}

export function paramArgs(params) {
  const args = [];
  for (const key of Object.keys(params ?? {}).sort()) {
    if (!PARAM_KEY.test(key)) throw new Error(`invalid parameter key: ${JSON.stringify(key)}`);
    const value = params[key];
    if (typeof value === "string") args.push(`--${key}=${value}`);
    else if (typeof value === "boolean") args.push(`--${key}=${value ? "true" : "false"}`);
    else if (typeof value === "number" && Number.isFinite(value)) args.push(`--${key}=${String(value)}`);
    else throw new Error(`invalid parameter value for ${key}`);
  }
  return args;
}

/** Integer seeds taken only from params named `seed` or `seed_*`/`seed-*`. */
export function seedsFromParams(params) {
  return Object.keys(params ?? {})
    .filter((key) => /^seed(?:[_-].*)?$/i.test(key))
    .sort()
    .map((key) => params[key])
    .filter((value) => typeof value === "number" && Number.isInteger(value));
}

function assertBindablePath(label, path) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`${label} must be an absolute path`);
  if (/[:,\n\r\0]/.test(path)) throw new Error(`${label} must not contain ':' ',' or control characters (Apptainer bind syntax)`);
}

/**
 * Resolves the local image for a digest-pinned imageRef. Admins map refs to
 * pre-pulled SIF files (legacy string or a provenance entry, see
 * normalizeImageEntry); pulling by digest at run time is opt-in. This returns
 * the configured path only; verifyImage is what checks the file.
 */
export function resolveImage(imageRef, apptainerConfig) {
  if (!imageDigestFromRef(imageRef)) throw new Error("entrypoint imageRef must be pinned with @sha256:<digest>");
  const mapped = apptainerConfig.images?.[imageRef];
  if (mapped) return typeof mapped === "string" ? mapped : mapped.sifPath;
  if (apptainerConfig.allowPullByDigest) return `docker://${imageRef}`;
  throw new Error(`image ${imageRef} is not provisioned on this runner (apptainer.images)`);
}

// ---------------------------------------------------------------------------
// Image provenance (batch 7, G02)
//
// An OCI digest (what the RunSpec pins) and the sha256 of a local SIF file are
// different kinds of digest and cannot be compared. Provenance entries record
// both, plus free-text `source`, and the runner checks the SIF bytes against
// `sifSha256` before every submit:
//
//   "images": { "<repo>@sha256:<oci>": {
//     "ociDigest": "sha256:<oci>", "sifPath": "/srv/.../train.sif",
//     "sifSha256": "<64 hex>", "source": "built from recipe X by admin Y",
//     "verifySignature": false, "allowRunnerWritable": false } }
//
// A plain string value (legacy) still works but is reported as unverified.
// ---------------------------------------------------------------------------

export class ImageProvenanceError extends Error {}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_SOURCE_CHARS = 300; // platform manifest limit for environment.imageSource
const CONTROL_CHARS = { test: (text) => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) };

/**
 * Validates one `apptainer.images` value. Returns { legacy: true, sifPath } or
 * { legacy: false, ociDigest, sifPath, sifSha256, source, verifySignature, allowRunnerWritable }.
 */
export function normalizeImageEntry(imageRef, entry) {
  const where = `apptainer.images[${JSON.stringify(imageRef)}]`;
  const digest = imageDigestFromRef(imageRef);
  if (!digest) throw new ImageProvenanceError(`${where}: key must be pinned with @sha256:<digest>`);
  if (typeof entry === "string") {
    assertImagePath(where, entry);
    return { legacy: true, sifPath: entry };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ImageProvenanceError(`${where}: must be a SIF path or { ociDigest, sifPath, sifSha256, source }`);
  }
  if (entry.ociDigest !== digest) throw new ImageProvenanceError(`${where}.ociDigest must equal the digest in the key (${digest})`);
  assertImagePath(`${where}.sifPath`, entry.sifPath);
  if (typeof entry.sifSha256 !== "string" || !SHA256_HEX.test(entry.sifSha256)) {
    throw new ImageProvenanceError(`${where}.sifSha256 must be 64 lowercase hex characters (sha256 of the SIF file, not the OCI digest)`);
  }
  const source = typeof entry.source === "string" ? entry.source.trim() : "";
  if (!source || source.length > MAX_SOURCE_CHARS || CONTROL_CHARS.test(source)) {
    throw new ImageProvenanceError(`${where}.source must be 1-${MAX_SOURCE_CHARS} printable characters (build recipe, registry ref or signer)`);
  }
  for (const flag of ["verifySignature", "allowRunnerWritable"]) {
    if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") throw new ImageProvenanceError(`${where}.${flag} must be a boolean`);
  }
  return {
    legacy: false,
    ociDigest: digest,
    sifPath: entry.sifPath,
    sifSha256: entry.sifSha256,
    source,
    verifySignature: entry.verifySignature === true,
    allowRunnerWritable: entry.allowRunnerWritable === true,
  };
}

function assertImagePath(label, path) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new ImageProvenanceError(`${label} must be an absolute path`);
  if (/[:,]/.test(path) || CONTROL_CHARS.test(path)) throw new ImageProvenanceError(`${label} must not contain ':' ',' or control characters`);
}

/**
 * Startup check of every image entry. Throws ImageProvenanceError on a
 * malformed entry; returns warnings (legacy entries, pull-by-digest) for the
 * caller to log.
 */
export function checkImageConfig(apptainerConfig) {
  const warnings = [];
  for (const [imageRef, entry] of Object.entries(apptainerConfig.images ?? {})) {
    const normalized = normalizeImageEntry(imageRef, entry);
    if (normalized.legacy) {
      warnings.push({
        message: "image provenance is unverified: legacy apptainer.images entry has no sifSha256/source, so the SIF file is not checked before submit",
        fields: { imageRef, sifPath: normalized.sifPath },
      });
    }
  }
  if (apptainerConfig.allowPullByDigest) {
    warnings.push({ message: "allowPullByDigest is on: pulled images carry no recorded SIF file hash or source", fields: {} });
  }
  return warnings;
}

/**
 * Hash cache keyed by file identity and stat metadata
 * (dev, ino, size, mtime ns, ctime ns). It TRUSTS that metadata: a writer that
 * can change the bytes while keeping all of these (e.g. root writing the block
 * device directly) defeats it. ctime cannot be set through utimes(), so an
 * in-place edit followed by `touch -d` still forces a re-hash. In-memory only;
 * a runner restart re-hashes each image once.
 */
export function createImageHashCache() {
  const entries = new Map();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, value); },
    get size() { return entries.size; },
  };
}

function statKey(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
}

async function runnerCanWrite(path) {
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Immutability rules (README "Image provenance"):
 *  - the real file must be a regular file and not group/world-writable;
 *  - no directory from the file up to / may be group/world-writable unless it
 *    has the sticky bit;
 *  - the runner user itself must not be able to write the file or any of those
 *    (non-sticky) directories, unless the entry sets allowRunnerWritable;
 *  - a symlinked sifPath must point to a location nobody, not even the runner,
 *    can write; allowRunnerWritable does not relax this.
 * Returns the resolved real path.
 */
async function checkImmutable(entry) {
  let linkInfo;
  try {
    linkInfo = await lstat(entry.sifPath);
  } catch (error) {
    throw new ImageProvenanceError(`SIF file ${entry.sifPath} is missing or unreadable (${error?.code ?? "error"})`);
  }
  const isLink = linkInfo.isSymbolicLink();
  let real;
  try {
    real = await realpath(entry.sifPath);
  } catch (error) {
    throw new ImageProvenanceError(`SIF ${entry.sifPath} cannot be resolved (${error?.code ?? "error"})`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new ImageProvenanceError(`SIF ${entry.sifPath} is not a regular file`);
  const linkTarget = isLink ? `SIF ${entry.sifPath} is a symlink to a writable location` : null;
  if (info.mode & 0o022) {
    throw new ImageProvenanceError(`${linkTarget ?? `SIF ${real}`} (${real} is group/world-writable, mode ${(info.mode & 0o777).toString(8)}); refusing`);
  }
  const checkRunner = isLink || !entry.allowRunnerWritable;
  if (checkRunner && (await runnerCanWrite(real))) {
    throw new ImageProvenanceError(linkTarget
      ? `${linkTarget} (${real} is writable by the runner user); refusing`
      : `SIF ${real} is writable by the runner user; make it read-only (or set allowRunnerWritable); refusing`);
  }
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const dirInfo = await stat(dir);
    const sticky = (dirInfo.mode & 0o1000) !== 0;
    if ((dirInfo.mode & 0o022) && !sticky) {
      throw new ImageProvenanceError(`${linkTarget ?? `SIF ${real}`} (directory ${dir} is group/world-writable without the sticky bit); refusing`);
    }
    if (checkRunner && !sticky && (await runnerCanWrite(dir))) {
      throw new ImageProvenanceError(linkTarget
        ? `${linkTarget} (directory ${dir} is writable by the runner user); refusing`
        : `directory ${dir} holding SIF ${real} is writable by the runner user, which could replace the file (or set allowRunnerWritable); refusing`);
    }
    if (dir === dirname(dir)) break;
  }
  return real;
}

/** Streams the already-open file through sha256 (constant memory). */
async function hashOpenFile(handle) {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 1 << 20 })) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Verifies the SIF for `imageRef` before submit. Returns
 *   { verified: true, path, sifSha256, source, cached } for provenance entries,
 *   { verified: false, path } for legacy entries and pull-by-digest.
 * Throws ImageProvenanceError with a reason suitable for failureReason.
 * `runVerify(path)` runs `apptainer verify` and resolves { code, stdout, stderr }.
 */
export async function verifyImage(imageRef, apptainerConfig, { cache, runVerify } = {}) {
  let path;
  try {
    path = resolveImage(imageRef, apptainerConfig);
  } catch (error) {
    throw new ImageProvenanceError(error instanceof Error ? error.message : String(error));
  }
  const raw = apptainerConfig.images?.[imageRef];
  if (!raw) return { verified: false, path };
  const entry = normalizeImageEntry(imageRef, raw);
  if (entry.legacy) return { verified: false, path };

  const real = await checkImmutable(entry);
  // Hash through one descriptor whose identity is the cache key, so the bytes
  // hashed are the bytes of the file that was stat'ed.
  const handle = await open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let actual;
  let cached = false;
  try {
    const key = statKey(await handle.stat({ bigint: true }));
    actual = cache?.get(key);
    if (actual) cached = true;
    else {
      actual = await hashOpenFile(handle);
      if (statKey(await handle.stat({ bigint: true })) !== key) throw new ImageProvenanceError(`SIF ${real} changed while it was being hashed; refusing`);
      cache?.set(key, actual);
    }
  } finally {
    await handle.close();
  }
  if (actual !== entry.sifSha256) {
    throw new ImageProvenanceError(`SIF file hash mismatch for ${imageRef}: ${real} has sha256 ${actual}, config expects ${entry.sifSha256}; refusing to run`);
  }
  if (entry.verifySignature) {
    if (!runVerify) throw new ImageProvenanceError("verifySignature is set but no signature verifier is available");
    let result;
    try {
      result = await runVerify(real);
    } catch (error) {
      throw new ImageProvenanceError(`apptainer verify could not run for ${real}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.code !== 0) {
      const detail = `${result.stderr ?? ""} ${result.stdout ?? ""}`.trim().replace(/\s+/g, " ").slice(0, 300);
      throw new ImageProvenanceError(`apptainer verify failed for ${real} (exit ${result.code})${detail ? `: ${detail}` : ""}`);
    }
  }
  return { verified: true, path: real, sifSha256: actual, source: entry.source, cached };
}

/**
 * Returns { argv, env } for the job launcher. `env` contains only
 * APPTAINERENV_* values (passed into the container even with --cleanenv) and
 * the host variables the apptainer binary itself needs.
 */
export function buildContainerCommand({ spec, runId, srcDir, dataPath, outDir, apptainer, imagePath }) {
  assertBindablePath("code checkout path", srcDir);
  assertBindablePath("dataset path", dataPath);
  assertBindablePath("output path", outDir);
  if (spec.network !== "deny") throw new Error("spec.network must be deny");
  if (!Array.isArray(spec.entrypoint?.argv) || !spec.entrypoint.argv.length || spec.entrypoint.argv.some((arg) => typeof arg !== "string")) {
    throw new Error("spec.entrypoint.argv must be a non-empty string array");
  }
  // imagePath: the file verifyImage checked (symlinks resolved), when given.
  const image = imagePath ?? resolveImage(spec.entrypoint.imageRef, apptainer);
  const isolation = apptainer.isolationFlags ?? DEFAULT_ISOLATION_FLAGS;
  const resources = spec.resources ?? {};
  const argv = [
    apptainer.binary || "apptainer",
    "exec",
    ...isolation,
    ...(resources.gpuCount > 0 ? ["--nv"] : []),
    ...(apptainer.applyMemoryLimit && resources.memoryGb > 0 ? ["--memory", `${resources.memoryGb}G`] : []),
    "--bind", `${srcDir}:${CONTAINER_SRC}:ro`,
    "--bind", `${dataPath}:${CONTAINER_DATA}:ro`,
    "--bind", `${outDir}:${CONTAINER_OUT}:rw`,
    // `--cwd` per current Apptainer docs ("synonym for --pwd"); Apptainer 1.0 needs "--pwd".
    apptainer.cwdFlag || "--cwd", CONTAINER_SRC,
    ...(apptainer.extraFlags ?? []),
    image,
    ...spec.entrypoint.argv,
    ...paramArgs(spec.entrypoint.params),
  ];
  const env = {
    APPTAINERENV_TANYAN_RUN_ID: runId,
    APPTAINERENV_TANYAN_SRC_DIR: CONTAINER_SRC,
    APPTAINERENV_TANYAN_DATA_DIR: CONTAINER_DATA,
    APPTAINERENV_TANYAN_OUT_DIR: CONTAINER_OUT,
  };
  return { argv, env };
}
