#!/usr/bin/env node
// Dataset ingest (R02): hashes every file under a dataset directory and writes
//   - the dataset manifest (tanyan.datamanifest/v1), whose sha256 is what an
//     admin registers and an approved RunSpec binds;
//   - the seal (tanyan.dataseal/v1): manifest sha256, dataDigest, the real
//     dataPath and every file's (path, size, mtimeNs, ctimeNs, ino).
//
// Run it as the admin who owns the data, on the path the runner will mount
// (e.g. the ZFS/btrfs read-only snapshot path), AFTER the data is made
// immutable (chmod/chown change ctime, which the seal records).
//
// Usage:
//   node infra/lab-runner/seal-dataset.mjs --data <dir> [--manifest <path>] [--seal <path>] [--no-seal] [--force]
// Defaults: <dir>.manifest.json and <dir>.seal.json next to the directory.
// Prints {manifestPath, manifestSha256, sealPath, dataDigest, fileCount, totalBytes} as JSON.
import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { computeDataDigest, DATA_MANIFEST_SCHEMA, DATA_SEAL_SCHEMA, hashVerifiedFile, walkDataTree } from "./lib/dataset.mjs";

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

async function realTarget(path) {
  // The output file may not exist yet: resolve its directory.
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), basename(absolute));
}

/** Hashes everything under dataPath and writes manifest (+ seal). Returns a summary. */
export async function sealDataset({ dataPath, manifestPath, sealPath, seal = true, force = false, concurrency = 4 }) {
  const root = await realpath(dataPath);
  manifestPath ??= `${root}.manifest.json`;
  sealPath ??= `${root}.seal.json`;
  for (const output of seal ? [manifestPath, sealPath] : [manifestPath]) {
    if (inside(root, await realTarget(output))) throw new Error(`${output} is inside the dataset directory; write manifest and seal next to it`);
  }
  const walk = await walkDataTree(root);
  if (walk.problems.length) throw new Error(`dataset cannot be sealed: ${walk.problems.slice(0, 20).join("; ")}`);
  if (!walk.files.size) throw new Error("dataset directory has no files");

  const paths = [...walk.files.keys()];
  const listing = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const index = next;
      next += 1;
      const path = paths[index];
      const sig = walk.files.get(path);
      listing[index] = { path, size: sig.size, sha256: await hashVerifiedFile(join(root, path), sig) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  listing.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));

  const flag = force ? "w" : "wx";
  const manifestText = `${JSON.stringify({ schema: DATA_MANIFEST_SCHEMA, files: listing }, null, 2)}\n`;
  await writeFile(manifestPath, manifestText, { flag, mode: 0o444 });
  const manifestSha256 = createHash("sha256").update(manifestText, "utf8").digest("hex");
  const dataDigest = computeDataDigest(listing);
  if (seal) {
    const sealDoc = {
      schema: DATA_SEAL_SCHEMA,
      sealedAt: new Date().toISOString(),
      dataPath: root,
      manifestSha256,
      dataDigest,
      files: listing.map(({ path }) => {
        const sig = walk.files.get(path);
        return { path, size: sig.size, mtimeNs: sig.mtimeNs, ctimeNs: sig.ctimeNs, ino: sig.ino };
      }),
    };
    await writeFile(sealPath, `${JSON.stringify(sealDoc, null, 2)}\n`, { flag, mode: 0o444 });
  }
  return {
    dataPath: root,
    manifestPath,
    manifestSha256,
    sealPath: seal ? sealPath : null,
    dataDigest,
    fileCount: listing.length,
    totalBytes: listing.reduce((sum, file) => sum + file.size, 0),
  };
}

function parseArgs(argv) {
  const options = { seal: true, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data") options.dataPath = argv[++index];
    else if (arg === "--manifest") options.manifestPath = argv[++index];
    else if (arg === "--seal") options.sealPath = argv[++index];
    else if (arg === "--no-seal") options.seal = false;
    else if (arg === "--force") options.force = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.dataPath) throw new Error("usage: seal-dataset.mjs --data <dir> [--manifest <path>] [--seal <path>] [--no-seal] [--force]");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  sealDataset(parseArgs(process.argv.slice(2)))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`[seal-dataset] ${error.message}\n`);
      process.exit(1);
    });
}
