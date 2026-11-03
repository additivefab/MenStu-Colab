// Unit tests for the durable result outbox (R04) and the platform client's
// retry classification. Worker-level scenarios live in worker.test.mjs.

import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { deliverEntry, Outbox, payloadSha256, replayOutbox, resolveOutboxConfig } from "./outbox.mjs";
import {
  backoffDelay, classifyPlatformError, createPlatformClient, LeaseLostError, PlatformError, retryTransient,
} from "./platform-client.mjs";
import { captureLogs, tempDir } from "./test-support/harness.mjs";
import { createLogger, Redactor } from "./sanitize.mjs";

const payload = (attemptId = "att_1", leaseEpoch = 2, extra = {}) => ({ action: "result", attemptId, leaseEpoch, outcome: "failed", errorCode: "AGENT_FAILED", files: [], ...extra });

async function makeOutbox(t) {
  const root = await tempDir(t, "agent-outbox-");
  const logs = captureLogs();
  return { root, outbox: new Outbox(path.join(root, "outbox")), logs, logger: createLogger(new Redactor(), logs.write) };
}

const clientReturning = (fn) => ({ result: async (request) => fn(request) });

test("put writes the entry atomically: 0600 file in 0700 dirs, sha256 of the payload, no temp files left", async (t) => {
  const { outbox } = await makeOutbox(t);
  const entry = await outbox.put({ attemptId: "att_1", leaseEpoch: 2, payload: payload(), workspaceRoot: "/w/att_1", now: new Date("2026-11-01T00:00:00Z") });
  assert.equal(path.basename(entry.file), "att_1.2.json");
  const stored = JSON.parse(await readFile(entry.file, "utf8"));
  assert.deepEqual(Object.keys(stored), ["schema", "attemptId", "leaseEpoch", "createdAt", "sha256", "workspaceRoot", "payload"]);
  assert.equal(stored.createdAt, "2026-11-01T00:00:00.000Z");
  assert.equal(stored.sha256, payloadSha256(payload()));
  assert.equal((await stat(entry.file)).mode & 0o777, 0o600);
  for (const dir of [outbox.dir, outbox.pendingDir, outbox.deadDir]) assert.equal((await stat(dir)).mode & 0o777, 0o700, dir);
  assert.deepEqual(await readdir(outbox.pendingDir), ["att_1.2.json"]);
  const { entries } = await outbox.list();
  assert.deepEqual(entries.map((item) => item.payload), [payload()]);
});

test("put refuses ids that could escape the outbox directory", async (t) => {
  const { outbox } = await makeOutbox(t);
  await assert.rejects(outbox.put({ attemptId: "../evil", leaseEpoch: 1, payload: payload("../evil", 1) }), /invalid attemptId/);
  await assert.rejects(outbox.put({ attemptId: "att_1", leaseEpoch: 1.5, payload: payload("att_1", 1.5) }), /invalid leaseEpoch/);
});

test("a tampered or unreadable pending entry is never sent; replay moves it to dead/ for an operator", async (t) => {
  const { outbox, logger, logs } = await makeOutbox(t);
  const entry = await outbox.put({ attemptId: "att_1", leaseEpoch: 2, payload: payload() });
  const stored = JSON.parse(await readFile(entry.file, "utf8"));
  stored.payload.outcome = "change_ready";
  await writeFile(entry.file, JSON.stringify(stored));
  await writeFile(path.join(outbox.pendingDir, "att_2.1.json"), "{not json");
  const sent = [];
  const summary = await replayOutbox({ outbox, client: clientReturning((request) => sent.push(request)), logger });
  assert.equal(sent.length, 0);
  assert.equal(summary.quarantined, 2);
  assert.deepEqual(await readdir(outbox.pendingDir), []);
  assert.deepEqual((await readdir(outbox.deadDir)).sort(), ["att_1.2.json.corrupt", "att_2.1.json.corrupt"]);
  assert.match(logs.text(), /unreadable outbox entry moved to dead/);
});

