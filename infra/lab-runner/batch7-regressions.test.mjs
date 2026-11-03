// Batch 7 (H8) independent regression tests for R02, R03 and R05, written from
// the external assessment's finding descriptions only
// (docs/第二次评估_采纳与第7批_2026-11-03.md, section 三). They assert outcomes,
// not implementation details, so either fix strategy passes.
// Simulation only: fake platform, injected fake scheduler, temp directories.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { evaluateEgress } from "./egress.mjs";
import { verifyDatasetBinding } from "./lib/dataset.mjs";
import { createLogger } from "./lib/log.mjs";
import { createRunner } from "./runner.mjs";
import { startFakePlatform } from "./test-support/fake-platform.mjs";
import {
  captureLogger, createDataset, createRepo, installShim, makeConfig, makeSpec, makeWork, PROTOCOL_SHA, sha256, tempRoot,
} from "./test-support/fixtures.mjs";

// ---------------------------------------------------------------------------
// Tunables (override with env vars).
// ---------------------------------------------------------------------------
/** R05: findByTag answers "no such job" this many times after the lost submit. */
const R05_HIDDEN_FIND_CALLS = Number(process.env.B7_R05_HIDDEN_FIND_CALLS ?? 3);
/** R05: per-runOnce bound; a runner that waits for visibility must give up or converge within it. */
const R05_RUN_TIMEOUT_MS = Number(process.env.B7_R05_RUN_TIMEOUT_MS ?? 8000);

const RUNNER_TOKEN = "lrt_test_runner_token_0123456789abcdef";

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// R02: binding must cover the actual bytes under dataPath, not just the manifest
// ---------------------------------------------------------------------------

/** Dataset with a sha256sum-format manifest (supported before and after the fix). */
function sha256sumDataset(t) {
  const root = tempRoot(t);
  const dataPath = join(root, "dataset");
  mkdirSync(join(dataPath, "sub"), { recursive: true });
  const files = {};
  for (const name of ["train.csv", "val.csv", "sub/labels.json"]) {
    const content = `${name}:${randomBytes(16).toString("hex")}\n`;
    writeFileSync(join(dataPath, name), content);
    files[name] = content;
  }
  const manifest = `${Object.entries(files).map(([name, content]) => `${sha256(content)}  ${name}`).join("\n")}\n`;
  const manifestPath = join(root, "SHA256SUMS");
  writeFileSync(manifestPath, manifest);
  const dataset = { dataPath, manifestPath, manifestSha256: sha256(manifest) };
  const config = makeConfig({ root, platformUrl: "http://127.0.0.1:9", dataset, shimPath: join(root, "bin", "apptainer") });
  const spec = makeSpec({ sha: "0".repeat(40), dataset });
  return { root, dataPath, files, spec, datasetConfig: config.datasets.ds_1 };
}

test("R02 sanity: an untouched dataset with a sha256sum manifest binds", async (t) => {
  const { spec, datasetConfig } = sha256sumDataset(t);
  await verifyDatasetBinding(spec, datasetConfig);
});

test("R02: a data file listed in the manifest is modified (manifest unchanged) → refused", async (t) => {
  const { dataPath, spec, datasetConfig } = sha256sumDataset(t);
  writeFileSync(join(dataPath, "train.csv"), "tampered,bytes\n");
  await assert.rejects(verifyDatasetBinding(spec, datasetConfig));
});

test("R02: a data file listed in the manifest is deleted → refused", async (t) => {
  const { dataPath, spec, datasetConfig } = sha256sumDataset(t);
  rmSync(join(dataPath, "sub", "labels.json"));
  await assert.rejects(verifyDatasetBinding(spec, datasetConfig));
});

test("R02: a listed data file replaced by a symlink (even to identical bytes outside dataPath) → refused", async (t) => {
  const { root, dataPath, spec, datasetConfig } = sha256sumDataset(t);
  const outside = join(root, "outside-val.csv");
  copyFileSync(join(dataPath, "val.csv"), outside);
  rmSync(join(dataPath, "val.csv"));
  symlinkSync(outside, join(dataPath, "val.csv"));
  await assert.rejects(verifyDatasetBinding(spec, datasetConfig));
});

// ---------------------------------------------------------------------------
// R03: by default only a valid metrics.json leaves the lab automatically
// ---------------------------------------------------------------------------

const DEFAULT_POLICY = {
  schema: "tanyan.egress/v1",
  allowedExtensions: [".json", ".csv", ".log", ".txt"],
  maxFileBytes: 1_000_000,
  maxTotalBytes: 5_000_000,
  allowImages: false,
  blockDatasetHashMatches: true,
};

