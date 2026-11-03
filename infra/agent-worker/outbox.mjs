// Durable result outbox (R04). A finished attempt's result request is written
// to disk before it is sent and deleted only after the platform gave a
// definitive answer, so a network error, a lost response or a worker crash
// never loses a finished change.
//
//   <dir>/pending/<attemptId>.<leaseEpoch>.json   waiting for a definitive answer
//   <dir>/dead/<attemptId>.<leaseEpoch>.json      rejected (4xx) or corrupt; kept for an operator
//
// Directories are 0700 and files 0600. Each file is written to a temp file,
// fsynced, renamed into place and the directory fsynced. The payload is the
// normalized AgentResultRequest, already redacted by the worker; it carries
// no worker token.

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { classifyPlatformError, retryTransient } from "./platform-client.mjs";

export const OUTBOX_SCHEMA = "tanyan.agent-worker.outbox/v1";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENTRY_FILE = /^([A-Za-z0-9_-]{1,128})\.(\d{1,15})\.json$/;
const DAY_MS = 86_400_000;

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
export const payloadSha256 = (payload) => sha256Hex(JSON.stringify(payload));

/** Outbox settings from the worker config (defaults under the worker state dir). */
export function resolveOutboxConfig(config) {
  const outbox = config.outbox ?? {};
  const stateDir = config.stateDir ?? path.dirname(path.resolve(config.workRoot));
  return {
    dir: outbox.dir ?? path.join(stateDir, "outbox"),
    retentionDays: outbox.retentionDays ?? 14,
    replaySeconds: outbox.replaySeconds ?? 60,
    attempts: outbox.resultAttempts ?? 5,
    baseDelayMs: outbox.retryBaseMs ?? 1000,
    maxDelayMs: outbox.retryMaxMs ?? 30_000,
  };
}

async function fsyncDir(dir) {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported everywhere; the rename is still atomic.
  } finally {
    await handle?.close();
  }
}

async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await fsyncDir(dir);
}

export class Outbox {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.pendingDir = path.join(this.dir, "pending");
    this.deadDir = path.join(this.dir, "dead");
    /** Entry files being delivered right now (no concurrent double send). */
    this.inflight = new Set();
    this.ready = null;
  }

  init() {
    this.ready ??= (async () => {
      for (const dir of [this.dir, this.pendingDir, this.deadDir]) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
      }
    })().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  /** Persists the result request durably; returns the entry. */
  async put({ attemptId, leaseEpoch, payload, workspaceRoot = null, now = new Date() }) {
    if (!SAFE_ID.test(String(attemptId))) throw new Error("outbox: invalid attemptId");
    if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 0) throw new Error("outbox: invalid leaseEpoch");
    await this.init();
    const stored = { schema: OUTBOX_SCHEMA, attemptId, leaseEpoch, createdAt: now.toISOString(), sha256: payloadSha256(payload), workspaceRoot, payload };
    const file = path.join(this.pendingDir, `${attemptId}.${leaseEpoch}.json`);
    await writeFileAtomic(file, JSON.stringify(stored));
    return { ...stored, file, state: "pending" };
  }

  async #read(file, state) {
    const stored = JSON.parse(await readFile(file, "utf8"));
    const match = ENTRY_FILE.exec(path.basename(file));
    if (stored?.schema !== OUTBOX_SCHEMA) throw new Error("unknown schema");
    if (!match || stored.attemptId !== match[1] || stored.leaseEpoch !== Number(match[2])) throw new Error("file name does not match entry");
    if (stored.payload?.attemptId !== stored.attemptId || stored.payload?.leaseEpoch !== stored.leaseEpoch) throw new Error("payload does not match entry");
    if (payloadSha256(stored.payload) !== stored.sha256) throw new Error("sha256 mismatch");
    return { ...stored, file, state };
  }

  /** Lists entries ("pending" or "dead"), oldest first; unreadable files are returned as corrupt. */
  async list(state = "pending") {
    await this.init();
    const dir = state === "dead" ? this.deadDir : this.pendingDir;
    const entries = [];
    const corrupt = [];
    for (const name of (await readdir(dir)).sort()) {
      if (name.startsWith(".tmp-")) continue;
      const file = path.join(dir, name);
      try {
        entries.push(await this.#read(file, state));
      } catch (error) {
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) corrupt.push({ file, state, error: error.message, mtimeMs: info.mtimeMs });
      }
    }
    entries.sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0));
    return { entries, corrupt };
  }

  async remove(entry) {
    if (!entry.file) return;
    await rm(entry.file, { force: true });
    await fsyncDir(path.dirname(entry.file));
  }

  /** Moves an entry to dead/ with the reason; the payload is kept for an operator. */
  async deadLetter(entry, reason, now = new Date()) {
    await this.init();
    const stored = {
      schema: OUTBOX_SCHEMA, attemptId: entry.attemptId, leaseEpoch: entry.leaseEpoch, createdAt: entry.createdAt,
      sha256: entry.sha256 ?? payloadSha256(entry.payload), workspaceRoot: entry.workspaceRoot ?? null, payload: entry.payload,
    };
    const target = path.join(this.deadDir, `${entry.attemptId}.${entry.leaseEpoch}.json`);
    await writeFileAtomic(target, JSON.stringify({ ...stored, deadLetter: { ...reason, at: now.toISOString() } }));
    await this.remove(entry);
    return { ...stored, file: target, state: "dead" };
  }

  /** Moves an unreadable pending file to dead/ (suffix .corrupt). */
  async quarantine(file) {
    await this.init();
    const target = path.join(this.deadDir, `${path.basename(file)}.corrupt`);
    await rename(file, target);
    await fsyncDir(this.deadDir);
    return target;
  }
}

