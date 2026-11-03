// End-to-end runner tests against a FAKE platform and FAKE schedulers/container
// (simulation only: no Apptainer, no Slurm, no GPU, no network).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createRunner } from "./runner.mjs";
import { createLogger } from "./lib/log.mjs";
import { createScheduler } from "./schedulers/index.mjs";
import { installFakeSlurm, readFakeSlurm, setFakeSlurmControl } from "./test-support/fake-slurm.mjs";
import { startFakePlatform } from "./test-support/fake-platform.mjs";
import {
  captureLogger, createDataset, createRepo, filesContaining, installShim, makeConfig, makeSpec, makeWork, PROTOCOL_SHA, sha256, tempRoot, waitFor,
} from "./test-support/fixtures.mjs";

const RUNNER_TOKEN = "lrt_test_runner_token_0123456789abcdef";
const REPO_TOKEN = "ghs_shortlivedRepoToken0123456789ABCDEF";

async function setup(t, { scheduler, gitReadFallback = true, git, githubBaseUrl, limits } = {}) {
  const root = tempRoot(t);
  const platform = await startFakePlatform({ token: RUNNER_TOKEN });
  t.after(() => platform.close());
  const repo = createRepo(root);
  const dataset = createDataset(root);
  const shim = installShim(root);
  const config = makeConfig({
    root,
    platformUrl: platform.url,
    dataset,
    shimPath: shim.path,
    scheduler,
    gitReadFallback: gitReadFallback ? { url: repo.repo } : undefined,
    git,
    githubBaseUrl,
    limits,
  });
  const { logger, lines } = captureLogger(createLogger);
  const newRunner = (hooks) => createRunner({ config, token: RUNNER_TOKEN, logger, hooks });
  return { root, platform, repo, dataset, shim, config, logger, lines, newRunner };
}

test("happy path: executes, gates outputs, reports manifest and metrics (T18, D5)", async (t) => {
  const env = await setup(t);
  const spec = makeSpec({ sha: env.repo.sha, dataset: env.dataset });
  const work = makeWork({ spec });
  env.platform.enqueue(work);

  const state = await env.newRunner().runOnce();
  assert.equal(state.outcome, "completed");

  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.ok(complete, "complete was sent");
  assert.equal(complete.outcome, "completed");
  assert.equal(complete.exitCode, 0);
  const manifest = complete.manifest;
  assert.equal(manifest.schema, "tanyan.manifest/v1");
  assert.equal(manifest.runId, work.runId);
  assert.equal(manifest.runSpecSha256, work.runSpecSha256);
  assert.equal(manifest.approvalId, work.approvalId);
  assert.deepEqual(manifest.repository, { repositoryId: 4242, executedCommitSha: env.repo.sha });
  assert.equal(manifest.inputs.manifestSha256, env.dataset.manifestSha256);
  assert.equal(manifest.inputs.evaluationProtocolSha256, PROTOCOL_SHA);
  assert.deepEqual(manifest.inputs.seeds, [7]);
  assert.equal(manifest.environment.imageDigest, `sha256:${"a".repeat(64)}`);
  assert.equal(manifest.environment.driverVersion, "", "no nvidia-smi: empty, never invented");
  assert.equal(manifest.environment.gpuModel, "");
  assert.equal(manifest.execution.submitTag, work.submitTag);
  assert.match(manifest.execution.schedulerJobId, /^local-/);
  assert.equal(manifest.execution.exitCode, 0);
  assert.ok(Date.parse(manifest.execution.startedAt) <= Date.parse(manifest.execution.endedAt));
  assert.equal(manifest.metricsArtifactPath, "metrics.json");

  const byPath = Object.fromEntries(manifest.artifacts.map((artifact) => [artifact.relativePath, artifact]));
  assert.equal(byPath["metrics.json"].egressDecision, "published");
  assert.equal(byPath["metrics.json"].kind, "metrics");
  // R03: held by default; only the validated metrics.json leaves the lab.
  assert.equal(byPath["table.csv"].egressDecision, "held");
  assert.match(byPath["table.csv"].egressReason, /需数据持有方授权后外发/);
  assert.equal(byPath["table.csv"].kind, "table");
  assert.equal(byPath["figure.png"].egressDecision, "held");
  assert.equal(byPath["figure.png"].kind, "figure");
  assert.equal(byPath["copied-sample.json"].egressDecision, "rejected", "dataset copy must be rejected");
  assert.equal(byPath["data-link"].egressDecision, "rejected", "symlink must be rejected");
  assert.equal(byPath["logs/job.log"].kind, "log");
  for (const artifact of manifest.artifacts) assert.match(artifact.labLocator, new RegExp(`^lab://rnr_test/${work.runId}/out/`));

  const published = Object.fromEntries(complete.publishedFiles.map((file) => [file.relativePath, Buffer.from(file.contentBase64, "base64")]));
  assert.deepEqual(Object.keys(published).sort(), manifest.artifacts.filter((a) => a.egressDecision === "published").map((a) => a.relativePath).sort());
  assert.ok(!("figure.png" in published) && !("copied-sample.json" in published));
  assert.equal(sha256(published["metrics.json"]), byPath["metrics.json"].sha256);

  const phases = env.platform.requestsFor(work.runId, "heartbeat").map((entry) => entry.phase);
  assert.ok(phases.includes("running") && phases.includes("collecting"));

  // Container command: isolation flags, read-only binds, params as argv.
  const [call] = env.shim.calls();
  for (const flag of ["--containall", "--cleanenv", "--no-home", "--net"]) assert.ok(call.flags.includes(flag), flag);
  assert.equal(call.flags[call.flags.indexOf("--network") + 1], "none");
  assert.ok(!call.flags.includes("--nv"), "no GPU requested");
  assert.equal(call.binds["/src"].mode, "ro");
  assert.equal(call.binds["/data"].mode, "ro");
  assert.equal(call.binds["/data"].source, env.dataset.dataPath);
  assert.equal(call.binds["/out"].mode, "rw");
  assert.deepEqual(call.entry.slice(2), ["--mode=ok", "--seed=7"]);
  assert.equal(call.containerEnv.TANYAN_OUT_DIR, "/out");
});