test("deliverEntry settles each answer: 2xx removes, 409 LEASE_LOST drops, 4xx dead-letters, 5xx keeps", async (t) => {
  const { outbox, logger } = await makeOutbox(t);
  const retry = { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 };
  const cases = [
    ["att_ok", () => ({ status: "failed", replayed: false }), "delivered", "gone"],
    ["att_replay", () => ({ status: "failed", replayed: true }), "delivered", "gone"],
    ["att_lost", () => { throw new LeaseLostError("att_lost"); }, "lease_lost", "gone"],
    ["att_bad", () => { throw new PlatformError(400, "INVALID_RESULT", "bad"); }, "dead", "dead"],
    ["att_busy", () => { throw new PlatformError(503, null, "busy"); }, "pending", "pending"],
    ["att_net", () => { throw new PlatformError(0, "NETWORK", "no answer"); }, "pending", "pending"],
  ];
  for (const [attemptId, answer, expected, where] of cases) {
    const entry = await outbox.put({ attemptId, leaseEpoch: 1, payload: payload(attemptId, 1) });
    let calls = 0;
    const delivery = await deliverEntry(entry, { outbox, logger, retry, client: clientReturning(() => { calls += 1; return answer(); }) });
    assert.equal(delivery.state, expected, attemptId);
    assert.equal(calls, expected === "pending" ? 2 : 1, `${attemptId}: retries only transient errors`);
    const pending = (await outbox.list("pending")).entries.some((item) => item.attemptId === attemptId);
    const dead = (await outbox.list("dead")).entries.find((item) => item.attemptId === attemptId);
    assert.equal(pending, where === "pending", attemptId);
    assert.equal(Boolean(dead), where === "dead", attemptId);
    if (dead) assert.deepEqual(dead.payload, payload(attemptId, 1));
  }
});

test("deliverEntry never sends the same entry twice concurrently", async (t) => {
  const { outbox, logger } = await makeOutbox(t);
  const entry = await outbox.put({ attemptId: "att_1", leaseEpoch: 1, payload: payload("att_1", 1) });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const client = clientReturning(async () => {
    calls += 1;
    await gate;
    return { replayed: false };
  });
  const first = deliverEntry(entry, { outbox, logger, client });
  const second = await deliverEntry(entry, { outbox, logger, client });
  release();
  assert.equal(second.state, "busy");
  assert.equal((await first).state, "delivered");
  assert.equal(calls, 1);
});

test("replay prunes pending and dead entries past retention, reports them and removes their workspaces", async (t) => {
  const { outbox, logger, logs } = await makeOutbox(t);
  const now = Date.parse("2026-11-20T00:00:00Z");
  const day = 86_400_000;
  await outbox.put({ attemptId: "att_old", leaseEpoch: 1, payload: payload("att_old", 1), workspaceRoot: "/w/att_old", now: new Date(now - 8 * day) });
  const dead = await outbox.put({ attemptId: "att_dead", leaseEpoch: 1, payload: payload("att_dead", 1), now: new Date(now - 30 * day) });
  await outbox.deadLetter(dead, { status: 400 });
  await outbox.put({ attemptId: "att_new", leaseEpoch: 1, payload: payload("att_new", 1), workspaceRoot: "/w/att_new", now: new Date(now - day) });
  const removed = [];
  const sent = [];
  const summary = await replayOutbox({
    outbox, logger, retentionDays: 7, now,
    client: clientReturning((request) => {
      sent.push(request.attemptId);
      return { replayed: false };
    }),
    removeWorkspace: async (entry) => removed.push(entry.workspaceRoot ?? null),
  });
  assert.deepEqual(sent, ["att_new"], "pruned entries are not sent");
  assert.equal(summary.pruned, 2);
  assert.equal(summary.delivered, 1);
  assert.deepEqual(removed.sort(), ["/w/att_new", "/w/att_old", null].sort());
  assert.deepEqual(await readdir(outbox.pendingDir), []);
  assert.deepEqual(await readdir(outbox.deadDir), []);
  const lines = logs.lines.map((line) => JSON.parse(line)).filter((line) => line.message === "outbox entry is past retention; pruning it");
  assert.deepEqual(lines.map((line) => [line.attemptId, line.state, line.ageDays]).sort(), [["att_dead", "dead", 30], ["att_old", "pending", 8]]);
});

