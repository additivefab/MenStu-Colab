#!/usr/bin/env node
// Lab compute runner (spec §7.1). Pulls approved runs from the platform
// (outbound HTTPS only, D4), executes them in Apptainer through a scheduler
// adapter, gates outputs (D5) and reports a manifest.
//
// Usage: node --experimental-strip-types infra/lab-runner/runner.mjs --config /etc/tanyan/lab-runner.json
//
// Invariants:
//  - A run is submitted at most once per submitTag: every submit is preceded
//    by scheduler.findByTag(submitTag); a found job is adopted (T11).
//  - Per-run state lives in <workRoot>/<runId>/state.json (atomic writes);
//    repository tokens are kept in memory only.
//  - Lease loss (409 LEASE_LOST, or the local lease clock running out while
//    heartbeats fail) stops every local action for that run: no submit, no
//    cancel, no complete. The scheduler job is left alone because whoever holds
//    the new lease adopts it by submitTag; walltime bounds an orphan.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TERMINAL_RUN_STATUSES, validateMetricsFile } from "../../lib/research-loop/contracts.ts";
import { evaluateEgress, METRICS_RELATIVE_PATH } from "./egress.mjs";
import { buildManifest } from "./manifest.mjs";
import { CheckoutError, checkoutCommit } from "./lib/checkout.mjs";
import { ConfigError, loadConfig, loadRunnerToken } from "./lib/config.mjs";
import { buildContainerCommand, checkImageConfig, createImageHashCache, ImageProvenanceError, verifyImage } from "./lib/container.mjs";
import { pickEnv, runCommand } from "./lib/process.mjs";
import { DataBindingError, loadDatasetFileHashes, recheckDatasetBinding, verifyDatasetBinding, verifyManifestHashes } from "./lib/dataset.mjs";
import { readJsonIfExists, sleep, writeJsonAtomic } from "./lib/fsutil.mjs";
import { createLogger, errorMessage } from "./lib/log.mjs";
import { createPlatformClient, LeaseLostError } from "./lib/platform-client.mjs";
import { createScheduler } from "./schedulers/index.mjs";

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SUBMIT_TAG = /^[A-Za-z0-9_.-]{1,128}$/;
const LAUNCHER_URL = pathToFileURL(fileURLToPath(new URL("./job-launcher.mjs", import.meta.url))).href;
const SCHEDULER_TERMINAL = new Set(["finished", "failed", "canceled"]);
const DATA_BINDING_FILE = "data-binding.json";

class PreparationError extends Error {}

