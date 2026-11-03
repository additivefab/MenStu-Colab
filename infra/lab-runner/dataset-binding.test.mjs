// R02 regression tests: the approved manifest must bind the actual bytes under
// dataPath (full re-hash or sealed snapshot), and a change during the run must
// be detected after the job ends. Synthetic datasets in temp dirs only.
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { createRunner } from "./runner.mjs";
import {
  computeDataDigest, DataBindingError, parseDataManifest, recheckDatasetBinding, verifyDatasetBinding,
} from "./lib/dataset.mjs";
import { createLogger } from "./lib/log.mjs";
import { sealDataset } from "./seal-dataset.mjs";
import { startFakePlatform } from "./test-support/fake-platform.mjs";
import {
  captureLogger, createDataset, createRepo, installShim, makeConfig, makeSpec, makeWork, sha256, tempRoot,
} from "./test-support/fixtures.mjs";

const FILES = { "a.bin": "alpha-bytes", "sub/b.bin": "bravo-bytes", "sub/deep/c.bin": "charlie" };

/** Writes FILES under <root>/data and a tanyan.datamanifest/v1 manifest next to it. */
function makeDataset(t, { files = FILES } = {}) {
  const root = tempRoot(t);
  const dataPath = join(root, "data");
  const listing = [];
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dataPath, path, ".."), { recursive: true });
    writeFileSync(join(dataPath, path), content);
    listing.push({ path, size: Buffer.byteLength(content), sha256: sha256(content) });
  }
  const manifestText = JSON.stringify({ schema: "tanyan.datamanifest/v1", files: listing });
  const manifestPath = join(root, "data.manifest.json");
  writeFileSync(manifestPath, manifestText);
  const spec = { dataset: { versionId: "ds_1", manifestSha256: sha256(manifestText), splitManifestSha256: "", mount: "read_only" } };
  return { root, dataPath, manifestPath, listing, spec, config: { versionId: "ds_1", dataPath, manifestPath, splitManifestPath: null, extraFiles: "reject", snapshot: null } };
}

async function sealed(t) {
  const root = tempRoot(t);
  const dataPath = join(root, "data");
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(join(dataPath, path, ".."), { recursive: true });
    writeFileSync(join(dataPath, path), content);
  }
  const summary = await sealDataset({ dataPath });
  const spec = { dataset: { versionId: "ds_1", manifestSha256: summary.manifestSha256, splitManifestSha256: "", mount: "read_only" } };
  const config = { versionId: "ds_1", dataPath, manifestPath: summary.manifestPath, splitManifestPath: null, extraFiles: "reject", snapshot: { sealPath: summary.sealPath } };
  return { root, dataPath, summary, spec, config };
}

// ---------------------------------------------------------------------------
// manifest format
// ---------------------------------------------------------------------------

test("manifest format: tanyan.datamanifest/v1 object or bare list, sha256sum text; paths normalized", () => {
  const entry = { path: "x/y.bin", size: 3, sha256: "a".repeat(64) };
  assert.equal(parseDataManifest(JSON.stringify({ schema: "tanyan.datamanifest/v1", files: [entry] })).entries.get("x/y.bin").size, 3);
  assert.equal(parseDataManifest(JSON.stringify([entry])).entries.size, 1);
  const sums = parseDataManifest(`${"b".repeat(64)}  ./x/y.bin\n${"C".repeat(64)} *z.bin\n`);
  assert.equal(sums.format, "sha256sum");
  assert.deepEqual(sums.entries.get("x/y.bin"), { size: null, sha256: "b".repeat(64) });
  assert.equal(sums.entries.get("z.bin").sha256, "c".repeat(64));
  for (const path of ["../x", "/etc/passwd", "a/../b", "a//b", "./a", "a\\b", "a/"]) {
    assert.throws(() => parseDataManifest(JSON.stringify([{ ...entry, path }])), DataBindingError, path);
  }
  assert.throws(() => parseDataManifest(JSON.stringify([entry, entry])), /twice/);
  assert.throws(() => parseDataManifest(JSON.stringify({ schema: "lab.dataset/v1", files: [entry] })), /tanyan.datamanifest\/v1/);
  assert.throws(() => parseDataManifest(JSON.stringify([{ path: "a", sha256: "a".repeat(64) }])), /size/);
  assert.throws(() => parseDataManifest(`${"b".repeat(64)}  ../x\n`), /not normalized/);
  assert.throws(() => parseDataManifest("garbage line\n"), /unparseable/);
});

