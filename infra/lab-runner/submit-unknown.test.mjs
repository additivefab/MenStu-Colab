// R05: a submit whose outcome is unknown is reconciled by submitTag and never
// repeated. Simulation only: fake platform, fake Slurm, the local scheduler and
// in-test wrappers that lose responses or hide jobs (no real Slurm).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createRunner } from "./runner.mjs";
import { createLogger } from "./lib/log.mjs";
import { createScheduler } from "./schedulers/index.mjs";
import { createLocalScheduler } from "./schedulers/local.mjs";
import { classifySbatchFailure } from "./schedulers/slurm.mjs";
import { SUBMIT_RECEIPT, SubmitOutcomeUnknownError } from "./schedulers/submit-outcome.mjs";
import { installFakeSlurm, readFakeSlurm, setFakeSlurmControl } from "./test-support/fake-slurm.mjs";
import { startFakePlatform } from "./test-support/fake-platform.mjs";
import { captureLogger, createDataset, createRepo, installShim, makeConfig, makeSpec, makeWork, tempRoot, waitFor } from "./test-support/fixtures.mjs";

const RUNNER_TOKEN = "lrt_test_runner_token_0123456789abcdef";
const FAST = { submitVisibilitySeconds: 0.6, submitVisibilityPollSeconds: 0.05 };

async function setup(t, { scheduler, limits = FAST } = {}) {
  const root = tempRoot(t);
  const platform = await startFakePlatform({ token: RUNNER_TOKEN });
  t.after(() => platform.close());
  const repo = createRepo(root);
  const dataset = createDataset(root);
  const shim = installShim(root);
  const config = makeConfig({ root, platformUrl: platform.url, dataset, shimPath: shim.path, scheduler, gitReadFallback: { url: repo.repo }, limits });
  const { logger, lines } = captureLogger(createLogger);
  const newRunner = ({ hooks, scheduler: injected, config: override } = {}) => createRunner({ config: override ?? config, token: RUNNER_TOKEN, logger, hooks, scheduler: injected });
  const work = makeWork({ spec: makeSpec({ sha: repo.sha, dataset }) });
  return { root, platform, shim, config, lines, newRunner, work };
}

/**
 * Wraps a real adapter. loseResponse: submit reaches the scheduler, then throws
 * like a lost response. swallow: the submit is "accepted" somewhere invisible.
 * findByTag answers throw for the first `throwFirst` polls (a restarting
 * controller), then [] for `hideFirst` more (delayed visibility). Polls count
 * from the submit (from: "submit") or from the first call (from: "start", for a
 * restarted runner that never submits).
 */
function wrap(inner, { loseResponse = false, swallow = false, hideFirst = 0, throwFirst = 0, from = "submit" } = {}) {
  const calls = { submit: 0, findByTag: 0, polls: 0 };
  let counting = from === "start";
  return {
    kind: "wrapped",
    calls,
    async submit(job, tag) {
      calls.submit += 1;
      counting = true;
      calls.polls = 0;
      const result = swallow ? null : await inner.submit(job, tag);
      if (loseResponse || swallow) throw new Error("ETIMEDOUT: connection reset while reading the submit response");
      return result;
    },
    async findByTag(tag) {
      calls.findByTag += 1;
      if (counting) {
        calls.polls += 1;
        if (calls.polls <= throwFirst) throw new Error("slurm_load_jobs error: Unable to contact slurm controller (connect failure)");
        if (calls.polls <= throwFirst + hideFirst) return [];
      }
      return swallow ? [] : inner.findByTag(tag);
    },
    query: (jobId) => (swallow ? Promise.resolve({ state: "unknown", exitCode: null, reason: "job not found" }) : inner.query(jobId)),
    cancel: (jobId) => inner.cancel(jobId),
  };
}

const localRecords = (config) => {
  const dir = join(config.workRoot, ".local-scheduler");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
};