test("token handling: repository token reaches git only via env and never disk/logs/argv", async (t) => {
  const root0 = tempRoot(t);
  const gitLog = join(root0, "git-calls.jsonl");
  const gitWrapper = join(root0, "git-wrapper");
  writeFileSync(gitWrapper, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + "\\n");
const result = spawnSync("git", process.argv.slice(2), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`);
  chmodSync(gitWrapper, 0o755);
  // .cjs semantics for require(): name the wrapper without .mjs and force CommonJS.
  writeFileSync(join(root0, "package.json"), JSON.stringify({ type: "commonjs" }));
  const env = await setup(t, { gitReadFallback: false, git: gitWrapper });
  const config = { ...env.config, githubBaseUrl: `file://${env.repo.base}` };
  // The token sits in the runner's own environment, as in production.
  process.env.TANYAN_LAB_RUNNER_TOKEN = RUNNER_TOKEN;
  t.after(() => { delete process.env.TANYAN_LAB_RUNNER_TOKEN; });
  const runner = createRunner({ config, token: RUNNER_TOKEN, logger: env.logger });

  const work = makeWork({
    spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }),
    repository: { fullName: "owner/repo", repositoryId: 4242, token: REPO_TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  env.platform.enqueue(work);
  const state = await runner.runOnce();
  assert.equal(state.outcome, "completed");

  const calls = readFileSync(gitLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const fetchCall = calls.find((call) => call.argv[0] === "fetch");
  assert.ok(fetchCall, "git fetch ran");
  assert.ok(!JSON.stringify(calls.map((call) => call.argv)).includes(REPO_TOKEN), "token never in git argv");
  const expectedHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${REPO_TOKEN}`).toString("base64")}`;
  assert.equal(fetchCall.env.GIT_CONFIG_KEY_0, "http.extraHeader");
  assert.equal(fetchCall.env.GIT_CONFIG_VALUE_0, expectedHeader);
  assert.equal(fetchCall.env.TANYAN_LAB_RUNNER_TOKEN, undefined, "runner token not leaked to git");
  for (const call of calls.filter((entry) => entry.argv[0] !== "fetch")) assert.equal(call.env.GIT_CONFIG_VALUE_0, undefined);

  const encoded = Buffer.from(`x-access-token:${REPO_TOKEN}`).toString("base64");
  for (const secret of [REPO_TOKEN, RUNNER_TOKEN, encoded]) {
    assert.deepEqual(filesContaining(env.config.workRoot, secret), [], "secret never written under workRoot");
    assert.ok(!env.lines.join("\n").includes(secret), "secret never logged");
  }
  // The job environment never sees the runner token either.
  const [shimCall] = env.shim.calls();
  assert.ok(!shimCall.hostEnvKeys.includes("TANYAN_LAB_RUNNER_TOKEN"));
  const head = readFileSync(join(env.config.workRoot, work.runId, "src", ".git", "config"), "utf8");
  assert.ok(!/extraheader|authorization|x-access-token/i.test(head));
});

test("dataset manifest hash mismatch fails before anything is submitted", async (t) => {
  const env = await setup(t);
  const spec = makeSpec({ sha: env.repo.sha, dataset: { ...env.dataset, manifestSha256: "0".repeat(64) } });
  const work = makeWork({ spec });
  env.platform.enqueue(work);
  const state = await env.newRunner().runOnce();
  assert.equal(state.outcome, "failed");
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.outcome, "failed");
  assert.match(complete.failureReason, /manifest sha256 mismatch/);
  assert.equal(complete.manifest, null);
  assert.equal(complete.exitCode, null);
  assert.equal(env.shim.calls().length, 0, "container never started");
  assert.ok(!existsSync(join(env.config.workRoot, ".local-scheduler", `${work.submitTag}.json`)), "nothing submitted");
  assert.ok(!existsSync(join(env.config.workRoot, work.runId, "src")), "no checkout either");
});

test("no repository access (claim repository=null, no fallback) fails clearly", async (t) => {
  const env = await setup(t, { gitReadFallback: false });
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }) });
  env.platform.enqueue(work);
  await env.newRunner().runOnce();
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.match(complete.failureReason, /no repository access/);
  assert.equal(env.shim.calls().length, 0);
});