// ---------------------------------------------------------------------------
// full verification
// ---------------------------------------------------------------------------

test("normal path: every file re-hashed, digest over the canonical listing, signature recorded", async (t) => {
  const ds = makeDataset(t);
  const binding = await verifyDatasetBinding(ds.spec, ds.config);
  assert.equal(binding.dataVerification, "full");
  assert.equal(binding.dataDigest, computeDataDigest(ds.listing));
  assert.equal(binding.fileCount, 3);
  assert.deepEqual(Object.keys(binding.signature.files).sort(), Object.keys(FILES).sort());
  assert.deepEqual(binding.ignoredExtraFiles, []);
  assert.equal((await recheckDatasetBinding(binding)).unchanged, true);
  // Canonical: order of the manifest does not matter, content does.
  assert.equal(computeDataDigest([...ds.listing].reverse()), binding.dataDigest);
  assert.notEqual(computeDataDigest(ds.listing.map((f, i) => (i ? f : { ...f, size: f.size + 1 }))), binding.dataDigest);
});

test("modified file (same size, manifest unchanged) → refused", async (t) => {
  const ds = makeDataset(t);
  writeFileSync(join(ds.dataPath, "sub/b.bin"), "BRAVO-bytes");
  await assert.rejects(verifyDatasetBinding(ds.spec, ds.config), /modified \(sha256 differs\): sub\/b\.bin/);
  writeFileSync(join(ds.dataPath, "sub/b.bin"), "bravo-bytes-longer");
  await assert.rejects(verifyDatasetBinding(ds.spec, ds.config), /modified \(size/);
});

test("added file: extraFiles=reject refuses, extraFiles=ignore records it", async (t) => {
  const ds = makeDataset(t);
  writeFileSync(join(ds.dataPath, "sub/extra.bin"), "smuggled");
  await assert.rejects(verifyDatasetBinding(ds.spec, ds.config), /not in manifest: sub\/extra\.bin/);
  const binding = await verifyDatasetBinding(ds.spec, { ...ds.config, extraFiles: "ignore" });
  assert.deepEqual(binding.ignoredExtraFiles, [{ path: "sub/extra.bin", size: 8, sha256: sha256("smuggled") }]);
  assert.equal(binding.dataDigest, computeDataDigest(ds.listing), "ignored files are not part of the digest");
  assert.ok(!("sub/extra.bin" in binding.signature.files));
});

test("deleted file → refused", async (t) => {
  const ds = makeDataset(t);
  rmSync(join(ds.dataPath, "sub/deep/c.bin"));
  await assert.rejects(verifyDatasetBinding(ds.spec, ds.config), /missing: sub\/deep\/c\.bin/);
});

test("file replaced by a symlink to outside dataPath → refused (never followed)", async (t) => {
  const ds = makeDataset(t);
  const outside = join(ds.root, "outside.bin");
  writeFileSync(outside, "alpha-bytes"); // same bytes: content equality is not enough
  rmSync(join(ds.dataPath, "a.bin"));
  symlinkSync(outside, join(ds.dataPath, "a.bin"));
  await assert.rejects(verifyDatasetBinding(ds.spec, ds.config), /symlink: a\.bin/);
});

test("directory symlink → refused", async (t) => {
  const ds = makeDataset(t);
  const elsewhere = join(ds.root, "elsewhere");
  mkdirSync(join(elsewhere, "deep"), { recursive: true });
  writeFileSync(join(elsewhere, "b.bin"), "bravo-bytes");
  writeFileSync(join(elsewhere, "deep", "c.bin"), "charlie");
  rmSync(join(ds.dataPath, "sub"), { recursive: true });
  symlinkSync(elsewhere, join(ds.dataPath, "sub"));
  await assert.rejects(verifyDatasetBinding(ds.spec, ds.config), /symlink: sub(?!\/)/);
});

test("special file (socket) inside dataPath → refused", async (t) => {
  const ds = makeDataset(t);
  const server = createServer();
  await new Promise((resolve) => server.listen(join(ds.dataPath, "s.sock"), resolve));
  t.after(() => server.close());
  await assert.rejects(verifyDatasetBinding(ds.spec, ds.config), /special file: s\.sock/);
});

test("dataPath given through a symlink: the real path is verified and returned for the mount", async (t) => {
  const ds = makeDataset(t);
  const link = join(ds.root, "current");
  symlinkSync(ds.dataPath, link);
  const binding = await verifyDatasetBinding(ds.spec, { ...ds.config, dataPath: link });
  assert.ok(!binding.dataPath.endsWith("/current"));
  assert.equal(statSync(binding.dataPath).ino, statSync(ds.dataPath).ino);
});

test("sha256sum manifests are verified the same way", async (t) => {
  const ds = makeDataset(t);
  const text = ds.listing.map((file) => `${file.sha256}  ./${file.path}`).join("\n") + "\n";
  writeFileSync(ds.manifestPath, text);
  const spec = { dataset: { ...ds.spec.dataset, manifestSha256: sha256(text) } };
  const binding = await verifyDatasetBinding(spec, ds.config);
  assert.equal(binding.manifestFormat, "sha256sum");
  assert.equal(binding.dataDigest, computeDataDigest(ds.listing), "sizes measured on disk");
  writeFileSync(join(ds.dataPath, "a.bin"), "ALPHA-bytes");
  await assert.rejects(verifyDatasetBinding(spec, ds.config), /modified/);
});

// ---------------------------------------------------------------------------
// time of use: post-run re-check
// ---------------------------------------------------------------------------

test("post-run re-check: swap, in-place write, appearance and removal are detected", async (t) => {
  const ds = makeDataset(t);
  const binding = await verifyDatasetBinding(ds.spec, ds.config);
  // Swap: same bytes, new inode (rename over).
  writeFileSync(join(ds.root, "tmp.bin"), "alpha-bytes");
  renameSync(join(ds.root, "tmp.bin"), join(ds.dataPath, "a.bin"));
  let check = await recheckDatasetBinding(binding);
  assert.equal(check.unchanged, false);
  assert.match(check.reason, /changed \([^)]*ino[^)]*\): a\.bin/);

  const ds2 = makeDataset(t);
  const binding2 = await verifyDatasetBinding(ds2.spec, { ...ds2.config, extraFiles: "ignore" });
  writeFileSync(join(ds2.dataPath, "new.bin"), "x");
  check = await recheckDatasetBinding(binding2);
  assert.equal(check.unchanged, true, "ignore policy: new extras are recorded, not failures");
  assert.deepEqual(check.newlyIgnored, ["new.bin"]);
  check = await recheckDatasetBinding({ ...binding2, extraFiles: "reject" });
  assert.match(check.reason, /appeared: new\.bin/);
  appendFileSync(join(ds2.dataPath, "sub/b.bin"), "!");
  rmSync(join(ds2.dataPath, "sub/deep"), { recursive: true });
  check = await recheckDatasetBinding(binding2);
  assert.match(check.reason, /changed \(size.*\): sub\/b\.bin/);
  assert.match(check.reason, /removed: sub\/deep\/c\.bin/);
  assert.match(check.reason, /directory removed or replaced: sub\/deep/);
});