const describe = (entry) => ({
  attemptId: entry.attemptId,
  leaseEpoch: entry.leaseEpoch,
  outcome: entry.payload?.outcome,
  errorCode: entry.payload?.errorCode ?? null,
  files: entry.payload?.files?.length ?? 0,
  ...(entry.payload?.plan ? { planChars: entry.payload.plan.length } : {}),
});

/**
 * Sends one entry and settles it:
 * - "delivered": 2xx (including the platform's same-epoch replay answer). Entry removed.
 * - "lease_lost": 409 LEASE_LOST, or a replay answer saying the platform already
 *   expired this lease. The stale epoch is never resent. Entry removed.
 * - "dead": other 4xx. Entry moved to dead/.
 * - "pending": no definitive answer after the retries. Entry kept for replay.
 * - "busy": another delivery of this entry is in flight.
 * @returns {Promise<{state: "delivered"|"lease_lost"|"dead"|"pending"|"busy", response?: object, error?: Error}>}
 */
export async function deliverEntry(entry, { outbox, client, logger, retry = {}, signal }) {
  const key = entry.file ?? `${entry.attemptId}.${entry.leaseEpoch}`;
  if (outbox.inflight.has(key)) return { state: "busy" };
  outbox.inflight.add(key);
  try {
    let response;
    try {
      response = await retryTransient(() => client.result(entry.payload), {
        attempts: retry.attempts ?? 5,
        baseDelayMs: retry.baseDelayMs ?? 1000,
        maxDelayMs: retry.maxDelayMs ?? 30_000,
        signal,
        onRetry: (error, attempt, delayMs) => logger.warn("result delivery failed; retrying", { attemptId: entry.attemptId, leaseEpoch: entry.leaseEpoch, attempt, delayMs, status: error.status ?? null, error: error.message }),
      });
    } catch (error) {
      const kind = classifyPlatformError(error);
      if (kind === "lease_lost") {
        await outbox.remove(entry);
        logger.warn("lease lost before result; dropping it", describe(entry));
        return { state: "lease_lost", error };
      }
      if (kind === "rejected") {
        await outbox.deadLetter(entry, { status: error.status ?? null, code: error.code ?? null, message: String(error.message).slice(0, 500) });
        logger.error("platform rejected the result; dead-lettered for an operator", { ...describe(entry), status: error.status ?? null, code: error.code ?? null });
        return { state: "dead", error };
      }
      logger.warn("result not confirmed; kept in the outbox for replay", { ...describe(entry), status: error.status ?? null, error: error.message, persisted: Boolean(entry.file) });
      return { state: "pending", error };
    }
    // The platform answers a same-epoch replay with the stored attempt. If the
    // maintenance sweep expired the lease first, our result was not recorded:
    // the lease is gone, exactly as with 409 LEASE_LOST.
    if (response?.replayed === true && response.errorCode === "LEASE_EXPIRED" && entry.payload?.errorCode !== "LEASE_EXPIRED") {
      await outbox.remove(entry);
      logger.warn("lease expired on the platform before the result arrived; dropping it", describe(entry));
      return { state: "lease_lost", response };
    }
    try {
      await outbox.remove(entry);
    } catch (error) {
      // A later replay resends it; the platform answers idempotently.
      logger.warn("result posted but the outbox entry could not be removed", { attemptId: entry.attemptId, error: error.message });
    }
    logger.info("result posted", { ...describe(entry), replayed: response?.replayed === true });
    return { state: "delivered", response };
  } finally {
    outbox.inflight.delete(key);
  }
}

/**
 * One replay pass: prune entries past retention, quarantine corrupt files,
 * then try each pending entry once more (bounded retries). `removeWorkspace`
 * is called for entries that were confirmed or pruned.
 */
export async function replayOutbox({ outbox, client, logger, retry = {}, retentionDays = 14, removeWorkspace = async () => {}, signal, now = Date.now() }) {
  const summary = { delivered: 0, leaseLost: 0, dead: 0, pending: 0, pruned: 0, quarantined: 0 };
  const cutoff = now - retentionDays * DAY_MS;
  const ageDays = (ms) => Math.floor((now - ms) / DAY_MS);

  for (const state of ["pending", "dead"]) {
    const { entries, corrupt } = await outbox.list(state);
    for (const entry of entries) {
      const created = Date.parse(entry.createdAt);
      if (!Number.isFinite(created) || created >= cutoff || outbox.inflight.has(entry.file)) continue;
      logger.error("outbox entry is past retention; pruning it", { ...describe(entry), state, createdAt: entry.createdAt, ageDays: ageDays(created), retentionDays });
      await outbox.remove(entry);
      await removeWorkspace(entry);
      summary.pruned += 1;
    }
    for (const item of corrupt) {
      if (item.mtimeMs < cutoff) {
        logger.error("unreadable outbox file is past retention; pruning it", { file: path.basename(item.file), state, ageDays: ageDays(item.mtimeMs), retentionDays });
        await rm(item.file, { force: true });
        summary.pruned += 1;
      } else if (state === "pending") {
        const target = await outbox.quarantine(item.file);
        logger.error("unreadable outbox entry moved to dead/ for an operator", { file: path.basename(target), error: item.error });
        summary.quarantined += 1;
      }
    }
  }

  const { entries } = await outbox.list("pending");
  for (const entry of entries) {
    if (signal?.aborted) break;
    const delivery = await deliverEntry(entry, { outbox, client, logger, retry, signal });
    if (delivery.state === "delivered" || delivery.state === "lease_lost") await removeWorkspace(entry);
    if (delivery.state === "delivered") summary.delivered += 1;
    else if (delivery.state === "lease_lost") summary.leaseLost += 1;
    else if (delivery.state === "dead") summary.dead += 1;
    else if (delivery.state === "pending") summary.pending += 1;
  }
  return summary;
}