test("argv never goes through a shell: metacharacters arrive verbatim", async (t) => {
  const env = await setup(t);
  const evil = "$(touch PWNED); `touch PWNED2` && echo hi > PWNED3";
  const spec = makeSpec({ sha: env.repo.sha, dataset: env.dataset, params: { mode: "argv", evil, spaced: "a b  c" } });
  const work = makeWork({ spec });
  env.platform.enqueue(work);
  await env.newRunner().runOnce();
  const argv = JSON.parse(readFileSync(join(env.config.workRoot, work.runId, "out", "argv.json"), "utf8"));
  assert.deepEqual(argv, [`--evil=${evil}`, "--mode=argv", "--spaced=a b  c"]);
  for (const dir of [env.root, join(env.config.workRoot, work.runId), join(env.config.workRoot, work.runId, "src")]) {
    assert.ok(!readdirSync(dir).some((name) => name.startsWith("PWNED")), `no shell side effect in ${dir}`);
  }
});

test("source code never uses a shell or exec-style APIs", () => {
  const files = ["runner.mjs", "egress.mjs", "manifest.mjs", "job-launcher.mjs", "lib/process.mjs", "lib/checkout.mjs", "lib/container.mjs", "schedulers/local.mjs", "schedulers/slurm.mjs"];
  for (const file of files) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.ok(!/shell:\s*true/.test(source), `${file}: shell: true`);
    assert.ok(!/\b(execSync|execFileSync|spawnSync)\b|(?<![.\w])exec\(/.test(source), `${file}: exec-style API`);
    assert.ok(!/["'](\/bin\/)?(ba|z|da)?sh["']/.test(source), `${file}: shell invocation`);
  }
});

test("walltime exceeded: job stopped, run failed with evidence (T16)", async (t) => {
  const env = await setup(t);
  const spec = makeSpec({ sha: env.repo.sha, dataset: env.dataset, params: { mode: "sleep" }, resources: { gpuCount: 0, walltimeMinutes: 0.06, memoryGb: 1 } });
  // ~3.6 s: long enough for the entry script to start and write its partial
  // evidence even when the whole suite runs in parallel, short enough to test T16.
  const work = makeWork({ spec });
  env.platform.enqueue(work);
  const started = Date.now();
  const state = await env.newRunner().runOnce();
  assert.ok(Date.now() - started < 15_000);
  assert.equal(state.outcome, "failed");
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.outcome, "failed");
  assert.match(complete.failureReason, /walltime exceeded/);
  assert.equal(complete.exitCode, 143, "128 + SIGTERM");
  const paths = complete.manifest.artifacts.map((artifact) => artifact.relativePath);
  assert.ok(paths.includes("partial/progress.csv"), "partial evidence kept");
});

test("invalid metrics are still reported so the platform marks them invalid (T19)", async (t) => {
  const env = await setup(t);
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset, params: { mode: "badmetrics" } }) });
  env.platform.enqueue(work);
  const state = await env.newRunner().runOnce();
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  // Contract: metricsArtifactPath names metrics.json even when it is invalid;
  // withholding it would make the platform record "unknown", not "invalid".
  // R03: an invalid metrics.json is held (not uploaded); the platform records invalid.
  assert.equal(complete.manifest.metricsArtifactPath, "metrics.json");
  const artifact = complete.manifest.artifacts.find((item) => item.relativePath === "metrics.json");
  assert.equal(artifact.egressDecision, "held");
  assert.ok(!(complete.publishedFiles ?? []).some((file) => file.relativePath === "metrics.json"), "an untrusted metrics file is not uploaded");
  assert.match(state.metricsNote, /not published: metrics\.json 未通过可信指标校验/);
});

