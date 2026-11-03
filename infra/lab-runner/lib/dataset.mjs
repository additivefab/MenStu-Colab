// Dataset binding (R02). An approved RunSpec names the dataset manifest by
// sha256; the runner proves that the bytes under `dataPath` are exactly the
// bytes that manifest lists, mounts that same verified directory read-only,
// and re-checks every file's stat signature after the job ends.
//
// Two verification modes (README "Dataset binding"):
//  - "full": walk dataPath with lstat (no symlink following) and re-hash every
//    file against the manifest;
//  - "sealed_snapshot": the dataset is an immutable snapshot sealed at ingest
//    by seal-dataset.mjs; the runner checks the seal and every file's stat
//    signature (size, mtime, ctime, inode) without re-hashing. This TRUSTS the
//    snapshot's immutability; see the README.
//
// The verified listing is condensed into `dataDigest`: sha256 of the canonical
// JSON array [{path, sha256, size}, ...] (keys in that order, entries sorted by
// the UTF-8 bytes of `path`, no whitespace), i.e. contracts `canonicalJson` of
// the listing.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { sha256File } from "./fsutil.mjs";

export const DATA_MANIFEST_SCHEMA = "tanyan.datamanifest/v1";
export const DATA_SEAL_SCHEMA = "tanyan.dataseal/v1";
export const EXTRA_FILE_POLICIES = Object.freeze(["reject", "ignore"]);

const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]{1,30}$/;
const SHA256SUM_LINE = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;
const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;
const MAX_SEAL_BYTES = 1024 * 1024 * 1024;
const HASH_CONCURRENCY = 4;
const MAX_REASON_CHARS = 600;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export class DataBindingError extends Error {}

// ---------------------------------------------------------------------------
// manifest parsing
// ---------------------------------------------------------------------------

/**
 * Normalized relative POSIX path: no leading "/", no "." / ".." / empty
 * segments, no backslashes or control characters. Returns the path or throws.
 */
export function normalizeDataPath(raw, { allowDotSlash = false } = {}) {
  if (typeof raw !== "string" || !raw) throw new DataBindingError("dataset manifest path must be a non-empty string");
  let path = raw;
  if (allowDotSlash) while (path.startsWith("./")) path = path.slice(2);
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(path)) throw new DataBindingError(`dataset manifest path has a backslash or control character: ${JSON.stringify(raw)}`);
  if (path.startsWith("/")) throw new DataBindingError(`dataset manifest path must be relative: ${JSON.stringify(raw)}`);
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new DataBindingError(`dataset manifest path is not normalized (empty, "." or ".." segment): ${JSON.stringify(raw)}`);
  }
  return path;
}

function sizeValue(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DataBindingError(`${label}: size must be a non-negative integer`);
  return value;
}

/**
 * Parses a dataset manifest. Accepted formats:
 *  - tanyan.datamanifest/v1: `{"schema":"tanyan.datamanifest/v1","files":[{path,size,sha256}]}`
 *    or the bare list `[{path,size,sha256}]`;
 *  - `sha256sum` output (`<hex>  <path>`, optional `*`, optional leading "./");
 *    sizes are then unknown (null) and taken from disk or the seal.
 * Returns { format, entries: Map<path, {size: number|null, sha256}> }.
 */
