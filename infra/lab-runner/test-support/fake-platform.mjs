// Test-only fake of POST /api/lab/runs (spec §6.3) with a scripted state
// machine. It is a simulation: no Worker, no D1.
import { createServer } from "node:http";

export async function startFakePlatform({ token }) {
  const queue = [];
  const runs = new Map();
  const requests = [];
  const leaseLostOn = []; // predicates (body) => boolean, consumed once
  let epochCounter = 0;

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const reply = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method !== "POST" || request.url !== "/api/lab/runs") return reply(404, { error: "not found" });
    if (request.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "unauthorized" });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: "bad json" });
    }
    requests.push({ ...body, rawBytes: raw.length });

    if (body.action === "claim") {
      const next = queue.shift();
      if (!next) return reply(200, { work: null });
      epochCounter += 1;
      const work = { ...next, leaseEpoch: epochCounter, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() };
      const run = runs.get(work.runId) ?? { cancelRequested: false, status: "dispatching" };
      run.leaseEpoch = work.leaseEpoch;
      run.status = work.mode === "reconcile" ? "reconciling" : "dispatching";
      runs.set(work.runId, run);
      return reply(200, { work });
    }

    const run = runs.get(body.runId);
    const lostIndex = leaseLostOn.findIndex((predicate) => predicate(body));
    if (lostIndex >= 0) {
      leaseLostOn.splice(lostIndex, 1);
      if (run) run.leaseEpoch = -1;
    }
    if (!run || run.leaseEpoch !== body.leaseEpoch) return reply(409, { code: "LEASE_LOST", error: "lease lost" });

    if (body.action === "heartbeat") {
      // Like the real platform: a run awaiting reconcile accepts no heartbeat.
      if (run.status === "reconciling") return reply(409, { code: "RECONCILE_REQUIRED", error: "reconcile first" });
      if (["dispatching", "running", "collecting"].includes(body.phase) && run.status !== "cancel_requested") run.status = body.phase;
      return reply(200, { leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), cancelRequested: run.cancelRequested });
    }
    if (body.action === "reconcile") {
      if (run.status !== "reconciling") return reply(409, { code: "NOT_RECONCILING", error: "not reconciling" });
      if (body.found) {
        const map = { pending: "running", running: "running", finished: "collecting", failed: "failed", canceled: "canceled", unknown: "reconciling" };
        run.status = map[body.schedulerState] ?? "reconciling";
        if (run.status === "running" && run.cancelRequested) run.status = "cancel_requested";
      } else {
        run.status = run.cancelRequested ? "canceled" : "dispatching";
      }
      // ComputeReconcileResponse (lib/research-loop/contracts.ts).
      return reply(200, { status: run.status, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), cancelRequested: run.cancelRequested });
    }
    if (body.action === "complete") {
      run.status = body.outcome;
      run.completed = body;
      return reply(200, { ok: true });
    }
    return reply(400, { error: "unknown action" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    runs,
    enqueue(work) { queue.push(work); },
    requestCancel(runId) { runs.get(runId).cancelRequested = true; },
    /** Next matching mutating request answers 409 LEASE_LOST and fences the run. */
    loseLeaseWhen(predicate) { leaseLostOn.push(predicate); },
    requestsFor(runId, action) { return requests.filter((entry) => entry.runId === runId && (!action || entry.action === action)); },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}
