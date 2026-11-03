// Unit tests: container command, Slurm adapter parsing, dataset binding, config, logger.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildContainerCommand, paramArgs, resolveImage, seedsFromParams } from "./lib/container.mjs";
import { validateConfig } from "./lib/config.mjs";
import { DataBindingError, loadDatasetFileHashes, verifyDatasetBinding } from "./lib/dataset.mjs";
import { createLogger } from "./lib/log.mjs";
import { mapSlurmState } from "./schedulers/slurm.mjs";
import { IMAGE_REF, makeSpec, sha256, tempRoot } from "./test-support/fixtures.mjs";

const DATASET = { manifestSha256: "d".repeat(64) };

test("params: sorted --key=value, typed values, invalid keys refused", () => {
  assert.deepEqual(paramArgs({ lr: 0.001, b: true, a: "x y", z: false }), ["--a=x y", "--b=true", "--lr=0.001", "--z=false"]);
  assert.throws(() => paramArgs({ "--evil": 1 }), /invalid parameter key/);
  assert.throws(() => paramArgs({ "a b": 1 }), /invalid parameter key/);
  assert.throws(() => paramArgs({ a: Number.NaN }), /invalid parameter value/);
  assert.deepEqual(seedsFromParams({ seed: 3, seed_eval: 9, seedling: 4, other: 1, seed_x: 1.5 }), [3, 9]);
});

test("container command: isolation, read-only binds, GPU flag, memory opt-in", () => {
  const spec = makeSpec({ sha: "1".repeat(40), dataset: DATASET, params: { epochs: 2 }, resources: { gpuCount: 1, walltimeMinutes: 10, memoryGb: 8 } });
  const apptainer = { binary: "/usr/bin/apptainer", images: { [IMAGE_REF]: "/images/train.sif" } };
  const { argv, env } = buildContainerCommand({ spec, runId: "run_1", srcDir: "/w/run_1/src", dataPath: "/data/ds1", outDir: "/w/run_1/out", apptainer });
  assert.deepEqual(argv.slice(0, 8), ["/usr/bin/apptainer", "exec", "--containall", "--cleanenv", "--no-home", "--net", "--network", "none"]);
  assert.ok(argv.includes("--nv"));
  assert.ok(!argv.includes("--memory"));
  assert.ok(argv.includes("/w/run_1/src:/src:ro"));
  assert.ok(argv.includes("/data/ds1:/data:ro"));
  assert.ok(argv.includes("/w/run_1/out:/out:rw"));
  const imageIndex = argv.indexOf("/images/train.sif");
  assert.deepEqual(argv.slice(imageIndex + 1), [...spec.entrypoint.argv, "--epochs=2"]);
  assert.equal(env.APPTAINERENV_TANYAN_DATA_DIR, "/data");
  const withMemory = buildContainerCommand({ spec, runId: "r", srcDir: "/s", dataPath: "/d", outDir: "/o", apptainer: { ...apptainer, applyMemoryLimit: true, isolationFlags: ["--containall"] } });
  assert.deepEqual(withMemory.argv.slice(2, 6), ["--containall", "--nv", "--memory", "8G"]);
});

test("container command refuses ambiguous bind paths, unpinned images, network != deny", () => {
  const spec = makeSpec({ sha: "1".repeat(40), dataset: DATASET });
  const apptainer = { images: { [IMAGE_REF]: "/i.sif" } };
  assert.throws(() => buildContainerCommand({ spec, runId: "r", srcDir: "/s", dataPath: "/d:/etc", outDir: "/o", apptainer }), /must not contain/);
  assert.throws(() => buildContainerCommand({ spec, runId: "r", srcDir: "relative", dataPath: "/d", outDir: "/o", apptainer }), /absolute/);
  assert.throws(() => buildContainerCommand({ spec: { ...spec, network: "allow" }, runId: "r", srcDir: "/s", dataPath: "/d", outDir: "/o", apptainer }), /network/);
  assert.throws(() => resolveImage("registry/x:latest", apptainer), /pinned/);
  assert.throws(() => resolveImage(`registry/y@sha256:${"b".repeat(64)}`, apptainer), /not provisioned/);
  assert.equal(resolveImage(`registry/y@sha256:${"b".repeat(64)}`, { allowPullByDigest: true }), `docker://registry/y@sha256:${"b".repeat(64)}`);
});