export function parseDataManifest(text) {
  let parsed;
  let isJson = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    isJson = false;
  }
  const entries = new Map();
  const add = (path, size, sha256) => {
    if (entries.has(path)) throw new DataBindingError(`dataset manifest lists ${JSON.stringify(path)} twice`);
    entries.set(path, { size, sha256 });
  };
  let format;
  if (isJson) {
    let list;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && typeof parsed === "object" && parsed.schema === DATA_MANIFEST_SCHEMA && Array.isArray(parsed.files)) list = parsed.files;
    else throw new DataBindingError(`JSON dataset manifest must be ${DATA_MANIFEST_SCHEMA} ({schema, files:[{path,size,sha256}]}) or a bare list of {path,size,sha256}`);
    format = DATA_MANIFEST_SCHEMA;
    for (const [index, item] of list.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new DataBindingError(`dataset manifest entry ${index} must be an object`);
      const path = normalizeDataPath(item.path);
      if (item.path !== path) throw new DataBindingError(`dataset manifest entry ${index} path is not normalized`);
      const sha256 = typeof item.sha256 === "string" ? item.sha256.toLowerCase() : "";
      if (!SHA256.test(sha256)) throw new DataBindingError(`dataset manifest entry ${JSON.stringify(path)}: sha256 must be 64 hex characters`);
      add(path, sizeValue(item.size, `dataset manifest entry ${JSON.stringify(path)}`), sha256);
    }
  } else {
    format = "sha256sum";
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("\\")) throw new DataBindingError("sha256sum lines with escaped file names are not supported");
      const match = SHA256SUM_LINE.exec(line);
      if (!match) throw new DataBindingError(`unparseable sha256sum line: ${JSON.stringify(line.slice(0, 120))}`);
      add(normalizeDataPath(match[2], { allowDotSlash: true }), null, match[1].toLowerCase());
    }
  }
  if (!entries.size) throw new DataBindingError("dataset manifest lists no files");
  return { format, entries };
}

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

function byPathBytes(a, b) {
  return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
}

/** Canonical JSON listing: [{path, sha256, size}] sorted by UTF-8 path bytes. */
export function canonicalListing(files) {
  const sorted = [...files].sort(byPathBytes);
  return JSON.stringify(sorted.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })));
}

