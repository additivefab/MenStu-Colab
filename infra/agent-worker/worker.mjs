#!/usr/bin/env -S node --experimental-strip-types
// Lab-side agent worker (spec §7.2). Pulls confirmed research tasks from the
// platform, runs a coding agent with the task owner's own subscription
// credentials in an isolated checkout, and returns a constrained change set.
// It never pushes: the platform's trusted publisher creates branches and PRs.
//
//   node --experimental-strip-types infra/agent-worker/worker.mjs --config /etc/tanyan-agent-worker/config.json

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { evaluatePathPolicy, LIMITS } from "../../lib/research-loop/contracts.ts";
import { ClaudeAdapter } from "./adapters/claude.mjs";
import { CodexAdapter } from "./adapters/codex.mjs";
import { createPlatformClient, LeaseLostError } from "./platform-client.mjs";
import { acquireProfileLock, profileDir } from "./profiles.mjs";
import { buildAgentPolicy, buildPrompt } from "./prompt.mjs";
import { createLogger, Redactor, sanitizePayload, truncate } from "./sanitize.mjs";
import { prepareWorkspace, removeWorkspace } from "./workspace.mjs";

const EVENT_KINDS = new Set(["status", "message", "tool_call", "tool_result", "file_change", "test", "usage", "error"]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function loadConfig(configPath) {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const base = path.dirname(path.resolve(configPath));
  const resolve = (value) => (typeof value === "string" && value ? path.resolve(base, value) : value);
  const config = { ...raw, workRoot: resolve(raw.workRoot), profilesDir: resolve(raw.profilesDir), tokenFile: resolve(raw.tokenFile) };
  for (const key of ["platformUrl", "workRoot", "profilesDir"]) {
    if (!config[key]) throw new Error(`config.${key} is required`);
  }
  return config;
}

export async function readWorkerToken(config, env = process.env) {
  if (env.AGENT_WORKER_TOKEN) return env.AGENT_WORKER_TOKEN.trim();
  if (!config.tokenFile) throw new Error("set AGENT_WORKER_TOKEN or config.tokenFile");
  const info = await stat(config.tokenFile);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("worker token file must be mode 0600");
  return (await readFile(config.tokenFile, "utf8")).trim();
}

export function createAdapters(config) {
  return {
    codex: new CodexAdapter({ codexPath: config.codex?.codexPath ?? undefined, childPath: config.codex?.childPath ?? undefined }),
    claude: new ClaudeAdapter({ claudePath: config.claude?.claudePath ?? "claude", childPath: config.claude?.childPath ?? undefined }),
  };
}

// ---------------------------------------------------------------------------
// Event sink: sanitize, cap, sequence, batch
// ---------------------------------------------------------------------------

export class EventSink {
  constructor({ client, attemptId, leaseEpoch, redactor, logger, flushMs = 1000, maxEvents = 2000, onLeaseLost }) {
    Object.assign(this, { client, attemptId, leaseEpoch, redactor, logger, flushMs, maxEvents, onLeaseLost });
    this.sequence = 0;
    this.buffer = [];
    this.flushing = null;
    this.dropped = 0;
    this.closed = false;
    this.timer = setInterval(() => void this.flush(), flushMs);
    this.timer.unref?.();
  }

  push(kind, payload) {
    if (this.closed) return;
    if (this.sequence >= this.maxEvents) {
      this.dropped += 1;
      return;
    }
    const safeKind = EVENT_KINDS.has(kind) ? kind : "status";
    const event = { sequence: ++this.sequence, kind: safeKind, payload: sanitizePayload(payload ?? {}, this.redactor) };
    if (this.sequence === this.maxEvents) event.payload = { ...event.payload, eventLimitReached: true };
    this.buffer.push(event);
    if (this.buffer.length >= LIMITS.maxAgentEventsPerRequest) void this.flush();
  }

  flush() {
    if (this.flushing) return this.flushing.then(() => (this.buffer.length ? this.flush() : undefined));
    this.flushing = (async () => {
      while (this.buffer.length) {
        const batch = this.buffer.slice(0, LIMITS.maxAgentEventsPerRequest);
        try {
          await this.client.events(this.attemptId, this.leaseEpoch, batch);
          this.buffer.splice(0, batch.length);
        } catch (error) {
          if (error instanceof LeaseLostError) {
            this.buffer = [];
            this.closed = true;
            this.onLeaseLost?.();
          } else {
            this.logger.warn("event upload failed; will retry", { attemptId: this.attemptId, error: error.message });
          }
          break;
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

function changeSetTooLarge(change) {
  if (change.files.length > LIMITS.maxChangedFiles) return `${change.files.length} files exceed the limit of ${LIMITS.maxChangedFiles}`;
  for (const file of change.files) {
    const size = file.contentBase64 ? Buffer.byteLength(file.contentBase64, "base64") : 0;
    if (size > LIMITS.maxChangedFileBytes) return `${file.path} is ${size} bytes (limit ${LIMITS.maxChangedFileBytes})`;
  }
  if (change.totalBytes > LIMITS.maxChangeTotalBytes) return `change set is ${change.totalBytes} bytes (limit ${LIMITS.maxChangeTotalBytes})`;
  if (Buffer.byteLength(change.unifiedDiff, "utf8") > LIMITS.maxDiffBytes) return `diff exceeds ${LIMITS.maxDiffBytes} bytes`;
  return null;
}

function containsRegisteredSecret(change, redactor) {
  const haystacks = [change.unifiedDiff, ...change.files.map((file) => (file.contentBase64 ? Buffer.from(file.contentBase64, "base64").toString("latin1") : ""))];
  for (const secret of redactor.secrets) {
    if (haystacks.some((text) => text.includes(secret))) return true;
  }
  return false;
}

/**
 * Runs one claimed attempt end to end. Never throws; posts exactly one result
 * unless the lease was lost.
 * @param {NonNullable<import("../../lib/research-loop/contracts.ts").AgentClaimResponse["work"]>} work
 */
export async function runAttempt(work, ctx, { shutdownSignal } = {}) {
  const { config, client, adapters } = ctx;
  const redactor = new Redactor();
  for (const secret of ctx.baseSecrets ?? []) redactor.add(secret);
  const logger = createLogger(redactor, ctx.logWrite);
  const attemptId = work.attemptId;
  const state = { leaseLost: false, cancelReason: null, lastHeartbeatOk: Date.now(), abort: new AbortController() };
  const tests = [];
  let adapter = null;
  let adapterStarted = false;

  const requestStop = (reason) => {
    if (state.cancelReason || state.leaseLost) return;
    state.cancelReason = reason;
    state.abort.abort(new Error(reason));
    if (adapter && adapterStarted) adapter.requestCancel(attemptId).catch((error) => logger.warn("cancel failed", { attemptId, error: error.message }));
  };
  const onLeaseLost = () => {
    if (state.leaseLost) return;
    state.leaseLost = true;
    logger.warn("lease lost; stopping attempt", { attemptId });
    state.abort.abort(new Error("lease lost"));
    if (adapter && adapterStarted) adapter.requestCancel(attemptId).catch(() => {});
  };

  const sink = new EventSink({
    client, attemptId, leaseEpoch: work.leaseEpoch, redactor, logger,
    flushMs: config.eventFlushMs ?? 1000,
    maxEvents: config.limits?.maxEventsPerAttempt ?? 2000,
    onLeaseLost,
  });

  const heartbeatMs = (config.heartbeatSeconds ?? 30) * 1000;
  let heartbeatInFlight = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatInFlight || state.leaseLost) return;
    heartbeatInFlight = true;
    try {
      const response = await client.heartbeat(attemptId, work.leaseEpoch);
      state.lastHeartbeatOk = Date.now();
      if (response?.cancelRequested && !state.cancelReason) {
        sink.push("status", { phase: "cancel_requested_by_platform" });
        requestStop("platform");
      }
    } catch (error) {
      if (error instanceof LeaseLostError) onLeaseLost();
      else {
        logger.warn("heartbeat failed", { attemptId, error: error.message });
        // Without a renewed lease the platform will expire the attempt; stop.
        if (Date.now() - state.lastHeartbeatOk > LIMITS.leaseSeconds * 1000) onLeaseLost();
      }
    } finally {
      heartbeatInFlight = false;
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const onShutdown = () => requestStop("shutdown");
  shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

  let workspace = null;
  let releaseLock = null;
  let result = { outcome: "failed", errorCode: "WORKER_ERROR", errorMessage: "attempt did not complete", files: [], unifiedDiff: "", sdkVersion: "unknown", usage: {} };
  const startedAt = Date.now();
  let agentStartedAt = null;

  try {
    sink.push("status", { phase: "claimed", provider: work.provider, modelId: work.modelId, baseCommitSha: work.baseCommitSha, workerId: config.workerId ?? null });
    adapter = adapters[work.provider] ?? null;
    if (!adapter) throw Object.assign(new Error(`provider ${work.provider} is not available on this worker`), { code: "PROVIDER_UNSUPPORTED" });
    const capabilities = adapter.capabilities();
    sink.push("status", { phase: "adapter", capabilities });

    const policy = buildAgentPolicy(work.task, config);
    const prompt = buildPrompt({ work, policy });

    workspace = await prepareWorkspace({ work, config, workRoot: config.workRoot, redactor });
    sink.push("status", { phase: "workspace_ready", head: work.baseCommitSha });
    if (state.leaseLost) return;
    if (state.cancelReason) throw Object.assign(new Error("stopped before the agent started"), { code: "STOPPED" });

    const profile = { id: work.credentialProfileId, dir: profileDir(config.profilesDir, work.credentialProfileId) };
    sink.push("status", { phase: "waiting_for_profile" });
    releaseLock = await acquireProfileLock(config.profilesDir, work.credentialProfileId, { signal: state.abort.signal });
    if (state.leaseLost) return;

    await adapter.start({
      attemptId, workspace, baseCommitSha: work.baseCommitSha, prompt, policy,
      modelId: work.modelId, profile,
      registerSecret: (value) => redactor.add(value),
    });
    adapterStarted = true;
    agentStartedAt = Date.now();
    if (state.cancelReason || state.leaseLost) await adapter.requestCancel(attemptId);
    sink.push("status", { phase: "agent_started", maxAgentMinutes: policy.maxAgentMinutes, maxTurns: policy.maxTurns });

    // Budget (T16): request cancel at the limit, give up after a grace period.
    let forceStop;
    const forced = new Promise((resolve) => {
      forceStop = resolve;
    });
    const graceMs = (config.limits?.cancelGraceSeconds ?? 20) * 1000;
    const budgetTimer = setTimeout(() => {
      sink.push("error", { code: "BUDGET_EXCEEDED", maxAgentMinutes: policy.maxAgentMinutes });
      requestStop("budget");
    }, policy.maxAgentMinutes * 60_000);
    const graceWatch = setInterval(() => {
      if (state.stopRequestedAt === undefined && (state.cancelReason || state.leaseLost)) state.stopRequestedAt = Date.now();
      if (state.stopRequestedAt !== undefined && Date.now() - state.stopRequestedAt > graceMs) forceStop("forced");
    }, Math.min(1000, Math.max(10, graceMs / 4)));

    const consume = (async () => {
      for await (const event of adapter.streamEvents(attemptId)) {
        if (event.test && tests.length < 100) {
          tests.push({ command: truncate(redactor.redact(String(event.test.command)), 1000), exitCode: event.test.exitCode, summary: truncate(redactor.redact(String(event.test.summary ?? "")), 1000) });
        }
        sink.push(event.kind, event.payload);
      }
      return "done";
    })();
    const how = await Promise.race([consume, forced]);
    clearTimeout(budgetTimer);
    clearInterval(graceWatch);

    let adapterResult;
    if (how === "forced") {
      adapterResult = { outcome: "failed", errorCode: "AGENT_UNRESPONSIVE", errorMessage: "agent did not stop after cancellation", sdkVersion: "unknown" };
      // Keep the profile locked until the stray run actually ends.
      const lock = releaseLock;
      releaseLock = null;
      adapter.result(attemptId).finally(() => lock?.());
    } else {
      adapterResult = await adapter.result(attemptId);
      await releaseLock();
      releaseLock = null;
    }
    const usage = {
      provider: work.provider,
      ...adapter.usage(attemptId),
      agentWallSeconds: Math.round((Date.now() - agentStartedAt) / 1000),
      budgetMinutes: policy.maxAgentMinutes,
    };
    result = { ...result, sdkVersion: adapterResult.sdkVersion ?? "unknown", usage };
    if (state.leaseLost) return;

    if (state.cancelReason === "budget") {
      result = { ...result, outcome: "failed", errorCode: "BUDGET_EXCEEDED", errorMessage: `agent exceeded the ${policy.maxAgentMinutes}-minute budget` };
    } else if (state.cancelReason === "shutdown") {
      result = { ...result, outcome: "failed", errorCode: "WORKER_SHUTDOWN", errorMessage: "worker shut down during the attempt" };
    } else if (state.cancelReason === "platform") {
      result = { ...result, outcome: "canceled", errorCode: undefined, errorMessage: undefined };
    } else if (adapterResult.outcome !== "completed") {
      result = { ...result, outcome: adapterResult.outcome === "canceled" ? "canceled" : "failed", errorCode: adapterResult.errorCode ?? "AGENT_FAILED", errorMessage: adapterResult.errorMessage ?? "agent run failed" };
    } else {
      const change = await adapter.collectChanges(attemptId);
      const verdict = evaluatePathPolicy(change.files.map((file) => file.path), work.task.allowedPaths ?? [], policy.protectedPaths);
      sink.push("status", { phase: "changes_collected", files: change.files.map((file) => ({ path: file.path, action: file.action })), outsideAllowed: verdict.outsideAllowed, protectedTouched: verdict.protectedTouched });
      const tooLarge = changeSetTooLarge(change);
      if (!change.files.length) {
        result = { ...result, outcome: "failed", errorCode: "NO_CHANGES", errorMessage: "the agent finished without changing any file" };
      } else if (verdict.outsideAllowed.length) {
        // T04: reject the whole change set; send no file contents.
        sink.push("error", { code: "POLICY_VIOLATION", outsideAllowed: verdict.outsideAllowed });
        result = { ...result, outcome: "failed", errorCode: "POLICY_VIOLATION", errorMessage: `changes outside allowed paths: ${verdict.outsideAllowed.slice(0, 20).join(", ")}` };
      } else if (tooLarge) {
        result = { ...result, outcome: "failed", errorCode: "CHANGE_TOO_LARGE", errorMessage: tooLarge };
      } else if (containsRegisteredSecret(change, redactor)) {
        sink.push("error", { code: "SECRET_IN_CHANGES" });
        result = { ...result, outcome: "failed", errorCode: "SECRET_IN_CHANGES", errorMessage: "a worker credential appeared in the changed files" };
      } else {
        // T05: protected paths are allowed through; the platform flags extra review.
        if (verdict.protectedTouched.length) sink.push("status", { phase: "protected_paths_touched", paths: verdict.protectedTouched });
        result = { ...result, outcome: "change_ready", errorCode: undefined, errorMessage: undefined, files: change.files, unifiedDiff: change.unifiedDiff };
      }
    }
  } catch (error) {
    if (state.leaseLost) return;
    const code = state.cancelReason === "platform"
      ? null
      : state.cancelReason === "shutdown" ? "WORKER_SHUTDOWN"
        : state.cancelReason === "budget" ? "BUDGET_EXCEEDED"
          : typeof error.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : "WORKER_ERROR";
    result = code
      ? { ...result, outcome: "failed", errorCode: code, errorMessage: error.message }
      : { ...result, outcome: "canceled", errorCode: undefined, errorMessage: undefined };
    logger.error("attempt failed", { attemptId, code, error: error.message });
  } finally {
    clearInterval(heartbeat);
    shutdownSignal?.removeEventListener("abort", onShutdown);
    if (releaseLock) await releaseLock().catch(() => {});
    try {
      if (!state.leaseLost) {
        sink.push("status", { phase: "result", outcome: result.outcome, errorCode: result.errorCode ?? null, tests: tests.length });
        await sink.close();
      } else {
        await sink.close().catch(() => {});
      }
      if (!state.leaseLost) await postResult(work, result, tests, { client, redactor, logger, startedAt });
    } finally {
      if (adapter && adapterStarted) adapter.release?.(attemptId);
      if (workspace && !config.keepWorkspaces) await removeWorkspace(workspace.root).catch(() => {});
    }
  }
}

async function postResult(work, result, tests, { client, redactor, logger, startedAt }) {
  /** @type {import("../../lib/research-loop/contracts.ts").AgentResultRequest} */
  const request = {
    action: "result",
    attemptId: work.attemptId,
    leaseEpoch: work.leaseEpoch,
    outcome: result.outcome,
    modelId: work.modelId,
    sdkVersion: result.sdkVersion ?? "unknown",
    files: result.outcome === "change_ready" ? result.files : [],
    unifiedDiff: result.outcome === "change_ready" ? result.unifiedDiff : "",
    tests,
    usage: sanitizePayload({ ...result.usage, attemptWallSeconds: Math.round((Date.now() - startedAt) / 1000) }, redactor),
  };
  if (result.errorCode) request.errorCode = result.errorCode;
  if (result.errorMessage) request.errorMessage = truncate(redactor.redact(String(result.errorMessage)), 1000);
  try {
    await client.result(request);
    logger.info("result posted", { attemptId: work.attemptId, outcome: request.outcome, errorCode: request.errorCode ?? null, files: request.files.length });
  } catch (error) {
    if (error instanceof LeaseLostError) logger.warn("lease lost before result; dropping it", { attemptId: work.attemptId });
    else logger.error("posting result failed", { attemptId: work.attemptId, error: error.message });
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runWorker(ctx, { signal } = {}) {
  const { client, config } = ctx;
  const logger = createLogger(new Redactor().add(ctx.baseSecrets?.[0]), ctx.logWrite);
  const pollMs = (config.pollSeconds ?? 15) * 1000;
  const maxConcurrent = Math.max(1, config.maxConcurrentAttempts ?? 1);
  const running = new Set();
  const sleep = (ms) => delay(ms, undefined, { signal }).catch(() => {});
  while (!signal?.aborted) {
    if (running.size >= maxConcurrent) {
      await Promise.race([...running]);
      continue;
    }
    let claim;
    try {
      claim = await client.claim();
    } catch (error) {
      logger.warn("claim failed", { error: error.message });
      await sleep(pollMs);
      continue;
    }
    if (!claim?.work) {
      await sleep(pollMs);
      continue;
    }
    logger.info("claimed attempt", { attemptId: claim.work.attemptId, provider: claim.work.provider });
    const task = runAttempt(claim.work, ctx, { shutdownSignal: signal })
      .catch((error) => logger.error("attempt crashed", { error: error.message }))
      .finally(() => running.delete(task));
    running.add(task);
  }
  await Promise.allSettled([...running]);
}

async function main(argv) {
  const index = argv.indexOf("--config");
  const configPath = index >= 0 ? argv[index + 1] : process.env.AGENT_WORKER_CONFIG;
  if (!configPath) throw new Error("usage: worker.mjs --config <config.json>");
  const config = await loadConfig(configPath);
  const workerToken = await readWorkerToken(config);
  const client = createPlatformClient({ platformUrl: config.platformUrl, workerToken });
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => controller.abort());
  await runWorker({ config, client, adapters: createAdapters(config), baseSecrets: [workerToken] }, { signal: controller.signal });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ level: "error", message: String(error?.message ?? error) })}\n`);
    process.exit(1);
  });
}