test("R05: response lost + delayed visibility (visible on the 3rd poll) → adopted, exactly one job", async (t) => {
  const env = await setup(t);
  env.platform.enqueue(env.work);
  const scheduler = wrap(createScheduler(env.config), { loseResponse: true, hideFirst: 2 });
  const state = await env.newRunner({ scheduler }).runOnce();
  assert.equal(state.outcome, "completed");
  assert.equal(state.submit, "adopted");
  assert.equal(scheduler.calls.submit, 1, "never resubmitted");
  assert.equal(scheduler.calls.polls, 3, "adopted on the third findByTag after the lost response");
  assert.equal(localRecords(env.config).length, 1, "one scheduler job");
  assert.equal(env.shim.calls().length, 1, "one container execution");
  assert.equal(env.platform.requestsFor(env.work.runId, "complete")[0].outcome, "completed");
});

test("R05: response lost + never visible → no second job, run failed SUBMIT_OUTCOME_UNKNOWN; a re-claim never submits", async (t) => {
  const env = await setup(t);
  env.platform.enqueue(env.work);
  const scheduler = wrap(createScheduler(env.config), { swallow: true });
  const started = Date.now();
  const state = await env.newRunner({ scheduler }).runOnce();
  assert.ok(Date.now() - started >= FAST.submitVisibilitySeconds * 1000 * 0.9, "waited for the visibility window");
  assert.equal(scheduler.calls.submit, 1);
  assert.ok(scheduler.calls.polls >= 3, "bounded polling happened");
  assert.equal(state.submit, "unknown_reported");
  assert.equal(state.submitAttempts, 1);
  assert.ok(state.submitStartedAt);
  const [complete] = env.platform.requestsFor(env.work.runId, "complete");
  assert.equal(complete.outcome, "failed");
  assert.match(complete.failureReason, /^SUBMIT_OUTCOME_UNKNOWN: /);
  assert.match(complete.failureReason, new RegExp(env.work.submitTag));
  assert.equal(complete.exitCode, null);
  assert.equal(complete.manifest, null);

  // A duplicate claim of the same run re-sends the decision and still never submits.
  env.platform.enqueue({ ...env.work });
  const again = await env.newRunner({ scheduler }).runOnce();
  assert.equal(again.operatorFailure.code, "SUBMIT_OUTCOME_UNKNOWN");
  assert.equal(scheduler.calls.submit, 1);
});

test("R05: scheduler restart (errors, then empty lists) after a lost response → no resubmit, adopted when it reappears", async (t) => {
  const env = await setup(t, { limits: { ...FAST, submitVisibilitySeconds: 3 } });
  env.platform.enqueue(env.work);
  const scheduler = wrap(createScheduler(env.config), { loseResponse: true, throwFirst: 2, hideFirst: 3 });
  const state = await env.newRunner({ scheduler }).runOnce();
  assert.equal(state.outcome, "completed");
  assert.equal(scheduler.calls.submit, 1);
  assert.equal(scheduler.calls.polls, 6);
  assert.equal(localRecords(env.config).length, 1);
  assert.ok(env.lines.some((line) => line.includes("findByTag failed while the submit outcome is unknown")));
});

test("R05: scheduler unreachable for the whole window → no resubmit, SUBMIT_OUTCOME_UNKNOWN", async (t) => {
  const env = await setup(t);
  env.platform.enqueue(env.work);
  const scheduler = wrap(createScheduler(env.config), { swallow: true, throwFirst: 1_000 });
  await env.newRunner({ scheduler }).runOnce();
  assert.equal(scheduler.calls.submit, 1);
  assert.match(env.platform.requestsFor(env.work.runId, "complete")[0].failureReason, /^SUBMIT_OUTCOME_UNKNOWN/);
});