test("platform client classifies answers: 409 LEASE_LOST, 4xx rejected, 5xx/429/408/401/network transient", async () => {
  const classify = async (respond) => {
    const client = createPlatformClient({ platformUrl: "http://127.0.0.1:9", workerToken: "t", fetchImpl: respond });
    try {
      await client.result(payload());
      return "ok";
    } catch (error) {
      return classifyPlatformError(error);
    }
  };
  const reply = (status, json) => async () => new Response(JSON.stringify(json ?? {}), { status });
  assert.equal(await classify(reply(200, { replayed: true })), "ok");
  assert.equal(await classify(reply(409, { code: "LEASE_LOST" })), "lease_lost");
  assert.equal(await classify(reply(409, { code: "INVALID_TRANSITION" })), "rejected");
  for (const status of [400, 404, 413, 422]) assert.equal(await classify(reply(status, { code: "X" })), "rejected", String(status));
  for (const status of [500, 502, 503, 429, 408, 401, 403]) assert.equal(await classify(reply(status)), "transient", String(status));
  assert.equal(await classify(async () => { throw new TypeError("fetch failed"); }), "transient");
  assert.equal(await classify(async () => ({ status: 200, ok: true, text: async () => { throw new Error("socket hang up"); } })), "transient", "a truncated response is not a confirmation");
});

test("retryTransient: bounded attempts and backoff, stops on definitive errors and on abort", async () => {
  let calls = 0;
  await assert.rejects(retryTransient(() => {
    calls += 1;
    throw new PlatformError(503, null, "busy");
  }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 }), /busy/);
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(retryTransient(() => {
    calls += 1;
    throw new PlatformError(400, "INVALID_RESULT", "bad");
  }, { attempts: 5, baseDelayMs: 1 }), /bad/);
  assert.equal(calls, 1);

  calls = 0;
  const controller = new AbortController();
  await assert.rejects(retryTransient(() => {
    calls += 1;
    controller.abort();
    throw new PlatformError(0, "NETWORK", "down");
  }, { attempts: 5, baseDelayMs: 10_000, signal: controller.signal }), /down/);
  assert.equal(calls, 1);

  for (let attempt = 1; attempt < 20; attempt += 1) {
    const delay = backoffDelay(attempt, { baseDelayMs: 1000, maxDelayMs: 30_000 });
    assert.ok(delay >= 500 && delay <= 30_000, `${attempt}: ${delay}`);
  }
  assert.equal(backoffDelay(10, { baseDelayMs: 1000, maxDelayMs: 30_000, random: () => 1 }), 30_000);
});

test("outbox settings default under the worker state dir and resolve relative to the config file", async (t) => {
  const defaults = resolveOutboxConfig({ workRoot: "/var/lib/tanyan-agent-worker/work" });
  assert.equal(defaults.dir, "/var/lib/tanyan-agent-worker/outbox");
  assert.deepEqual({ ...defaults, dir: undefined }, { dir: undefined, retentionDays: 14, replaySeconds: 60, attempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000 });
  assert.equal(resolveOutboxConfig({ workRoot: "/w/work", stateDir: "/srv/state" }).dir, "/srv/state/outbox");

  const { loadConfig } = await import("./worker.mjs");
  const root = await tempDir(t);
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ platformUrl: "https://p.example", workRoot: "work", profilesDir: "profiles", stateDir: "state", outbox: { dir: "box", retentionDays: 3 } }));
  const config = await loadConfig(configPath);
  assert.equal(config.stateDir, path.join(root, "state"));
  assert.equal(resolveOutboxConfig(config).dir, path.join(root, "box"));
  assert.equal(resolveOutboxConfig(config).retentionDays, 3);
});
