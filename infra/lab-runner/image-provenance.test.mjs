// Batch 7 (G02): SIF file hash and provenance. The runner hashes the SIF it
// will execute, refuses tampered / replaceable files, and records the file
// hash and source in the manifest. Simulation only: the apptainer shim stands
// in for Apptainer, and `apptainer verify` is a scripted fake.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createRunner } from "./runner.mjs";
import { buildManifest } from "./manifest.mjs";
import { ConfigError } from "./lib/config.mjs";
import { checkImageConfig, createImageHashCache, ImageProvenanceError, normalizeImageEntry, resolveImage, verifyImage } from "./lib/container.mjs";
import { createLogger } from "./lib/log.mjs";
import { startFakePlatform } from "./test-support/fake-platform.mjs";
import {
  captureLogger, createDataset, createRepo, IMAGE_REF, installShim, makeConfig, makeSpec, makeWork, sha256, tempRoot,
} from "./test-support/fixtures.mjs";

const RUNNER_TOKEN = "lrt_test_runner_token_0123456789abcdef";
const OCI_DIGEST = IMAGE_REF.slice(IMAGE_REF.indexOf("@") + 1);
const SOURCE = "apptainer build from lab/train.def@3f2a by admin wang (registry.example/lab/train)";
const SHIM_URL = pathToFileURL(fileURLToPath(new URL("./test-support/apptainer-shim.mjs", import.meta.url))).href;

/** A fake SIF: runner-owned temp file, so tests opt into allowRunnerWritable. */
function makeSif(root, name = "train.sif", content = `SIF-MAGIC ${"x".repeat(4096)} ${name}`) {
  const dir = join(root, "images");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o644 });
  chmodSync(path, 0o644);
  return { path, sha: sha256(content) };
}

const entryFor = (sif, extra = {}) => ({ ociDigest: OCI_DIGEST, sifPath: sif.path, sifSha256: sif.sha, source: SOURCE, allowRunnerWritable: true, ...extra });
const apptainerWith = (entry, extra = {}) => ({ binary: "apptainer", images: { [IMAGE_REF]: entry }, ...extra });

async function setup(t, { image, binary } = {}) {
  const root = tempRoot(t);
  const platform = await startFakePlatform({ token: RUNNER_TOKEN });
  t.after(() => platform.close());
  const repo = createRepo(root);
  const dataset = createDataset(root);
  const shim = installShim(root);
  const base = makeConfig({ root, platformUrl: platform.url, dataset, shimPath: shim.path, gitReadFallback: { url: repo.repo } });
  const sif = makeSif(root);
  const config = image === "legacy"
    ? base
    : { ...base, apptainer: { ...base.apptainer, binary: binary ?? base.apptainer.binary, images: { [IMAGE_REF]: { ...entryFor(sif), ...image } } } };
  const { logger, lines } = captureLogger(createLogger);
  const newRunner = () => createRunner({ config, token: RUNNER_TOKEN, logger });
  const runOne = async () => {
    const work = makeWork({ spec: makeSpec({ sha: repo.sha, dataset }) });
    platform.enqueue(work);
    const state = await newRunner().runOnce();
    const [complete] = platform.requestsFor(work.runId, "complete");
    return { state, complete };
  };
  return { root, platform, shim, sif, config, lines, runOne };
}

// ---------------------------------------------------------------------------
// end to end through the runner
// ---------------------------------------------------------------------------

test("matching SIF hash: run executes the verified file and the manifest carries imageFileSha256 + imageSource", async (t) => {
  const env = await setup(t);
  const { state, complete } = await env.runOne();
  assert.equal(state.outcome, "completed");
  assert.equal(complete.manifest.environment.imageDigest, OCI_DIGEST, "OCI digest still reported");
  assert.equal(complete.manifest.environment.imageFileSha256, env.sif.sha);
  assert.equal(complete.manifest.environment.imageSource, SOURCE);
  const [call] = env.shim.calls();
  assert.equal(call.image, realpathSync(env.sif.path), "apptainer runs the exact file that was hashed");
  assert.equal(state.image.sifSha256, env.sif.sha, "persisted so a later reconcile can still report it");
  assert.ok(!env.lines.some((line) => line.includes("provenance is unverified")));
});

test("tampered SIF (one byte changed) is refused before submit with a clear failure reason", async (t) => {
  const env = await setup(t);
  const bytes = readFileSync(env.sif.path);
  bytes[100] ^= 0x01;
  writeFileSync(env.sif.path, bytes);
  const { state, complete } = await env.runOne();
  assert.equal(state.outcome, "failed");
  assert.equal(complete.outcome, "failed");
  assert.match(complete.failureReason, /^image verification failed: SIF file hash mismatch/);
  assert.ok(complete.failureReason.includes(env.sif.sha), "reason names the expected hash");
  assert.equal(complete.manifest, null);
  assert.equal(env.shim.calls().length, 0, "nothing was submitted");
});