test("R05 (Slurm fake): worker crash after the receipt, before the job id → restart reconciles, never reports absent, no duplicate", async (t) => {
  const root = tempRoot(t);
  const slurm = installFakeSlurm(root);
  setFakeSlurmControl(root, { sbatchLoseResponse: true });
  const env = await setup(t, { scheduler: { type: "slurm", slurm } });
  env.platform.enqueue(env.work);
  const crashed = await env.newRunner({ hooks: { afterSubmitError: () => { throw new Error("simulated crash before the job id was recorded"); } } }).runOnce();
  assert.equal(crashed.schedulerJobId, null);
  assert.equal(crashed.submit, "submitting");
  const runDir = join(env.config.workRoot, env.work.runId);
  const receipt = JSON.parse(readFileSync(join(runDir, SUBMIT_RECEIPT), "utf8"));
  assert.equal(receipt.submitTag, env.work.submitTag);
  assert.equal(receipt.jobId, null, "receipt exists without a job id");

  // The adapter itself refuses a second sbatch while that receipt exists.
  const adapter = createScheduler(env.config);
  await assert.rejects(adapter.submit({ runDir, jobScript: join(runDir, "job.mjs"), resources: env.work.spec.resources }, env.work.submitTag), SubmitOutcomeUnknownError);
  assert.equal(readFakeSlurm(root).calls.filter((call) => call.command === "sbatch").length, 1);

  // Restart in reconcile mode while Slurm still hides the job for two polls.
  env.platform.enqueue({ ...env.work, mode: "reconcile", repository: null });
  const scheduler = wrap(adapter, { hideFirst: 2, from: "start" });
  const second = await env.newRunner({ scheduler }).runOnce();
  assert.equal(second.outcome, "completed");
  const reconciles = env.platform.requestsFor(env.work.runId, "reconcile");
  assert.equal(reconciles.length, 1);
  assert.equal(reconciles[0].found, true, "an empty findByTag with a receipt is never reported as absent");
  assert.equal(reconciles[0].schedulerJobId, "1000");
  assert.equal(scheduler.calls.findByTag, 3);
  const { calls, state } = readFakeSlurm(root);
  assert.equal(calls.filter((call) => call.command === "sbatch").length, 1, "sbatch ran exactly once");
  assert.equal(state.jobs.length, 1);
  assert.equal(env.shim.calls().length, 1);
});

test("R05 reconcile: window over, nothing visible → platform fails the run SUBMIT_OUTCOME_UNKNOWN (no dispatch, no submit)", async (t) => {
  const env = await setup(t);
  env.platform.enqueue(env.work);
  const scheduler = wrap(createScheduler(env.config), { swallow: true });
  await env.newRunner({ scheduler, hooks: { afterSubmitError: () => { throw new Error("simulated crash"); } } }).runOnce();
  env.platform.enqueue({ ...env.work, mode: "reconcile", repository: null });
  const state = await env.newRunner({ scheduler }).runOnce();
  const [reconcile] = env.platform.requestsFor(env.work.runId, "reconcile");
  assert.deepEqual({ found: reconcile.found, submitOutcome: reconcile.submitOutcome }, { found: false, submitOutcome: "unknown" });
  assert.equal(env.platform.runs.get(env.work.runId).status, "failed");
  assert.equal(state.platformTerminal, "failed");
  assert.equal(state.submit, "unknown_reported");
  assert.match(state.failureReason, /^SUBMIT_OUTCOME_UNKNOWN/);
  assert.equal(scheduler.calls.submit, 1);
  assert.equal(env.platform.requestsFor(env.work.runId, "complete").length, 0, "complete is not allowed while reconciling");
});