test("Slurm state mapping", () => {
  assert.equal(mapSlurmState("PENDING").state, "pending");
  assert.equal(mapSlurmState("RUNNING").state, "running");
  assert.equal(mapSlurmState("COMPLETING").state, "running");
  assert.equal(mapSlurmState("COMPLETED").state, "finished");
  assert.equal(mapSlurmState("CANCELLED by 1000").state, "canceled");
  assert.equal(mapSlurmState("CANCELLED+").state, "canceled");
  assert.deepEqual(mapSlurmState("TIMEOUT"), { state: "failed", reason: "walltime exceeded (TIMEOUT)", timedOut: true });
  assert.equal(mapSlurmState("OUT_OF_MEMORY").reason, "OUT_OF_MEMORY");
  assert.equal(mapSlurmState("").state, "unknown");
});

test("dataset binding: manifest and split manifest hashes must match", async (t) => {
  const root = tempRoot(t);
  const manifestPath = join(root, "m.json");
  const splitPath = join(root, "s.json");
  writeFileSync(manifestPath, JSON.stringify({ files: [{ path: "a", sha256: "A".repeat(64) }, { nested: { sha256: "b".repeat(64) } }] }));
  writeFileSync(splitPath, "train: [a]\n");
  const manifestSha256 = sha256(JSON.stringify({ files: [{ path: "a", sha256: "A".repeat(64) }, { nested: { sha256: "b".repeat(64) } }] }));
  const spec = { dataset: { versionId: "ds", manifestSha256, splitManifestSha256: sha256("train: [a]\n"), mount: "read_only" } };
  await verifyDatasetBinding(spec, { manifestPath, splitManifestPath: splitPath });
  await assert.rejects(verifyDatasetBinding(spec, { manifestPath }), /split manifest/);
  await assert.rejects(verifyDatasetBinding({ dataset: { ...spec.dataset, splitManifestSha256: "0".repeat(64) } }, { manifestPath, splitManifestPath: splitPath }), /split manifest sha256 mismatch/);
  await assert.rejects(verifyDatasetBinding(spec, undefined), DataBindingError);
  assert.deepEqual([...(await loadDatasetFileHashes(manifestPath))].sort(), ["a".repeat(64), "b".repeat(64)]);
  const sums = join(root, "SHA256SUMS");
  writeFileSync(sums, `${"c".repeat(64)}  data/x.npy\n${"d".repeat(64)} *data/y.npy\n`);
  assert.deepEqual([...(await loadDatasetFileHashes(sums))].sort(), ["c".repeat(64), "d".repeat(64)]);
  writeFileSync(sums, "no hashes here\n");
  await assert.rejects(loadDatasetFileHashes(sums), /no per-file sha256/);
});

test("config: HTTPS required except localhost, token never in config", () => {
  const base = {
    platformUrl: "https://progress.example",
    runnerId: "rnr_1",
    workRoot: "/srv/lab-runner/work",
    scheduler: { type: "slurm" },
    datasets: [{ versionId: "ds_1", dataPath: "/data/ds1", manifestPath: "/data/ds1.manifest.json" }],
  };
  assert.equal(validateConfig(base).limits.heartbeatSeconds, 30);
  assert.throws(() => validateConfig({ ...base, platformUrl: "http://progress.example" }), /HTTPS/);
  assert.equal(validateConfig({ ...base, platformUrl: "http://127.0.0.1:8787" }).platformUrl, "http://127.0.0.1:8787/");
  assert.throws(() => validateConfig({ ...base, token: "x" }), /never in the config/);
  assert.throws(() => validateConfig({ ...base, workRoot: "work" }), /absolute/);
  assert.throws(() => validateConfig({ ...base, scheduler: { type: "k8s" } }), /scheduler.type/);
});

test("example config validates", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(new URL("./runner.config.example.json", import.meta.url), "utf8"));
  const config = validateConfig(raw);
  assert.equal(config.scheduler.type, "slurm");
});

test("logger redacts registered secrets", () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  logger.addSecret("ghs_secret_value");
  logger.info("fetch with ghs_secret_value", { header: "Bearer ghs_secret_value" });
  assert.ok(!lines[0].includes("ghs_secret_value"));
  assert.ok(lines[0].includes("[REDACTED]"));
});