/** out/ with a valid metrics.json plus one dataset file whose hash is "known". */
function egressFixture(t) {
  const root = tempRoot(t);
  const out = join(root, "out");
  mkdirSync(out);
  const datasetBytes = Buffer.from(Array.from({ length: 64 }, (_, index) => `row${index},${randomBytes(6).toString("hex")}`).join("\n"));
  writeFileSync(join(out, "metrics.json"), JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: PROTOCOL_SHA, split: "val", values: { accuracy: 0.91, loss: 0.25 } }));
  return { out, datasetBytes, datasetHashes: new Set([sha256(datasetBytes)]) };
}

async function gate(out, datasetHashes) {
  // `evaluationProtocolSha256` is an extra, possibly ignored hint in case the
  // fixed gate validates metrics.json against the approved protocol.
  const result = await evaluateEgress({ outDir: out, policy: DEFAULT_POLICY, datasetHashes, locatorPrefix: "lab://r/run_b7/out", evaluationProtocolSha256: PROTOCOL_SHA });
  return { ...result, byPath: Object.fromEntries(result.artifacts.map((artifact) => [artifact.relativePath, artifact])) };
}

function assertNotPublished(result, relativePath) {
  const artifact = result.byPath[relativePath];
  assert.ok(artifact, `${relativePath} is listed in the manifest`);
  assert.notEqual(artifact.egressDecision, "published", `${relativePath} must not be auto-published (reason given: ${artifact.egressReason})`);
  assert.ok(!result.published.some((file) => file.relativePath === relativePath), `${relativePath} must not be in the upload list`);
}

function assertMetricsPublished(result) {
  assert.equal(result.byPath["metrics.json"]?.egressDecision, "published", "a valid tanyan.metrics/v1 metrics.json is published");
  assert.ok(result.published.some((file) => file.relativePath === "metrics.json"));
}

test("R03 sanity: a valid metrics.json alone is published", async (t) => {
  const { out, datasetHashes } = egressFixture(t);
  const result = await gate(out, datasetHashes);
  assertMetricsPublished(result);
});

test("R03: base64-encoded dataset copy in out/encoded-copy.json is not published", async (t) => {
  const { out, datasetBytes, datasetHashes } = egressFixture(t);
  writeFileSync(join(out, "encoded-copy.json"), JSON.stringify({ blob: datasetBytes.toString("base64") }));
  const result = await gate(out, datasetHashes);
  assertNotPublished(result, "encoded-copy.json");
  assertMetricsPublished(result);
});

test("R03: dataset copy split across two .csv files is not published", async (t) => {
  const { out, datasetBytes, datasetHashes } = egressFixture(t);
  const half = Math.floor(datasetBytes.length / 2);
  mkdirSync(join(out, "tables"));
  writeFileSync(join(out, "tables", "part-1.csv"), datasetBytes.subarray(0, half));
  writeFileSync(join(out, "tables", "part-2.csv"), datasetBytes.subarray(half));
  const result = await gate(out, datasetHashes);
  assertNotPublished(result, "tables/part-1.csv");
  assertNotPublished(result, "tables/part-2.csv");
  assertMetricsPublished(result);
});

test("R03: dataset copy mixed into logs/train.log is not published", async (t) => {
  const { out, datasetBytes, datasetHashes } = egressFixture(t);
  mkdirSync(join(out, "logs"));
  writeFileSync(join(out, "logs", "train.log"), `epoch 1 loss 0.9\n${datasetBytes.toString("utf8")}\nepoch 2 loss 0.5\n`);
  const result = await gate(out, datasetHashes);
  assertNotPublished(result, "logs/train.log");
  assertMetricsPublished(result);
});

test("R03: a binary .bin renamed to .json is not published", async (t) => {
  const { out, datasetHashes } = egressFixture(t);
  writeFileSync(join(out, "weights.json"), Buffer.concat([Buffer.from([0x00, 0xff, 0x13, 0x37]), randomBytes(512)]));
  const result = await gate(out, datasetHashes);
  assertNotPublished(result, "weights.json");
  assertMetricsPublished(result);
});

test("R03: with all vectors present, metrics.json is the only published file", async (t) => {
  const { out, datasetBytes, datasetHashes } = egressFixture(t);
  const half = Math.floor(datasetBytes.length / 2);
  writeFileSync(join(out, "encoded-copy.json"), JSON.stringify({ blob: datasetBytes.toString("base64") }));
  writeFileSync(join(out, "part-1.csv"), datasetBytes.subarray(0, half));
  writeFileSync(join(out, "part-2.csv"), datasetBytes.subarray(half));
  mkdirSync(join(out, "logs"));
  writeFileSync(join(out, "logs", "train.log"), `step 1\n${datasetBytes.toString("utf8")}\n`);
  writeFileSync(join(out, "model.json"), randomBytes(256));
  const result = await gate(out, datasetHashes);
  assert.deepEqual(result.published.map((file) => file.relativePath), ["metrics.json"]);
  assert.deepEqual(result.artifacts.filter((artifact) => artifact.egressDecision === "published").map((artifact) => artifact.relativePath), ["metrics.json"]);
});