test("R05 reconcile: lease budget spent before the window closes → run left reconciling, nothing reported; next claim adopts", async (t) => {
  const env = await setup(t, { limits: { ...FAST, submitVisibilitySeconds: 600 } });
  env.platform.enqueue(env.work);
  const inner = createScheduler(env.config);
  await env.newRunner({ hooks: { afterSubmit: () => { throw new Error("simulated crash"); } } }).runOnce();
  // Lease budget ≈ 0: requestTimeout close to the fake's 120 s lease.
  const tight = { ...env.config, limits: { ...env.config.limits, requestTimeoutSeconds: 120 } };
  env.platform.enqueue({ ...env.work, mode: "reconcile", repository: null });
  const hidden = wrap(inner, { hideFirst: 1_000, from: "start" });
  const left = await env.newRunner({ scheduler: hidden, config: tight }).runOnce();
  assert.equal(left.submit, "unknown");
  assert.equal(env.platform.requestsFor(env.work.runId, "reconcile").length, 0, "no reconcile: absence was never claimed");
  assert.equal(env.platform.runs.get(env.work.runId).status, "reconciling");

  env.platform.enqueue({ ...env.work, mode: "reconcile", repository: null });
  const adopted = await env.newRunner({ scheduler: inner }).runOnce();
  assert.equal(adopted.outcome, "completed");
  assert.equal(localRecords(env.config).length, 1);
  assert.equal(env.shim.calls().length, 1);
});

function fakeScheduler(jobs) {
  const calls = { submit: 0, cancel: [] };
  return {
    kind: "fake",
    calls,
    async submit() { calls.submit += 1; throw new Error("must not submit"); },
    async findByTag() { return jobs; },
    async query(jobId) { return jobs.find((job) => job.jobId === jobId) ?? { state: "unknown", exitCode: null, reason: null }; },
    async cancel(jobId) { calls.cancel.push(jobId); },
  };
}

test("R05: duplicate live jobs with one submitTag → all canceled, run failed DUPLICATE_JOBS, nothing collected (execute)", async (t) => {
  const env = await setup(t);
  env.platform.enqueue(env.work);
  const scheduler = fakeScheduler([
    { jobId: "1002", state: "running", exitCode: null, reason: null },
    { jobId: "990", state: "finished", exitCode: 0, reason: null },
    { jobId: "1001", state: "pending", exitCode: null, reason: null },
  ]);
  const state = await env.newRunner({ scheduler }).runOnce();
  assert.equal(scheduler.calls.submit, 0);
  assert.deepEqual(scheduler.calls.cancel, ["1001", "1002"], "every live duplicate canceled, earliest first");
  assert.deepEqual(state.duplicateJobs.jobIds, ["1001", "1002"]);
  const [complete] = env.platform.requestsFor(env.work.runId, "complete");
  assert.equal(complete.outcome, "failed");
  assert.match(complete.failureReason, /^DUPLICATE_JOBS: 2 live scheduler jobs/);
  assert.equal(complete.manifest, null);
});

test("R05: duplicate live jobs found on reconcile → earliest reported, all canceled, run failed DUPLICATE_JOBS", async (t) => {
  const env = await setup(t);
  const scheduler = fakeScheduler([
    { jobId: "2001", state: "running", exitCode: null, reason: null },
    { jobId: "2000", state: "running", exitCode: null, reason: null },
  ]);
  env.platform.enqueue({ ...env.work, mode: "reconcile" });
  await env.newRunner({ scheduler }).runOnce();
  const [reconcile] = env.platform.requestsFor(env.work.runId, "reconcile");
  assert.equal(reconcile.found, true);
  assert.equal(reconcile.schedulerJobId, "2000");
  assert.deepEqual(scheduler.calls.cancel, ["2000", "2001"]);
  assert.match(env.platform.requestsFor(env.work.runId, "complete")[0].failureReason, /^DUPLICATE_JOBS/);
});