export function computeDataDigest(files) {
  return createHash("sha256").update(canonicalListing(files), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// filesystem walk (lstat only, never follows symlinks)
// ---------------------------------------------------------------------------

function signatureOf(info) {
  return { size: Number(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), ino: String(info.ino), dev: String(info.dev) };
}

function sameSignature(a, b) {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino && a.dev === b.dev;
}

function sameNode(a, b) {
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * Walks `root` (an already-resolved real directory) with lstat. Returns
 * { root: {dev, ino}, dirs: Map<rel, {dev, ino}>, files: Map<rel, signature>, problems: string[] }.
 * Symlinks, special files, other filesystems mounted inside, and directories
 * that change identity while being listed are problems (never followed).
 */
export async function walkDataTree(root) {
  const problems = [];
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory()) throw new DataBindingError("dataPath is not a directory");
  const rootNode = { dev: String(rootInfo.dev), ino: String(rootInfo.ino) };
  const dirs = new Map();
  const files = new Map();
  const stack = [{ rel: "", node: rootNode }];
  while (stack.length) {
    const { rel, node } = stack.pop();
    const abs = rel ? join(root, rel) : root;
    let names;
    try {
      names = await readdir(abs);
    } catch (error) {
      problems.push(`cannot list ${rel || "."}: ${error.code ?? error.message}`);
      continue;
    }
    // A directory swapped for a symlink between lstat and readdir would be
    // listed through the link; re-check its identity after listing.
    const after = await lstat(abs, { bigint: true }).catch(() => null);
    if (!after || !after.isDirectory() || !sameNode({ dev: String(after.dev), ino: String(after.ino) }, node)) {
      problems.push(`directory changed while being listed: ${rel || "."}`);
      continue;
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      let info;
      try {
        info = await lstat(join(root, childRel), { bigint: true });
      } catch (error) {
        problems.push(`cannot stat ${childRel}: ${error.code ?? error.message}`);
        continue;
      }
      if (info.isSymbolicLink()) problems.push(`symlink: ${childRel}`);
      else if (String(info.dev) !== rootNode.dev) problems.push(`other filesystem mounted inside dataPath: ${childRel}`);
      else if (info.isDirectory()) {
        const child = { dev: String(info.dev), ino: String(info.ino) };
        dirs.set(childRel, child);
        stack.push({ rel: childRel, node: child });
      } else if (info.isFile()) files.set(childRel, signatureOf(info));
      else problems.push(`special file: ${childRel}`);
    }
  }
  return { root: rootNode, dirs, files, problems };
}

class FileChangedError extends Error {}

/**
 * Streams one regular file through sha256. Opened with O_NOFOLLOW; the open
 * file's identity and stat signature must equal the walk's lstat before and
 * after reading, so a swap or write during hashing is caught here.
 */
export async function hashVerifiedFile(absPath, expected) {
  const handle = await open(absPath, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameSignature(signatureOf(before), expected)) throw new FileChangedError("changed between listing and hashing");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, highWaterMark: 1 << 20 })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameSignature(signatureOf(after), expected) || bytes !== expected.size) throw new FileChangedError("changed while being hashed");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function mapBounded(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function summarize(problems) {
  let text = `${problems.length} problem(s): `;
  for (const [index, problem] of problems.entries()) {
    const piece = `${index ? "; " : ""}${problem}`;
    if (text.length + piece.length > MAX_REASON_CHARS) {
      text += `; … ${problems.length - index} more`;
      break;
    }
    text += piece;
  }
  return text;
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

async function readBounded(path, maxBytes, label) {
  const fail = (error) => {
    throw new DataBindingError(`cannot read ${label}: ${error.code ?? error.message}`);
  };
  const info = await stat(path).catch(fail);
  if (info.size > maxBytes) throw new DataBindingError(`${label} too large`);
  return readFile(path).catch(fail);
}

/** Splits walked files into manifest files, missing entries and extras. */
function compareWithManifest(walk, entries) {
  const missing = [];
  const present = [];
  for (const [path, entry] of entries) {
    const sig = walk.files.get(path);
    if (!sig) missing.push(path);
    else present.push({ path, entry, sig });
  }
  const extras = [...walk.files.keys()].filter((path) => !entries.has(path)).sort();
  return { missing, present, extras };
}

async function verifyFull(root, walk, entries, policy) {
  const problems = [...walk.problems];
  const { missing, present, extras } = compareWithManifest(walk, entries);
  for (const path of missing) problems.push(`missing: ${path}`);
  if (policy === "reject") for (const path of extras) problems.push(`not in manifest: ${path}`);
  const toHash = [...present, ...(policy === "ignore" ? extras.map((path) => ({ path, entry: null, sig: walk.files.get(path) })) : [])];
  const hashed = await mapBounded(toHash, HASH_CONCURRENCY, async (item) => {
    if (item.entry && item.entry.size !== null && item.entry.size !== item.sig.size) return { ...item, problem: `modified (size ${item.sig.size}, manifest ${item.entry.size}): ${item.path}` };
    try {
      const sha256 = await hashVerifiedFile(join(root, item.path), item.sig);
      if (item.entry && sha256 !== item.entry.sha256) return { ...item, problem: `modified (sha256 differs): ${item.path}` };
      return { ...item, sha256 };
    } catch (error) {
      if (error instanceof FileChangedError) return { ...item, problem: `${error.message}: ${item.path}` };
      if (error?.code === "ELOOP" || error?.code === "EMLINK") return { ...item, problem: `symlink: ${item.path}` };
      return { ...item, problem: `cannot read ${item.path}: ${error.code ?? error.message}` };
    }
  });
  const listing = [];
  const ignoredExtraFiles = [];
  for (const item of hashed) {
    if (item.problem) problems.push(item.problem);
    else if (item.entry) listing.push({ path: item.path, size: item.sig.size, sha256: item.sha256 });
    else ignoredExtraFiles.push({ path: item.path, size: item.sig.size, sha256: item.sha256 });
  }
  return { problems, listing, ignoredExtraFiles };
}

function parseSeal(text) {
  let seal;
  try {
    seal = JSON.parse(text);
  } catch {
    throw new DataBindingError("dataset seal is not valid JSON");
  }
  if (!seal || typeof seal !== "object" || seal.schema !== DATA_SEAL_SCHEMA) throw new DataBindingError(`dataset seal must be ${DATA_SEAL_SCHEMA}`);
  if (!SHA256.test(seal.manifestSha256 ?? "") || !SHA256.test(seal.dataDigest ?? "")) throw new DataBindingError("dataset seal lacks manifestSha256/dataDigest");
  if (typeof seal.dataPath !== "string" || !Array.isArray(seal.files)) throw new DataBindingError("dataset seal lacks dataPath/files");
  const files = new Map();
  for (const item of seal.files) {
    const path = normalizeDataPath(item?.path);
    if (item.path !== path || files.has(path)) throw new DataBindingError(`dataset seal entry ${JSON.stringify(path)} is not normalized or repeated`);
    for (const key of ["mtimeNs", "ctimeNs", "ino"]) {
      if (typeof item[key] !== "string" || !DECIMAL.test(item[key])) throw new DataBindingError(`dataset seal entry ${JSON.stringify(path)}: ${key} must be a decimal string`);
    }
    files.set(path, { size: sizeValue(item.size, `dataset seal entry ${JSON.stringify(path)}`), mtimeNs: item.mtimeNs, ctimeNs: item.ctimeNs, ino: item.ino });
  }
  return { ...seal, files };
}

async function verifySealed(root, walk, entries, policy, { sealPath, manifestSha256 }) {
  const sealInfo = await lstat(sealPath).catch((error) => {
    throw new DataBindingError(`cannot read dataset seal: ${error.code ?? error.message}`);
  });
  if (!sealInfo.isFile()) throw new DataBindingError("dataset seal must be a regular file (not a symlink)");
  if ((sealInfo.mode & 0o022) !== 0) throw new DataBindingError("dataset seal is writable by group/other; seal must be admin-owned and read-only");
  const seal = parseSeal((await readBounded(sealPath, MAX_SEAL_BYTES, "dataset seal")).toString("utf8"));
  if (seal.manifestSha256 !== manifestSha256) throw new DataBindingError("dataset seal was written for a different manifest");
  if (seal.dataPath !== root) throw new DataBindingError(`dataset seal covers ${seal.dataPath}, not ${root}`);

  // The seal must describe exactly the manifest's files.
  const listing = [];
  for (const [path, entry] of entries) {
    const sealed = seal.files.get(path);
    if (!sealed) throw new DataBindingError(`dataset seal does not cover manifest file ${path}`);
    if (entry.size !== null && entry.size !== sealed.size) throw new DataBindingError(`dataset seal size differs from manifest for ${path}`);
    listing.push({ path, size: sealed.size, sha256: entry.sha256 });
  }
  if (seal.files.size !== entries.size) throw new DataBindingError("dataset seal lists files the manifest does not");
  if (computeDataDigest(listing) !== seal.dataDigest) throw new DataBindingError("dataset seal dataDigest does not match the manifest listing");

  const problems = [...walk.problems];
  const { missing, present, extras } = compareWithManifest(walk, entries);
  for (const path of missing) problems.push(`missing: ${path}`);
  for (const { path, sig } of present) {
    const sealed = seal.files.get(path);
    if (sig.size !== sealed.size) problems.push(`size changed since sealed: ${path}`);
    else if (sig.mtimeNs !== sealed.mtimeNs || sig.ctimeNs !== sealed.ctimeNs) problems.push(`mtime/ctime changed since sealed: ${path}`);
    else if (sig.ino !== sealed.ino) problems.push(`inode changed since sealed (replaced): ${path}`);
  }
  const ignoredExtraFiles = [];
  for (const path of extras) {
    if (policy === "reject") problems.push(`not in manifest: ${path}`);
    else ignoredExtraFiles.push({ path, size: walk.files.get(path).size });
  }
  return { problems, listing, ignoredExtraFiles };
}

/**
 * Verifies the manifest (and split manifest when the spec names one) against
 * the spec, then the bytes under dataPath against the manifest. Throws
 * DataBindingError with a precise reason. On success returns the binding
 * record the runner persists: the real path to mount, dataDigest,
 * dataVerification, ignored extra files and the stat signature used for the
 * post-run re-check.
 */
export async function verifyDatasetBinding(spec, datasetConfig) {
  const { manifestBytes, manifestSha256: actual, splitManifestSha256: splitActual } = await verifyManifestHashes(spec, datasetConfig);
  const { format, entries } = parseDataManifest(manifestBytes.toString("utf8"));

  const root = await realpath(datasetConfig.dataPath).catch((error) => {
    throw new DataBindingError(`cannot resolve dataPath: ${error.code ?? error.message}`);
  });
  const policy = datasetConfig.extraFiles ?? "reject";
  if (!EXTRA_FILE_POLICIES.includes(policy)) throw new DataBindingError(`invalid extraFiles policy ${JSON.stringify(policy)}`);
  const walk = await walkDataTree(root);
  const sealed = Boolean(datasetConfig.snapshot?.sealPath);
  const result = sealed
    ? await verifySealed(root, walk, entries, policy, { sealPath: datasetConfig.snapshot.sealPath, manifestSha256: actual })
    : await verifyFull(root, walk, entries, policy);
  if (result.problems.length) throw new DataBindingError(`dataset bytes do not match the manifest: ${summarize(result.problems)}`);

  return {
    schema: "tanyan.lab-runner.databinding/v1",
    versionId: spec.dataset.versionId,
    manifestSha256: actual,
    splitManifestSha256: splitActual,
    manifestFormat: format,
    dataPath: root,
    dataVerification: sealed ? "sealed_snapshot" : "full",
    dataDigest: computeDataDigest(result.listing),
    fileCount: result.listing.length,
    totalBytes: result.listing.reduce((sum, file) => sum + file.size, 0),
    extraFiles: policy,
    ignoredExtraFiles: result.ignoredExtraFiles,
    verifiedAt: new Date().toISOString(),
    signature: {
      root: walk.root,
      dirs: Object.fromEntries(walk.dirs),
      files: Object.fromEntries(result.listing.map(({ path }) => [path, walk.files.get(path)])),
    },
  };
}

/**
 * Cheap first step (no data access): the manifest, and the split manifest
 * when the spec names one, must hash to the approved values. The runner calls
 * this before checkout so an obviously wrong binding fails early.
 */
export async function verifyManifestHashes(spec, datasetConfig) {
  if (!datasetConfig) throw new DataBindingError(`dataset ${spec.dataset.versionId} is not hosted by this runner`);
  if (spec.dataset.mount !== "read_only") throw new DataBindingError("spec.dataset.mount must be read_only");
  // Hash and parse the same bytes.
  const manifestBytes = await readBounded(datasetConfig.manifestPath, MAX_MANIFEST_BYTES, "dataset manifest");
  const actual = createHash("sha256").update(manifestBytes).digest("hex");
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

  return { manifestBytes, manifestSha256: actual, splitManifestSha256: splitActual };
}

/**
 * Post-run re-check (TOCTOU): walks the mounted path again and compares the
 * stat signature (size, mtime, ctime, inode, device) of every manifest file
 * and the identity of every directory with what was verified before submit.
 * New extra files are refused under "reject" and recorded under "ignore".
 * Returns { unchanged, changes: string[], reason, newlyIgnored: string[] }.
 */
export async function recheckDatasetBinding(binding) {
  const changes = [];
  let walk;
  try {
    walk = await walkDataTree(binding.dataPath);
  } catch (error) {
    changes.push(`cannot walk ${binding.dataPath}: ${error.code ?? error.message}`);
    return { unchanged: false, changes, reason: summarize(changes), newlyIgnored: [] };
  }
  changes.push(...walk.problems);
  if (!sameNode(walk.root, binding.signature.root)) changes.push("dataPath directory replaced");
  for (const [rel, node] of Object.entries(binding.signature.dirs)) {
    const now = walk.dirs.get(rel);
    if (!now) changes.push(`directory removed or replaced: ${rel}`);
    else if (!sameNode(now, node)) changes.push(`directory replaced: ${rel}`);
  }
  for (const [path, sig] of Object.entries(binding.signature.files)) {
    const now = walk.files.get(path);
    if (!now) changes.push(`removed: ${path}`);
    else if (!sameSignature(now, sig)) changes.push(`changed (${describeDiff(now, sig)}): ${path}`);
  }
  const known = new Set(binding.ignoredExtraFiles.map((file) => file.path));
  const newlyIgnored = [];
  for (const path of [...walk.files.keys()].sort()) {
    if (Object.hasOwn(binding.signature.files, path) || known.has(path)) continue;
    if (binding.extraFiles === "reject") changes.push(`appeared: ${path}`);
    else newlyIgnored.push(path);
  }
  return { unchanged: changes.length === 0, changes, reason: changes.length ? summarize(changes) : "", newlyIgnored };
}

function describeDiff(now, before) {
  const keys = ["size", "mtimeNs", "ctimeNs", "ino", "dev"].filter((key) => now[key] !== before[key]);
  return keys.join(",");
}

/**
 * Extracts every per-file sha256 from a dataset manifest for the egress gate.
 * Supported formats:
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