test("no metrics.json: metricsArtifactPath stays null (platform: unknown)", async (t) => {
  const env = await setup(t);
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset, params: { mode: "nometrics" } }) });
  env.platform.enqueue(work);
  const state = await env.newRunner().runOnce();
  assert.equal(state.outcome, "completed");
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.manifest.metricsArtifactPath, null);
  assert.equal(complete.exitCode, 0);
});

test("reconcile mode sends no heartbeat before reconcile and honors the reconcile response", async (t) => {
  const env = await setup(t);
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }) });
  env.platform.enqueue(work);
  await env.newRunner({ afterSubmit: () => { throw new Error("simulated crash"); } }).runOnce();
  env.platform.requestCancel(work.runId);
  env.platform.enqueue({ ...work, mode: "reconcile", repository: null });
  const second = await env.newRunner().runOnce();
  const requests = env.platform.requestsFor(work.runId).filter((entry) => entry.leaseEpoch === 2);
  assert.equal(requests[0].action, "reconcile", "first call under the reconcile lease is reconcile, not heartbeat");
  assert.equal(second.cancelRequested, true, "cancelRequested from the reconcile response is persisted");
  assert.ok(["canceled", "completed"].includes(second.outcome));
});

test("LEASE_LOST: local actions abandoned, job not killed, next lease adopts it", async (t) => {
  const env = await setup(t);
  const spec = makeSpec({ sha: env.repo.sha, dataset: env.dataset });
  const work = makeWork({ spec });
  env.platform.enqueue(work);
  env.platform.loseLeaseWhen((body) => body.action === "heartbeat" && body.phase === "running");

  const state = await env.newRunner().runOnce();
  assert.equal(state.abandonedLeaseEpoch, 1);
  assert.equal(env.platform.requestsFor(work.runId, "complete").length, 0, "no complete after lease loss");
  const status = await waitFor(() => {
    const path = join(env.config.workRoot, work.runId, "status.json");
    const value = existsSync(path) && JSON.parse(readFileSync(path, "utf8"));
    return value && ["finished", "failed", "canceled", "timeout"].includes(value.state) && value;
  });
  assert.equal(status.state, "finished", "job was not canceled by the runner that lost its lease");

  // Platform re-dispatches in reconcile mode under a new lease: adopt, no resubmit.
  env.platform.enqueue({ ...work, mode: "reconcile", repository: null });
  const second = await env.newRunner().runOnce();
  assert.equal(second.outcome, "completed");
  const [reconcile] = env.platform.requestsFor(work.runId, "reconcile");
  assert.equal(reconcile.found, true);
  assert.equal(reconcile.schedulerState, "finished");
  assert.equal(reconcile.leaseEpoch, 2);
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.leaseEpoch, 2);
  assert.equal(env.shim.calls().length, 1, "container ran exactly once");
});