export function createRunner({ config, token, logger = createLogger(), scheduler, platform, hooks = {} }) {
  logger.addSecret(token);
  scheduler ??= createScheduler(config);
  platform ??= createPlatformClient({ platformUrl: config.platformUrl, token, timeoutMs: config.limits.requestTimeoutSeconds * 1000 });
  // Image provenance (G02): malformed entries are fatal at startup; legacy
  // string entries keep working but are logged as unverified.
  let imageWarnings;
  try {
    imageWarnings = checkImageConfig(config.apptainer);
  } catch (error) {
    if (error instanceof ImageProvenanceError) throw new ConfigError(error.message);
    throw error;
  }
  for (const warning of imageWarnings) logger.warn(warning.message, warning.fields);
  const imageHashCache = createImageHashCache();
  const runImageVerify = (path) => runCommand(config.apptainer.binary, ["verify", path], { env: pickEnv(config.apptainer.hostEnv), timeoutMs: 600_000 });
  const active = new Map();
  let stopping = false;

  const heartbeatMs = config.limits.heartbeatSeconds * 1000;
  const pollMs = config.limits.pollSeconds * 1000;

  // -------------------------------------------------------------------------
  // per-run context helpers
  // -------------------------------------------------------------------------

  async function persist(ctx) {
    await writeJsonAtomic(join(ctx.runDir, "state.json"), ctx.state);
  }

  function ensureLease(ctx) {
    if (ctx.leaseLost) throw new LeaseLostError(ctx.work.runId);
    if (stopping) throw new StopRequested();
  }

  async function beat(ctx) {
    // The platform rejects heartbeats for a run in "reconciling" (409
    // RECONCILE_REQUIRED); the reconcile response itself renews the lease.
    if (ctx.leaseLost || ctx.heartbeatStopped || ctx.awaitingReconcile) return;
    try {
      const response = await platform.heartbeat({
        runId: ctx.work.runId,
        leaseEpoch: ctx.work.leaseEpoch,
        phase: ctx.phase,
        ...(ctx.state.schedulerJobId ? { schedulerJobId: ctx.state.schedulerJobId } : {}),
      });
      if (typeof response.leaseExpiresAt === "string") ctx.leaseExpiresAt = Date.parse(response.leaseExpiresAt);
      if (response.cancelRequested === true && !ctx.state.cancelRequested) {
        logger.info("cancel requested by platform", { runId: ctx.work.runId });
        ctx.state.cancelRequested = true;
        await persist(ctx);
      }
    } catch (error) {
      if (error instanceof LeaseLostError) {
        ctx.leaseLost = true;
        return;
      }
      logger.warn("heartbeat failed", { runId: ctx.work.runId, error: errorMessage(error) });
      if (Number.isFinite(ctx.leaseExpiresAt) && Date.now() > ctx.leaseExpiresAt) {
        logger.warn("lease expired locally after failed heartbeats; abandoning local actions", { runId: ctx.work.runId });
        ctx.leaseLost = true;
      }
    }
  }

  function startHeartbeats(ctx) {
    const tick = async () => {
      if (ctx.heartbeatStopped) return;
      await beat(ctx);
      if (!ctx.heartbeatStopped && !ctx.leaseLost) ctx.heartbeatTimer = setTimeout(tick, heartbeatMs);
    };
    ctx.heartbeatTimer = setTimeout(tick, heartbeatMs);
  }

  function stopHeartbeats(ctx) {
    ctx.heartbeatStopped = true;
    clearTimeout(ctx.heartbeatTimer);
  }

  async function setPhase(ctx, phase) {
    if (ctx.phase === phase) return;
    ctx.phase = phase;
    await beat(ctx);
    ensureLease(ctx);
  }

  // -------------------------------------------------------------------------
  // preparation: checkout, data binding, job files
  // -------------------------------------------------------------------------

  async function prepare(ctx) {
    const { spec } = ctx.work;
    const dataset = config.datasets[spec.dataset.versionId];
    // Cheap manifest-hash check first, so a wrong binding fails before checkout;
    // the data bytes themselves are verified after checkout (below).
    try {
      await verifyManifestHashes(spec, dataset);
    } catch (error) {
      if (error instanceof DataBindingError) throw new PreparationError(`data binding failed: ${error.message}`);
      throw error;
    }
    ensureLease(ctx);

    const srcDir = join(ctx.runDir, "src");
    const alreadyCheckedOut = ctx.state.checkoutHead === spec.executedCommitSha && (await exists(join(srcDir, ".git")));
    if (!alreadyCheckedOut) {
      try {
        const { head } = await checkoutCommit({
          srcDir,
          commitSha: spec.executedCommitSha,
          repository: ctx.repository,
          fallback: config.gitReadFallback,
          githubBaseUrl: config.githubBaseUrl,
          git: config.git,
          logger,
        });
        ctx.state.checkoutHead = head;
        await persist(ctx);
      } catch (error) {
        if (error instanceof CheckoutError) throw new PreparationError(`checkout failed: ${error.message}`);
        throw error;
      }
    }
    ensureLease(ctx);

    // R02: verify the input bytes last, as close to submit as possible, and
    // mount exactly the verified (realpath) directory read-only.
    let binding;
    try {
      binding = await verifyDatasetBinding(spec, dataset);
      const hashes = await loadDatasetFileHashes(dataset.manifestPath);
      hashes.add(spec.dataset.manifestSha256);
      if (spec.dataset.splitManifestSha256) hashes.add(spec.dataset.splitManifestSha256);
      ctx.datasetHashes = hashes;
    } catch (error) {
      if (error instanceof DataBindingError) throw new PreparationError(`data binding failed: ${error.message}`);
      throw error;
    }
    await writeJsonAtomic(join(ctx.runDir, DATA_BINDING_FILE), binding);
    ctx.dataBinding = binding;
    if (binding.ignoredExtraFiles.length) {
      logger.warn("dataset has files outside the manifest; extraFiles=ignore, recorded in data-binding.json (they stay visible under /data)", {
        runId: ctx.work.runId, count: binding.ignoredExtraFiles.length, paths: binding.ignoredExtraFiles.slice(0, 20).map((file) => file.path),
      });
    }
    logger.info("dataset verified", { runId: ctx.work.runId, dataVerification: binding.dataVerification, dataDigest: binding.dataDigest, files: binding.fileCount });
    ensureLease(ctx);

    const outDir = join(ctx.runDir, "out");
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    // Image provenance (G02): hash the SIF (cached by stat identity) and check
    // immutability right before the job is written and submitted.
    let image;
    try {
      image = await verifyImage(spec.entrypoint.imageRef, config.apptainer, { cache: imageHashCache, runVerify: runImageVerify });
    } catch (error) {
      if (error instanceof ImageProvenanceError) throw new PreparationError(`image verification failed: ${error.message}`);
      throw error;
    }
    ctx.state.image = image.verified
      ? { imageRef: spec.entrypoint.imageRef, path: image.path, sifSha256: image.sifSha256, source: image.source }
      : { imageRef: spec.entrypoint.imageRef, path: image.path, unverified: true };
    await persist(ctx);
    if (image.verified) logger.info("image verified", { runId: ctx.work.runId, sifSha256: image.sifSha256, cached: image.cached });
    ensureLease(ctx);
    let command;
    try {
      command = buildContainerCommand({ spec, runId: ctx.work.runId, srcDir, dataPath: binding.dataPath, outDir, apptainer: config.apptainer, imagePath: image.path });
    } catch (error) {
      throw new PreparationError(`container command rejected: ${errorMessage(error)}`);
    }
    const jobJsonPath = join(ctx.runDir, "job.json");
    await writeJsonAtomic(jobJsonPath, {
      runDir: ctx.runDir,
      cwd: ctx.runDir,
      argv: command.argv,
      env: command.env,
      hostEnv: config.apptainer.hostEnv,
      forwardIntoContainer: config.apptainer.forwardIntoContainer,
      logPath: join(outDir, "logs", "job.log"),
      walltimeSeconds: Math.round(spec.resources.walltimeMinutes * 60),
      killGraceSeconds: config.limits.killGraceSeconds,
      nvidiaSmi: config.nvidiaSmi,
    });
    const jobScript = join(ctx.runDir, "job.mjs");
    await writeFile(
      jobScript,
      `#!${config.nodePath}\n// Generated by lab-runner; runs the shared launcher for this run.\n` +
        `import { runLauncher } from ${JSON.stringify(LAUNCHER_URL)};\n` +
        `process.exitCode = await runLauncher(${JSON.stringify(jobJsonPath)});\n`,
      { mode: 0o700 },
    );
    await chmod(jobScript, 0o700);
    return { jobScript, outDir };
  }

  // -------------------------------------------------------------------------
  // scheduler interaction
  // -------------------------------------------------------------------------

  function pickJob(jobs) {
    if (!jobs.length) return null;
    const live = jobs.filter((job) => !SCHEDULER_TERMINAL.has(job.state));
    if (live.length > 1) logger.error("multiple live scheduler jobs carry the same submitTag", { jobIds: live.map((job) => job.jobId) });
    return live[0] ?? jobs[jobs.length - 1];
  }

  async function adopt(ctx, job) {
    logger.info("adopting existing scheduler job", { runId: ctx.work.runId, jobId: job.jobId, state: job.state });
    ctx.state.schedulerJobId = job.jobId;
    await persist(ctx);
  }

  async function submitOnce(ctx, prepared) {
    const { spec } = ctx.work;
    const existing = pickJob(await scheduler.findByTag(ctx.work.submitTag));
    if (existing) return adopt(ctx, existing);
    ensureLease(ctx);
    if (ctx.state.cancelRequested) return;

    // Fresh outputs for a fresh job: nothing from an earlier, never-started submission survives.
    await rm(prepared.outDir, { recursive: true, force: true });
    await mkdir(prepared.outDir, { recursive: true, mode: 0o700 });
    await rm(join(ctx.runDir, "status.json"), { force: true });

    ctx.state.submitStartedAt = new Date().toISOString();
    await persist(ctx);
    const job = { runDir: ctx.runDir, jobScript: prepared.jobScript, resources: spec.resources };
    let submitted;
    for (let attemptNo = 1; attemptNo <= 2 && !submitted; attemptNo += 1) {
      try {
        submitted = await scheduler.submit(job, ctx.work.submitTag);
      } catch (error) {
        logger.warn("submit failed; reconciling by submitTag before any retry", { runId: ctx.work.runId, error: errorMessage(error) });
        const found = pickJob(await scheduler.findByTag(ctx.work.submitTag));
        if (found) return adopt(ctx, found);
        if (attemptNo === 2) throw new PreparationError(`scheduler submit failed: ${errorMessage(error)}`);
        ensureLease(ctx);
      }
    }
    await hooks.afterSubmit?.(ctx, submitted);
    ctx.state.schedulerJobId = submitted.jobId;
    await persist(ctx);
    logger.info("submitted", { runId: ctx.work.runId, jobId: submitted.jobId, scheduler: scheduler.kind });
  }

  async function queryJob(ctx) {
    try {
      return await scheduler.query(ctx.state.schedulerJobId);
    } catch (error) {
      logger.warn("scheduler query failed", { runId: ctx.work.runId, error: errorMessage(error) });
      return null;
    }
  }

  async function monitor(ctx) {
    await setPhase(ctx, "running");
    for (;;) {
      ensureLease(ctx);
      if (ctx.state.cancelRequested) return cancelJob(ctx);
      const result = await queryJob(ctx);
      if (result && SCHEDULER_TERMINAL.has(result.state)) return finishFromScheduler(ctx, result);
      await sleep(pollMs);
    }
  }

  async function cancelJob(ctx) {
    const jobId = ctx.state.schedulerJobId;
    logger.info("canceling scheduler job", { runId: ctx.work.runId, jobId });
    let lastCancelAt = 0;
    for (;;) {
      ensureLease(ctx);
      if (Date.now() - lastCancelAt >= Math.max(pollMs * 10, 5_000)) {
        lastCancelAt = Date.now();
        try {
          await scheduler.cancel(jobId);
        } catch (error) {
          logger.warn("cancel command failed; will retry", { runId: ctx.work.runId, error: errorMessage(error) });
        }
      }
      const result = await queryJob(ctx);
      if (result && SCHEDULER_TERMINAL.has(result.state)) {
        logger.info("scheduler confirmed job end after cancel", { runId: ctx.work.runId, jobId, state: result.state });
        return finish(ctx, { outcome: "canceled", failureReason: "canceled at platform request", schedulerResult: result });
      }
      await sleep(pollMs);
    }
  }

  async function finishFromScheduler(ctx, result) {
    const status = await readJsonIfExists(join(ctx.runDir, "status.json"));
    const exitCode = typeof status?.exitCode === "number" ? status.exitCode : result.exitCode;
    const dataChanged = await recheckInputData(ctx);
    if (dataChanged && result.state !== "canceled") {
      // The result cannot be attributed to the approved input bytes: not technically valid.
      const reason = result.state === "finished" && exitCode === 0 ? "" : `${result.reason || (typeof exitCode === "number" ? `exit code ${exitCode}` : "job failed")}; `;
      return finish(ctx, { outcome: "failed", failureReason: `${reason}${dataChanged}`.slice(0, 950), schedulerResult: result });
    }
    if (result.state === "finished" && exitCode === 0) return finish(ctx, { outcome: "completed", schedulerResult: result });
    if (result.state === "canceled") {
      return finish(ctx, { outcome: "canceled", failureReason: ctx.state.cancelRequested ? "canceled at platform request" : `scheduler reports job canceled (${result.reason ?? "no reason"})`, schedulerResult: result });
    }
    const reason = status?.state === "timeout" ? status.reason : result.reason || (exitCode !== null && exitCode !== undefined ? `exit code ${exitCode}` : "job failed");
    return finish(ctx, { outcome: "failed", failureReason: reason, schedulerResult: result });
  }

  async function loadDataBinding(ctx) {
    ctx.dataBinding ??= await readJsonIfExists(join(ctx.runDir, DATA_BINDING_FILE));
    return ctx.dataBinding;
  }

  // R02 time-of-use check: after the job ends, every verified file must still
  // carry the stat signature recorded before submit. Returns a failure reason
  // or null. The result is kept in state.json either way.
  async function recheckInputData(ctx) {
    const binding = await loadDataBinding(ctx);
    if (!binding) {
      logger.warn("no data-binding.json for this run; post-run input check skipped and no dataDigest reported", { runId: ctx.work.runId });
      return null;
    }
    const check = await recheckDatasetBinding(binding);
    ctx.state.dataRecheck = { checkedAt: new Date().toISOString(), unchanged: check.unchanged, reason: check.reason, newlyIgnored: check.newlyIgnored.slice(0, 50) };
    await persist(ctx);
    if (check.newlyIgnored.length) logger.warn("files outside the manifest appeared during the run (extraFiles=ignore)", { runId: ctx.work.runId, paths: check.newlyIgnored.slice(0, 20) });
    if (check.unchanged) return null;
    logger.error("input data changed during the run; result marked failed", { runId: ctx.work.runId, reason: check.reason });
    return `input data changed during the run (${binding.dataVerification} verification at ${binding.verifiedAt}): ${check.reason}`;
  }

  // -------------------------------------------------------------------------
  // collection and completion
  // -------------------------------------------------------------------------

  // Contract (RunManifest.metricsArtifactPath): the path is reported whenever
  // metrics.json is a regular file, published or held (R03: the gate holds a
  // metrics.json that fails the trusted-metrics check). The platform records
  // technical_validity "invalid" for it (T19); withholding the path would turn
  // "invalid" into "unknown".
  async function readMetrics(ctx, gate) {
    const artifact = gate.artifacts.find((item) => item.relativePath === METRICS_RELATIVE_PATH && item.sha256 !== "");
    if (!artifact) return { path: null, note: "no metrics.json" };
    if (artifact.egressDecision !== "published") return { path: METRICS_RELATIVE_PATH, note: `metrics.json not published: ${artifact.egressReason}` };
    const entry = gate.published.find((file) => file.relativePath === METRICS_RELATIVE_PATH);
    if (!entry) return { path: METRICS_RELATIVE_PATH, note: "metrics.json not published" };
    let parsed;
    try {
      parsed = JSON.parse(await readFile(entry.absolutePath, "utf8"));
    } catch {
      return { path: METRICS_RELATIVE_PATH, note: "metrics.json is not valid JSON" };
    }
    const checked = validateMetricsFile(parsed);
    if (!checked.ok) return { path: METRICS_RELATIVE_PATH, note: `metrics.json failed validation: ${checked.error}` };
    if (checked.metrics.evaluationProtocolSha256 !== ctx.work.spec.evaluationProtocolSha256) {
      return { path: METRICS_RELATIVE_PATH, note: "metrics.json evaluationProtocolSha256 differs from the approved spec" };
    }
    return { path: METRICS_RELATIVE_PATH, note: null };
  }

  async function finish(ctx, { outcome, failureReason, schedulerResult }) {
    ensureLease(ctx);
    ctx.state.outcome = outcome;
    ctx.state.failureReason = failureReason ?? null;
    await persist(ctx);
    if (ctx.state.schedulerJobId) await setPhase(ctx, "collecting");

    const status = await readJsonIfExists(join(ctx.runDir, "status.json"));
    const started = typeof status?.startedAt === "string" && status.startedAt;
    let manifest = null;
    let publishedFiles = [];
    let exitCode = typeof status?.exitCode === "number" ? status.exitCode : (typeof schedulerResult?.exitCode === "number" ? schedulerResult.exitCode : null);
    if (started) {
      const outDir = join(ctx.runDir, "out");
      ctx.datasetHashes ??= await datasetHashesFor(ctx.work.spec);
      const gate = await evaluateEgress({
        outDir,
        policy: ctx.work.spec.egress,
        datasetHashes: ctx.datasetHashes,
        locatorPrefix: `lab://${config.runnerId}/${ctx.work.runId}/out`,
        maxArtifacts: config.limits.maxArtifacts,
      });
      if (gate.truncated) logger.warn("artifact list truncated to maxArtifacts", { runId: ctx.work.runId, omitted: gate.truncated });
      const metrics = await readMetrics(ctx, gate);
      if (metrics.note) {
        logger.info(metrics.path ? "metrics.json failed the runner check; reported anyway so the platform marks it invalid" : "no metrics reported", { runId: ctx.work.runId, reason: metrics.note });
      }
      ctx.state.metricsNote = metrics.note;
      const environment = (await readJsonIfExists(join(ctx.runDir, "env.json"))) ?? {};
      // exitCode stays null when unknown (contracts: RunManifest.execution.exitCode).
      manifest = buildManifest({
        work: ctx.work,
        runnerId: config.runnerId,
        schedulerJobId: ctx.state.schedulerJobId ?? "",
        environment,
        image: ctx.state.image?.imageRef === ctx.work.spec.entrypoint.imageRef ? ctx.state.image : null,
        status: { startedAt: status.startedAt, endedAt: status.endedAt, exitCode },
        artifacts: gate.artifacts,
        metricsArtifactPath: metrics.path,
        dataBinding: await loadDataBinding(ctx),
      });
      for (const file of gate.published) {
        const content = await readFile(file.absolutePath);
        // Upload exactly the bytes the gate hashed; anything else is withheld.
        if (createHash("sha256").update(content).digest("hex") !== file.sha256) {
          logger.warn("published file changed after the egress scan; not uploaded", { runId: ctx.work.runId, path: file.relativePath });
          continue;
        }
        publishedFiles.push({ relativePath: file.relativePath, contentBase64: content.toString("base64") });
      }
    }
    ensureLease(ctx);
    await platform.complete({
      runId: ctx.work.runId,
      leaseEpoch: ctx.work.leaseEpoch,
      outcome,
      exitCode: started ? exitCode : null,
      ...(failureReason ? { failureReason } : {}),
      manifest,
      ...(publishedFiles.length ? { publishedFiles } : {}),
    });
    publishedFiles = [];
    ctx.state.completedAt = new Date().toISOString();
    await persist(ctx);
    logger.info("run completed", { runId: ctx.work.runId, outcome, artifacts: manifest?.artifacts.length ?? 0 });
  }

  async function datasetHashesFor(spec) {
    const dataset = config.datasets[spec.dataset.versionId];
    const hashes = await loadDatasetFileHashes(dataset.manifestPath);
    hashes.add(spec.dataset.manifestSha256);
    if (spec.dataset.splitManifestSha256) hashes.add(spec.dataset.splitManifestSha256);
    return hashes;
  }

  async function failBeforeSubmit(ctx, reason) {
    logger.warn("run failed before submission", { runId: ctx.work.runId, reason });
    return finish(ctx, { outcome: "failed", failureReason: reason });
  }

  // -------------------------------------------------------------------------
  // modes
  // -------------------------------------------------------------------------

  async function execute(ctx) {
    if (ctx.state.outcome && !ctx.state.schedulerJobId) {
      // A decision was already taken locally (e.g. canceled before submit); never revive.
      return finish(ctx, { outcome: ctx.state.outcome, failureReason: ctx.state.failureReason });
    }
    if (!ctx.state.schedulerJobId) {
      if (ctx.state.cancelRequested) return finish(ctx, { outcome: "canceled", failureReason: "canceled before submission" });
      let prepared;
      try {
        prepared = await prepare(ctx);
      } catch (error) {
        if (error instanceof PreparationError) return failBeforeSubmit(ctx, error.message);
        throw error;
      }
      if (ctx.state.cancelRequested) return finish(ctx, { outcome: "canceled", failureReason: "canceled before submission" });
      try {
        await submitOnce(ctx, prepared);
      } catch (error) {
        if (error instanceof PreparationError) return failBeforeSubmit(ctx, error.message);
        throw error;
      }
      if (!ctx.state.schedulerJobId) return finish(ctx, { outcome: "canceled", failureReason: "canceled before submission" });
    }
    if (ctx.state.outcome) {
      const result = await queryJob(ctx);
      if (result && SCHEDULER_TERMINAL.has(result.state)) return finish(ctx, { outcome: ctx.state.outcome, failureReason: ctx.state.failureReason, schedulerResult: result });
      if (ctx.state.outcome === "canceled") return cancelJob(ctx);
    }
    return monitor(ctx);
  }

  async function reconcile(ctx) {
    let job = pickJob(await scheduler.findByTag(ctx.work.submitTag));
    const recordedId = ctx.work.schedulerJobId ?? ctx.state.schedulerJobId;
    if (!job && recordedId) {
      const queried = await scheduler.query(recordedId).catch(() => null);
      if (queried && queried.state !== "unknown") job = { jobId: recordedId, ...queried };
    }
    ensureLease(ctx);
    const request = { runId: ctx.work.runId, leaseEpoch: ctx.work.leaseEpoch, found: Boolean(job) };
    if (job) {
      request.schedulerJobId = job.jobId;
      request.schedulerState = job.state;
    }
    /** @type {import("../../lib/research-loop/contracts.ts").ComputeReconcileResponse} */
    const response = await platform.reconcile(request);
    logger.info("reconciled", { runId: ctx.work.runId, found: Boolean(job), jobId: job?.jobId, state: job?.state, status: response?.status });
    ctx.awaitingReconcile = false;
    if (typeof response?.leaseExpiresAt === "string") ctx.leaseExpiresAt = Date.parse(response.leaseExpiresAt);
    if (response?.cancelRequested === true && !ctx.state.cancelRequested) {
      ctx.state.cancelRequested = true;
      await persist(ctx);
    }
    const status = typeof response?.status === "string" ? response.status : null;
    if (status === "dispatching" || status === "running" || status === "collecting") ctx.phase = status;
    if (status && TERMINAL_RUN_STATUSES.includes(status)) return markTerminal(ctx, status);
    if (!job) {
      if (status === "canceled" || (!status && ctx.state.cancelRequested)) return markTerminal(ctx, "canceled");
      // Proven absent: the platform moves the run back to dispatching and this lease submits,
      // using the fresh read token it returns (reconcile-mode claims carry none).
      if (response?.repository?.token) {
        logger.addSecret(response.repository.token);
        ctx.repository = response.repository;
      }
      return execute(ctx);
    }
    await adopt(ctx, job);
    if (!status && (job.state === "failed" || job.state === "canceled")) return markTerminal(ctx, job.state);
    if (job.state === "finished" || status === "collecting") return finishFromScheduler(ctx, await scheduler.query(job.jobId).catch(() => job));
    return monitor(ctx);
  }

  async function markTerminal(ctx, status) {
    ctx.state.outcome ??= status === "completed" ? "completed" : status;
    ctx.state.platformTerminal = status;
    await persist(ctx);
    logger.info("platform reports run terminal after reconcile; nothing left to do", { runId: ctx.work.runId, status });
  }

  // -------------------------------------------------------------------------
  // entry points
  // -------------------------------------------------------------------------

  async function handleWork(work) {
    if (!RUN_ID.test(work.runId ?? "") || !SUBMIT_TAG.test(work.submitTag ?? "")) {
      logger.error("claim returned an invalid runId or submitTag; ignoring", { runId: String(work.runId).slice(0, 100) });
      return;
    }
    if (work.repository?.token) logger.addSecret(work.repository.token);
    const runDir = join(config.workRoot, work.runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const previous = (await readJsonIfExists(join(runDir, "state.json"))) ?? {};
    const { repository, ...persistable } = work; // the token never reaches disk
    const ctx = {
      work,
      repository,
      runDir,
      phase: "dispatching",
      leaseLost: false,
      awaitingReconcile: work.mode === "reconcile",
      leaseExpiresAt: Date.parse(work.leaseExpiresAt),
      state: {
        ...previous,
        runId: work.runId,
        attempt: work.attempt,
        submitTag: work.submitTag,
        mode: work.mode,
        leaseEpoch: work.leaseEpoch,
        claimedAt: new Date().toISOString(),
        work: persistable,
        schedulerJobId: previous.schedulerJobId ?? work.schedulerJobId ?? null,
        cancelRequested: previous.cancelRequested === true,
      },
    };
    await persist(ctx);
    logger.info("claimed", { runId: work.runId, mode: work.mode, leaseEpoch: work.leaseEpoch });
    startHeartbeats(ctx);
    try {
      // Execute mode: confirm the lease right away and learn about a pending
      // cancel before doing any work. Reconcile mode: the reconcile call does this.
      await beat(ctx);
      ensureLease(ctx);
      if (work.mode === "reconcile") await reconcile(ctx);
      else await execute(ctx);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        ctx.state.abandonedLeaseEpoch = work.leaseEpoch;
        ctx.state.abandonedAt = new Date().toISOString();
        await persist(ctx);
        logger.warn("lease lost; abandoned local actions for this run (scheduler job left for the next lease holder)", { runId: work.runId, leaseEpoch: work.leaseEpoch });
      } else if (error instanceof StopRequested) {
        logger.info("runner stopping; run left for reconciliation", { runId: work.runId });
      } else {
        ctx.state.lastError = logger.redact(errorMessage(error));
        await persist(ctx).catch(() => {});
        logger.error("run handling failed; leaving it for lease expiry and reconciliation", { runId: work.runId, error: errorMessage(error) });
      }
    } finally {
      stopHeartbeats(ctx);
    }
    return ctx.state;
  }

  async function runOnce() {
    const response = await platform.claim();
    if (!response?.work) return null;
    return handleWork(response.work);
  }

  async function start() {
    stopping = false;
    await mkdir(config.workRoot, { recursive: true, mode: 0o700 });
    while (!stopping) {
      if (active.size >= config.limits.maxConcurrentRuns) {
        await Promise.race(active.values());
        continue;
      }
      let response = null;
      try {
        response = await platform.claim();
      } catch (error) {
        logger.warn("claim failed", { error: errorMessage(error) });
      }
      if (response?.work) {
        const runId = response.work.runId;
        const task = handleWork(response.work).catch((error) => logger.error("unexpected run error", { error: errorMessage(error) }))
          .finally(() => active.delete(runId));
        active.set(runId, task);
        continue;
      }
      await sleep(config.limits.claimIntervalSeconds * 1000);
    }
    await Promise.allSettled(active.values());
  }

  return {
    runOnce,
    handleWork,
    start,
    stop() { stopping = true; },
    get activeRuns() { return [...active.keys()]; },
  };
}