// ---------------------------------------------------------------------------
// sealed snapshot
// ---------------------------------------------------------------------------

test("sealed snapshot passes without re-hashing and yields the same digest as full verification", async (t) => {
  const s = await sealed(t);
  const binding = await verifyDatasetBinding(s.spec, s.config);
  assert.equal(binding.dataVerification, "sealed_snapshot");
  assert.equal(binding.dataDigest, s.summary.dataDigest);
  const full = await verifyDatasetBinding(s.spec, { ...s.config, snapshot: null });
  assert.equal(full.dataDigest, binding.dataDigest);
  assert.equal((await recheckDatasetBinding(binding)).unchanged, true);
});

test("sealed snapshot with a changed mtime, size or inode → refused", async (t) => {
  const s = await sealed(t);
  const target = join(s.dataPath, "sub/b.bin");
  const original = statSync(target);
  utimesSync(target, original.atime, new Date(original.mtimeMs + 5000));
  await assert.rejects(verifyDatasetBinding(s.spec, s.config), /mtime\/ctime changed since sealed: sub\/b\.bin/);

  const s2 = await sealed(t);
  const target2 = join(s2.dataPath, "a.bin");
  const before = statSync(target2);
  appendFileSync(target2, "more");
  utimesSync(target2, before.atime, before.mtime); // mtime forged back; size still differs
  await assert.rejects(verifyDatasetBinding(s2.spec, s2.config), /size changed since sealed: a\.bin/);

  const s3 = await sealed(t);
  // Same-size content change with mtime forged back: ctime still betrays it.
  const target3 = join(s3.dataPath, "a.bin");
  const before3 = statSync(target3);
  writeFileSync(target3, "ALPHA-BYTES");
  utimesSync(target3, before3.atime, before3.mtime);
  await assert.rejects(verifyDatasetBinding(s3.spec, s3.config), /mtime\/ctime changed since sealed: a\.bin/);

  const s4 = await sealed(t);
  writeFileSync(join(s4.root, "x.tmp"), "charlie");
  renameSync(join(s4.root, "x.tmp"), join(s4.dataPath, "sub/deep/c.bin"));
  await assert.rejects(verifyDatasetBinding(s4.spec, s4.config), /since sealed.*sub\/deep\/c\.bin/);
});