test("T11: crash after submit before recording job id → restart adopts, no duplicate (local)", async (t) => {
  const env = await setup(t);
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }) });
  env.platform.enqueue(work);
  const crashing = env.newRunner({ afterSubmit: () => { throw new Error("simulated crash: submit response lost"); } });
  const first = await crashing.runOnce();
  assert.equal(first.schedulerJobId, null, "job id never persisted");
  assert.ok(first.submitStartedAt);
  assert.equal(env.platform.requestsFor(work.runId, "complete").length, 0);

  // Restart: the platform hands the run back in reconcile mode (lease expired).
  env.platform.enqueue({ ...work, mode: "reconcile", repository: null });
  const second = await env.newRunner().runOnce();
  assert.equal(second.outcome, "completed");
  const [reconcile] = env.platform.requestsFor(work.runId, "reconcile");
  assert.equal(reconcile.found, true);
  assert.match(reconcile.schedulerJobId, /^local-/);
  assert.equal(env.shim.calls().length, 1, "exactly one container execution");
  assert.equal(readdirSync(join(env.config.workRoot, ".local-scheduler")).length, 1, "exactly one scheduler job");
});

test("T11: execute mode after a lost submit also adopts by submitTag", async (t) => {
  const env = await setup(t);
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }) });
  env.platform.enqueue(work);
  await env.newRunner({ afterSubmit: () => { throw new Error("simulated crash"); } }).runOnce();
  env.platform.enqueue({ ...work });
  const second = await env.newRunner().runOnce();
  assert.equal(second.outcome, "completed");
  assert.equal(env.shim.calls().length, 1);
  assert.ok(env.lines.some((line) => line.includes("adopting existing scheduler job")));
});

test("T11 (Slurm fake): sbatch response lost → squeue/sacct by name finds the job, sbatch called once", async (t) => {
  const root = tempRoot(t);
  const slurm = installFakeSlurm(root);
  setFakeSlurmControl(root, { sbatchLoseResponse: true });
  const env = await setup(t, { scheduler: { type: "slurm", slurm: { ...slurm, extraArgs: ["--partition=gpu"] } } });
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset, resources: { gpuCount: 2, walltimeMinutes: 30, memoryGb: 16 } }) });
  env.platform.enqueue(work);
  const state = await env.newRunner().runOnce();
  assert.equal(state.outcome, "completed");
  const { calls } = readFakeSlurm(root);
  const sbatchCalls = calls.filter((call) => call.command === "sbatch");
  assert.equal(sbatchCalls.length, 1, "never resubmitted");
  const args = sbatchCalls[0].args;
  for (const expected of ["--parsable", `--job-name=${work.submitTag}`, "--time=30", "--mem=16G", "--gres=gpu:2", "--partition=gpu"]) {
    assert.ok(args.includes(expected), expected);
  }
  assert.ok(!sbatchCalls[0].envKeys.includes("TANYAN_LAB_RUNNER_TOKEN"));
  const squeueCall = calls.find((call) => call.command === "squeue");
  assert.deepEqual(squeueCall.args.slice(0, 3), ["-h", "-n", work.submitTag]);
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.manifest.execution.schedulerJobId, "1000");
  const [shimCall] = env.shim.calls();
  assert.ok(shimCall.flags.includes("--nv"), "GPU job gets --nv");
});