test("SIF replaced by a symlink is refused (even with allowRunnerWritable)", async (t) => {
  const env = await setup(t);
  const evil = makeSif(env.root, "evil.sif", "attacker image");
  renameSync(env.sif.path, `${env.sif.path}.orig`);
  symlinkSync(evil.path, env.sif.path);
  const { complete } = await env.runOne();
  assert.equal(complete.outcome, "failed");
  assert.match(complete.failureReason, /symlink to a writable location/);
  assert.equal(env.shim.calls().length, 0);
});

test("legacy config shape still works, with a startup warning that provenance is unverified", async (t) => {
  const env = await setup(t, { image: "legacy" });
  const { state, complete } = await env.runOne();
  assert.equal(state.outcome, "completed");
  assert.ok(env.lines.some((line) => line.includes(" warn ") && line.includes("image provenance is unverified")), "startup warning logged");
  assert.equal(complete.manifest.environment.imageDigest, OCI_DIGEST);
  assert.ok(!("imageFileSha256" in complete.manifest.environment), "no file hash is claimed for an unverified image");
  assert.ok(!("imageSource" in complete.manifest.environment));
});

test("malformed provenance entry is a startup ConfigError", async (t) => {
  const env = await setup(t, { image: { ociDigest: `sha256:${"9".repeat(64)}` } });
  assert.throws(() => createRunner({ config: env.config, token: RUNNER_TOKEN, logger: createLogger({ write() {} }) }), (error) => error instanceof ConfigError && /ociDigest must equal/.test(error.message));
});

test("verifySignature: apptainer verify runs and its failure refuses the run", async (t) => {
  const root = tempRoot(t);
  const marker = join(root, "signature-ok");
  const record = join(root, "verify-calls.log");
  const binary = join(root, "apptainer-verify-fake");
  writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "verify") {
  fs.appendFileSync(${JSON.stringify(record)}, process.argv[3] + "\\n");
  if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
  process.stderr.write("FATAL: no signatures found for system partition\\n");
  process.exit(255);
}
import(${JSON.stringify(SHIM_URL)}).then((m) => m.main(${JSON.stringify(join(root, "shim-calls.jsonl"))}));
`);
  chmodSync(binary, 0o755);
  const env = await setup(t, { image: { verifySignature: true }, binary });

  const failed = await env.runOne();
  assert.equal(failed.complete.outcome, "failed");
  assert.match(failed.complete.failureReason, /apptainer verify failed .*exit 255.*no signatures found/);
  assert.equal(readFileSync(record, "utf8").trim(), realpathSync(env.sif.path));

  writeFileSync(marker, "");
  const passed = await env.runOne();
  assert.equal(passed.complete.outcome, "completed");
  assert.equal(passed.complete.manifest.environment.imageFileSha256, env.sif.sha);
});

// ---------------------------------------------------------------------------
// verifyImage unit checks
// ---------------------------------------------------------------------------

test("world-writable SIF, or one in a world-writable directory, is refused", async (t) => {
  const root = tempRoot(t);
  const sif = makeSif(root);
  chmodSync(sif.path, 0o666);
  await assert.rejects(verifyImage(IMAGE_REF, apptainerWith(entryFor(sif))), (error) => error instanceof ImageProvenanceError && /group\/world-writable/.test(error.message));
  chmodSync(sif.path, 0o664);
  await assert.rejects(verifyImage(IMAGE_REF, apptainerWith(entryFor(sif))), /group\/world-writable/);
  chmodSync(sif.path, 0o644);
  const dir = join(root, "images");
  chmodSync(dir, 0o777);
  await assert.rejects(verifyImage(IMAGE_REF, apptainerWith(entryFor(sif))), /directory .* is group\/world-writable without the sticky bit/);
  chmodSync(dir, 0o755);
  assert.equal((await verifyImage(IMAGE_REF, apptainerWith(entryFor(sif)))).verified, true);
});

test("a SIF the runner user can write is refused unless allowRunnerWritable is set", async (t) => {
  const root = tempRoot(t);
  const sif = makeSif(root);
  await assert.rejects(verifyImage(IMAGE_REF, apptainerWith(entryFor(sif, { allowRunnerWritable: false }))), /writable by the runner user/);
  chmodSync(sif.path, 0o444);
  // The file is read-only now, but the runner still owns the directory and could swap it.
  await assert.rejects(verifyImage(IMAGE_REF, apptainerWith(entryFor(sif, { allowRunnerWritable: false }))), /directory .* writable by the runner user/);
  assert.equal((await verifyImage(IMAGE_REF, apptainerWith(entryFor(sif)))).verified, true);
});

test("missing SIF is refused", async (t) => {
  const root = tempRoot(t);
  const entry = { ...entryFor({ path: join(root, "absent.sif"), sha: "0".repeat(64) }) };
  await assert.rejects(verifyImage(IMAGE_REF, apptainerWith(entry)), /missing or unreadable/);
});

test("hash cache: a hit avoids the re-hash, a changed mtime forces one, an in-place edit with restored mtime is still caught", async (t) => {
  const root = tempRoot(t);
  const sif = makeSif(root);
  const cache = createImageHashCache();
  const apptainer = apptainerWith(entryFor(sif));

  const first = await verifyImage(IMAGE_REF, apptainer, { cache });
  assert.equal(first.cached, false);
  assert.equal(first.sifSha256, sif.sha);
  const second = await verifyImage(IMAGE_REF, apptainer, { cache });
  assert.equal(second.cached, true, "unchanged file: no re-hash");
  assert.equal(cache.size, 1);

  const later = new Date(Date.now() + 60_000);
  utimesSync(sif.path, later, later);
  const third = await verifyImage(IMAGE_REF, apptainer, { cache });
  assert.equal(third.cached, false, "mtime changed: re-hashed");
  assert.equal(third.sifSha256, sif.sha);

  // Same size, one byte flipped, mtime put back: ctime still changes, so the
  // cache misses and the mismatch is found.
  const { atime, mtime } = statSync(sif.path);
  const bytes = readFileSync(sif.path);
  bytes[10] ^= 0x01;
  writeFileSync(sif.path, bytes);
  utimesSync(sif.path, atime, mtime);
  await assert.rejects(verifyImage(IMAGE_REF, apptainer, { cache }), /SIF file hash mismatch/);
});

test("legacy entries and pull-by-digest are reported unverified; config validation", async () => {
  assert.deepEqual(await verifyImage(IMAGE_REF, { images: { [IMAGE_REF]: "/srv/images/train.sif" } }), { verified: false, path: "/srv/images/train.sif" });
  assert.deepEqual(await verifyImage(IMAGE_REF, { images: {}, allowPullByDigest: true }), { verified: false, path: `docker://${IMAGE_REF}` });
  await assert.rejects(verifyImage(IMAGE_REF, { images: {} }), (error) => error instanceof ImageProvenanceError && /not provisioned/.test(error.message));
  assert.equal(resolveImage(IMAGE_REF, apptainerWith(entryFor({ path: "/srv/a.sif", sha: "1".repeat(64) }))), "/srv/a.sif");

  const warnings = checkImageConfig({ images: { [IMAGE_REF]: "/srv/images/train.sif" } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /provenance is unverified/);
  assert.deepEqual(checkImageConfig(apptainerWith(entryFor({ path: "/srv/a.sif", sha: "1".repeat(64) }))), []);

  const good = entryFor({ path: "/srv/a.sif", sha: "1".repeat(64) });
  for (const [bad, pattern] of [
    [{ ...good, sifSha256: OCI_DIGEST }, /sifSha256/],
    [{ ...good, sifSha256: "A".repeat(64) }, /sifSha256/],
    [{ ...good, source: "" }, /source/],
    [{ ...good, source: "x".repeat(301) }, /source/],
    [{ ...good, sifPath: "relative.sif" }, /absolute/],
    [{ ...good, sifPath: "/srv/a:b.sif" }, /':'/],
    [{ ...good, verifySignature: "yes" }, /verifySignature/],
    [{ ...good, ociDigest: undefined }, /ociDigest/],
  ]) assert.throws(() => normalizeImageEntry(IMAGE_REF, bad), pattern);
  assert.throws(() => normalizeImageEntry("registry.example/lab/train:latest", good), /pinned/);
});