test("sealed snapshot: seal integrity (other manifest, writable seal, extra files, symlinks)", async (t) => {
  const s = await sealed(t);
  chmodSync(s.summary.sealPath, 0o666);
  await assert.rejects(verifyDatasetBinding(s.spec, s.config), /writable by group\/other/);
  chmodSync(s.summary.sealPath, 0o444);

  const other = await sealed(t); // same manifest bytes, another directory
  await assert.rejects(verifyDatasetBinding(s.spec, { ...s.config, snapshot: other.config.snapshot }), /seal covers .*, not /);
  const forged = join(s.root, "forged.seal.json");
  writeFileSync(forged, JSON.stringify({ ...JSON.parse(readFileSync(s.summary.sealPath, "utf8")), manifestSha256: "0".repeat(64) }), { mode: 0o444 });
  await assert.rejects(verifyDatasetBinding(s.spec, { ...s.config, snapshot: { sealPath: forged } }), /different manifest/);

  writeFileSync(join(s.dataPath, "extra.bin"), "x");
  await assert.rejects(verifyDatasetBinding(s.spec, s.config), /not in manifest: extra\.bin/);
  const binding = await verifyDatasetBinding(s.spec, { ...s.config, extraFiles: "ignore" });
  assert.deepEqual(binding.ignoredExtraFiles, [{ path: "extra.bin", size: 1 }]);
  rmSync(join(s.dataPath, "extra.bin"));

  symlinkSync("/etc", join(s.dataPath, "etc"));
  await assert.rejects(verifyDatasetBinding(s.spec, s.config), /symlink: etc/);
});

test("seal-dataset refuses symlinks and outputs inside the dataset", async (t) => {
  const root = tempRoot(t);
  const dataPath = join(root, "d");
  mkdirSync(dataPath);
  writeFileSync(join(dataPath, "a"), "a");
  await assert.rejects(sealDataset({ dataPath, manifestPath: join(dataPath, "m.json") }), /inside the dataset/);
  symlinkSync("/etc/hosts", join(dataPath, "link"));
  await assert.rejects(sealDataset({ dataPath }), /symlink: link/);
});