test("T13 (Slurm fake): cancel → exact job scanceled, confirmed, partial results, no revival", async (t) => {
  const root = tempRoot(t);
  const slurm = installFakeSlurm(root);
  const env = await setup(t, { scheduler: { type: "slurm", slurm } });
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset, params: { mode: "sleep" } }) });
  env.platform.enqueue(work);
  const runner = env.newRunner();
  const done = runner.runOnce();
  await waitFor(() => existsSync(join(env.config.workRoot, work.runId, "out", "partial", "progress.csv")));
  env.platform.requestCancel(work.runId);
  const state = await done;
  assert.equal(state.outcome, "canceled");

  const { calls, state: slurmState } = readFakeSlurm(root);
  const scancels = calls.filter((call) => call.command === "scancel");
  assert.ok(scancels.length >= 1);
  for (const call of scancels) assert.deepEqual(call.args, ["1000"], "exact recorded job id");
  assert.equal(slurmState.jobs.length, 1);
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.outcome, "canceled");
  assert.ok(complete.manifest.artifacts.some((artifact) => artifact.relativePath === "partial/progress.csv"), "partial output kept");
  const status = JSON.parse(readFileSync(join(env.config.workRoot, work.runId, "status.json"), "utf8"));
  assert.equal(status.state, "canceled", "job confirmed ended before complete");

  // Reconnect: the platform (or a duplicate claim) hands the run back. Nothing restarts.
  env.platform.enqueue({ ...work, mode: "reconcile" });
  const again = await env.newRunner().runOnce();
  assert.equal(again.platformTerminal, "canceled");
  env.platform.enqueue({ ...work, mode: "execute" });
  await env.newRunner().runOnce();
  assert.equal(readFakeSlurm(root).calls.filter((call) => call.command === "sbatch").length, 1, "never resubmitted");
  assert.equal(env.shim.calls().length, 1, "container never restarted");
});

test("T13 (local): cancel requested before submission never starts the job", async (t) => {
  const env = await setup(t);
  const work = makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }) });
  // Cancel is already pending when the run is claimed; the immediate heartbeat reports it.
  env.platform.runs.set(work.runId, { cancelRequested: true, status: "cancel_requested" });
  env.platform.enqueue(work);
  const state = await env.newRunner({ afterSubmit: () => { throw new Error("must not submit"); } }).runOnce();
  assert.equal(state.outcome, "canceled");
  assert.equal(env.shim.calls().length, 0);
  assert.ok(!existsSync(join(env.config.workRoot, ".local-scheduler", `${work.submitTag}.json`)));
  const [complete] = env.platform.requestsFor(work.runId, "complete");
  assert.equal(complete.outcome, "canceled");
  assert.equal(complete.manifest, null);
});

test("scheduler passEnv refuses to forward credential variables", () => {
  assert.throws(
    () => createScheduler({ workRoot: "/tmp/x", scheduler: { type: "local", passEnv: ["PATH", "TANYAN_LAB_RUNNER_TOKEN"] } }),
    /must not forward credentials/,
  );
  assert.equal(createScheduler({ workRoot: "/tmp/x", scheduler: { type: "local" } }).kind, "local");
});

test("daemon loop: claims until idle, runs concurrently up to the limit, stops cleanly", async (t) => {
  const env = await setup(t, { limits: { maxConcurrentRuns: 2 } });
  const works = [0, 1].map(() => makeWork({ spec: makeSpec({ sha: env.repo.sha, dataset: env.dataset }) }));
  for (const work of works) env.platform.enqueue(work);
  const runner = env.newRunner();
  const loop = runner.start();
  await waitFor(() => works.every((work) => env.platform.requestsFor(work.runId, "complete").length === 1), { timeoutMs: 20_000 });
  runner.stop();
  await loop;
  for (const work of works) assert.equal(env.platform.requestsFor(work.runId, "complete")[0].outcome, "completed");
  assert.equal(env.shim.calls().length, 2);
});