// ---------------------------------------------------------------------------
// R05: unknown submit outcome → reconcile only, never a second job
// ---------------------------------------------------------------------------

/**
 * Scheduler whose first submit is accepted but the response is lost (throws),
 * and whose findByTag hides the job for the next `hiddenCalls` calls.
 * Every accepted job is recorded; that list is the ground truth.
 */
function lossyScheduler({ hiddenCalls }) {
  const accepted = [];
  let submits = 0;
  let hiddenLeft = 0;
  return {
    kind: "fake-lossy",
    accepted,
    get submitCalls() { return submits; },
    async submit(job, submitTag) {
      submits += 1;
      const jobId = `fake-${accepted.length + 1}`;
      accepted.push({ jobId, submitTag });
      if (submits === 1) {
        hiddenLeft = hiddenCalls;
        throw new Error("submit response lost (socket timed out)");
      }
      return { jobId };
    },
    async findByTag(submitTag) {
      if (hiddenLeft > 0) {
        hiddenLeft -= 1;
        return [];
      }
      return accepted.filter((job) => job.submitTag === submitTag).map((job) => ({ jobId: job.jobId, state: "finished", exitCode: 0, reason: null }));
    },
    async query(jobId) {
      return accepted.some((job) => job.jobId === jobId) ? { state: "finished", exitCode: 0, reason: null } : { state: "unknown", exitCode: null, reason: "no such job" };
    },
    async cancel() {},
  };
}

const ATTENTION = /attention|manual|human|unknown|unconfirmed|ambiguous/i;

test("R05: lost submit response + delayed findByTag visibility never yields a second job (run + restart)", async (t) => {
  const root = tempRoot(t);
  const platform = await startFakePlatform({ token: RUNNER_TOKEN });
  t.after(() => platform.close());
  const repo = createRepo(root);
  const dataset = createDataset(root);
  const shim = installShim(root);
  const config = makeConfig({ root, platformUrl: platform.url, dataset, shimPath: shim.path, gitReadFallback: { url: repo.repo } });
  const { logger } = captureLogger(createLogger);
  const scheduler = lossyScheduler({ hiddenCalls: R05_HIDDEN_FIND_CALLS });
  const newRunner = () => createRunner({ config, token: RUNNER_TOKEN, logger, scheduler });

  const work = makeWork({ spec: makeSpec({ sha: repo.sha, dataset }) });
  const tagJobs = () => scheduler.accepted.filter((job) => job.submitTag === work.submitTag);

  // Run 1: the submit is accepted but its response is lost.
  platform.enqueue(work);
  const first = await withTimeout(newRunner().runOnce().catch((error) => ({ thrown: error })), R05_RUN_TIMEOUT_MS, "first run");
  assert.ok(tagJobs().length <= 1, `at most one job accepted during the first run (got ${tagJobs().length}: ${tagJobs().map((job) => job.jobId).join(", ")})`);

  // Restart with the same state dir: the platform hands the run back
  // (reconcile after lease expiry, then a duplicate execute claim).
  platform.enqueue({ ...work, mode: "reconcile", repository: null });
  const second = await withTimeout(newRunner().runOnce().catch((error) => ({ thrown: error })), R05_RUN_TIMEOUT_MS, "restarted run (reconcile)");
  assert.ok(tagJobs().length <= 1, `at most one job accepted after restart/reconcile (got ${tagJobs().length})`);
  platform.enqueue({ ...work, mode: "execute" });
  const third = await withTimeout(newRunner().runOnce().catch((error) => ({ thrown: error })), R05_RUN_TIMEOUT_MS, "restarted run (execute)");
  assert.ok(tagJobs().length <= 1, `at most one job accepted after a duplicate execute claim (got ${tagJobs().length})`);

  // Convergence: adopted the single job, or an explicit failure/attention state.
  const states = [first, second, third];
  const [onlyJob] = tagJobs();
  const adopted = Boolean(onlyJob) && states.some((state) => state?.schedulerJobId === onlyJob.jobId);
  const explicit = states.some((state) => state?.outcome === "failed" || ATTENTION.test(JSON.stringify({ ...state, work: undefined })))
    || platform.requestsFor(work.runId, "complete").some((request) => request.outcome === "failed");
  assert.ok(adopted || explicit, `run must end adopted (one job) or in an explicit failure/attention state; states: ${JSON.stringify(states.map((state) => ({ outcome: state?.outcome, schedulerJobId: state?.schedulerJobId })))}`);
  for (const state of states) {
    if (state?.schedulerJobId) assert.equal(state.schedulerJobId, onlyJob?.jobId, "a recorded job id must be the single accepted job");
  }
});