// ---------------------------------------------------------------------------
// runner integration (fake platform, local scheduler, apptainer shim)
// ---------------------------------------------------------------------------

const RUNNER_TOKEN = "lrt_test_runner_token_0123456789abcdef";

async function runnerEnv(t) {
  const root = tempRoot(t);
  const platform = await startFakePlatform({ token: RUNNER_TOKEN });
  t.after(() => platform.close());
  const repo = createRepo(root);
  const dataset = createDataset(root);
  const shim = installShim(root);
  const config = makeConfig({ root, platformUrl: platform.url, dataset, shimPath: shim.path, gitReadFallback: { url: repo.repo } });
  const { logger, lines } = captureLogger(createLogger);
  return { root, platform, repo, dataset, shim, config, lines, newRunner: (hooks) => createRunner({ config, token: RUNNER_TOKEN, logger, hooks }) };
}

test("runner: a modified dataset file fails the run before submission", async (t) => {
  const env = await runnerEnv(t);
  writeFileSync(join(env.dataset.dataPath, "a-sample.json"), JSON.stringify({ tampered: true }));
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }) });
  env.platform.enqueue(work);
  const state = await env.newRunner({ afterSubmit: () => { throw new Error("must not submit"); } }).runOnce();
  assert.equal(state.outcome, "failed");
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.match(complete.failureReason, /data binding failed: dataset bytes do not match the manifest: .*a-sample\.json/);
  assert.equal(complete.manifest, null);
  assert.equal(env.shim.calls().length, 0, "container never started");
});

test("runner: input swapped during the run → detected after the job ends, run failed with manifest + reason", async (t) => {
  const env = await runnerEnv(t);
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }) });
  env.platform.enqueue(work);
  const swap = () => {
    // Same bytes under a new inode: content looks equal, the file is not the verified one.
    const target = join(env.dataset.dataPath, "b-sample.json");
    const temp = join(env.root, "swap.tmp");
    writeFileSync(temp, JSON.stringify({ swapped: true }));
    renameSync(temp, target);
  };
  const state = await env.newRunner({ afterSubmit: swap }).runOnce();
  assert.equal(state.outcome, "failed", env.lines.join("\n"));
  assert.equal(state.dataRecheck.unchanged, false);
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.outcome, "failed");
  assert.match(complete.failureReason, /input data changed during the run \(full verification at .*\): .*b-sample\.json/);
  assert.ok(complete.failureReason.length <= 1000);
  assert.ok(complete.manifest, "the job ran: evidence is still reported");
  assert.equal(complete.manifest.inputs.dataVerification, "full");
  assert.equal(complete.manifest.inputs.dataDigest, computeDataDigest(env.dataset.files), "digest of what was verified before submit");
});

test("runner: sealed snapshot dataset completes with dataVerification=sealed_snapshot", async (t) => {
  const env = await runnerEnv(t);
  // Re-ingest the fixture dataset with the seal tool and point the config at it.
  const summary = await sealDataset({ dataPath: env.dataset.dataPath, manifestPath: join(env.root, "sealed.manifest.json"), sealPath: join(env.root, "sealed.seal.json") });
  env.config.datasets.ds_1 = { ...env.config.datasets.ds_1, manifestPath: summary.manifestPath, snapshot: { sealPath: summary.sealPath } };
  const spec = makeSpec({ sha: env.repo.sha, dataset: { manifestSha256: summary.manifestSha256 } });
  const work = makeWork({ spec });
  env.platform.enqueue(work);
  const state = await env.newRunner().runOnce();
  assert.equal(state.outcome, "completed", env.lines.join("\n"));
  assert.equal(state.dataRecheck.unchanged, true);
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.manifest.inputs.dataVerification, "sealed_snapshot");
  assert.equal(complete.manifest.inputs.dataDigest, summary.dataDigest);
  assert.equal(complete.manifest.inputs.dataDigest, computeDataDigest(env.dataset.files));
});