test("buildManifest copies imageFileSha256/imageSource only from a verified image", () => {
  const spec = { repository: { repositoryId: 1 }, executedCommitSha: "f".repeat(40), dataset: { versionId: "ds", manifestSha256: "a".repeat(64), splitManifestSha256: "" },
    evaluationProtocolSha256: "e".repeat(64), entrypoint: { id: "ep", imageRef: IMAGE_REF, params: {} } };
  const work = { runId: "run_1", attempt: 1, runSpecSha256: "c".repeat(64), approvalId: "apr", submitTag: "tag", spec };
  const base = { work, runnerId: "rnr", schedulerJobId: "1", environment: {}, status: { startedAt: "", exitCode: 0 }, artifacts: [], metricsArtifactPath: null };
  const verified = buildManifest({ ...base, image: { sifSha256: "d".repeat(64), source: SOURCE } }).environment;
  assert.deepEqual(verified, { imageDigest: OCI_DIGEST, driverVersion: "", gpuModel: "", imageFileSha256: "d".repeat(64), imageSource: SOURCE });
  assert.deepEqual(buildManifest({ ...base, image: { unverified: true } }).environment, { imageDigest: OCI_DIGEST, driverVersion: "", gpuModel: "" });
  assert.deepEqual(buildManifest(base).environment, { imageDigest: OCI_DIGEST, driverVersion: "", gpuModel: "" });
});

test("runner.config.example.json uses the provenance shape and passes the startup check without warnings", () => {
  const example = JSON.parse(readFileSync(fileURLToPath(new URL("./runner.config.example.json", import.meta.url)), "utf8"));
  assert.deepEqual(checkImageConfig(example.apptainer), []);
  for (const entry of Object.values(example.apptainer.images)) assert.equal(typeof entry, "object");
});