class StopRequested extends Error {}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Single runner per workRoot: exclusive lock file holding our pid. */
async function acquireLock(workRoot) {
  const lockPath = join(workRoot, ".runner.lock");
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => rm(lockPath, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const pid = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
      let alive = false;
      try { process.kill(pid, 0); alive = Number.isInteger(pid) && pid > 0; } catch (killError) { alive = killError?.code === "EPERM"; }
      if (alive) throw new Error(`another lab-runner (pid ${pid}) holds ${lockPath}`);
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`cannot acquire ${lockPath}`);
}

async function main(argv) {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : process.env.TANYAN_LAB_RUNNER_CONFIG;
  if (!configPath) throw new ConfigError("usage: runner.mjs --config <path>");
  const logger = createLogger();
  const config = await loadConfig(configPath);
  const token = await loadRunnerToken(config, { logger });
  const release = await acquireLock(config.workRoot);
  const runner = createRunner({ config, token, logger });
  const shutdown = () => {
    logger.info("shutdown requested; finishing current requests (jobs keep running and are reconciled on restart)");
    runner.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  logger.info("lab runner started", { runnerId: config.runnerId, scheduler: config.scheduler.type, workRoot: config.workRoot });
  try {
    await runner.start();
  } finally {
    await release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[lab-runner] fatal: ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