test("R05 (Slurm): a definitive sbatch rejection fails the run at once, without polling", async (t) => {
  const root = tempRoot(t);
  const slurm = installFakeSlurm(root);
  const rejectDir = join(root, "reject");
  mkdirSync(rejectDir);
  writeFileSync(join(rejectDir, "package.json"), JSON.stringify({ type: "commonjs" }));
  const rejectLog = join(rejectDir, "calls.log");
  const sbatch = join(rejectDir, "sbatch");
  writeFileSync(sbatch, `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(rejectLog)}, "sbatch\\n");
process.stderr.write("sbatch: error: Batch job submission failed: Invalid partition name specified\\n");
process.exit(1);
`);
  chmodSync(sbatch, 0o755);
  const env = await setup(t, { scheduler: { type: "slurm", slurm: { ...slurm, sbatch } }, limits: { ...FAST, submitVisibilitySeconds: 30 } });
  env.platform.enqueue(env.work);
  const started = Date.now();
  const state = await env.newRunner().runOnce();
  assert.ok(Date.now() - started < 20_000, "no visibility wait");
  assert.equal(state.submit, "rejected");
  const [complete] = env.platform.requestsFor(env.work.runId, "complete");
  assert.equal(complete.outcome, "failed");
  assert.match(complete.failureReason, /^SUBMIT_REJECTED: .*Invalid partition name specified/);
  assert.equal(readFileSync(rejectLog, "utf8").trim().split("\n").length, 1);
  assert.equal(readFakeSlurm(root).calls.filter((call) => call.command === "squeue").length, 1, "only the pre-submit findByTag");
  const receipt = JSON.parse(readFileSync(join(env.config.workRoot, env.work.runId, SUBMIT_RECEIPT), "utf8"));
  assert.equal(receipt.outcome, "rejected");
});

test("sbatch failure classification is conservative", () => {
  const rejected = (stderr, code = 1) => classifySbatchFailure({ code, signal: null, stderr });
  assert.equal(rejected("sbatch: error: Batch job submission failed: Invalid partition name specified"), "rejected");
  assert.equal(rejected("sbatch: error: Batch job submission failed: Invalid account or account/partition combination specified"), "rejected");
  assert.equal(rejected("sbatch: error: Batch job submission failed: Requested node configuration is not available"), "rejected");
  assert.equal(rejected("sbatch: error: Batch job submission failed: Job violates accounting/QOS policy (job submit limit, user's size and/or time limits)"), "rejected");
  assert.equal(rejected("sbatch: unrecognized option '--bogus'"), "rejected");
  // Anything transport-like, unclassified, signaled or odd stays unknown.
  assert.equal(rejected("sbatch: error: Batch job submission failed: Socket timed out on send/recv operation"), "unknown");
  assert.equal(rejected("sbatch: error: Batch job submission failed: Unable to contact slurm controller (connect failure)"), "unknown");
  assert.equal(rejected("sbatch: error: Invalid partition name specified; slurmctld communication error"), "unknown");
  assert.equal(rejected("sbatch: error: something new"), "unknown");
  assert.equal(rejected(""), "unknown");
  assert.equal(classifySbatchFailure({ code: null, signal: "SIGKILL", stderr: "Invalid partition" }), "unknown");
  assert.equal(rejected("Invalid partition", 0), "unknown");
});

test("local scheduler submit is idempotent per submitTag", async (t) => {
  const root = tempRoot(t);
  const runDir = join(root, "run");
  mkdirSync(runDir);
  const jobScript = join(runDir, "job.mjs");
  writeFileSync(jobScript, `import { writeFileSync, appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(runDir, "starts.log"))}, "x\\n");\nwriteFileSync(${JSON.stringify(join(runDir, "status.json"))}, JSON.stringify({ state: "finished", exitCode: 0 }));\n`);
  const scheduler = createLocalScheduler({ workRoot: join(root, "work"), env: { PATH: process.env.PATH ?? "" } });
  const first = await scheduler.submit({ runDir, jobScript }, "tag-1");
  const second = await scheduler.submit({ runDir, jobScript }, "tag-1");
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.reused, true);
  assert.deepEqual(readdirSync(join(root, "work", ".local-scheduler")).filter((name) => name.endsWith(".json")), ["tag-1.json"]);
  await waitFor(() => existsSync(join(runDir, "status.json")));
  assert.equal(readFileSync(join(runDir, "starts.log"), "utf8"), "x\n", "launched once");
  assert.equal((await scheduler.findByTag("tag-1")).length, 1);
});
