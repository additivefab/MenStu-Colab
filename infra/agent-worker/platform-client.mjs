// Client for POST /api/lab/agent-attempts (spec §6.1). Every call carries
// `action`; the platform answers 409 {code:"LEASE_LOST"} when the lease epoch
// no longer matches, which the worker treats as "stop working on it now".

export class LeaseLostError extends Error {
  constructor(attemptId) {
    super(`lease lost for attempt ${attemptId}`);
    this.name = "LeaseLostError";
    this.code = "LEASE_LOST";
    this.attemptId = attemptId;
  }
}

export class PlatformError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.code = code;
  }
}

export function createPlatformClient({ platformUrl, workerToken, fetchImpl = fetch, timeoutMs = 30_000 }) {
  if (!platformUrl) throw new Error("platformUrl is required");
  if (!workerToken) throw new Error("worker token is required");
  const endpoint = new URL("/api/lab/agent-attempts", platformUrl).toString();

  async function call(body) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status === 409 && json?.code === "LEASE_LOST") throw new LeaseLostError(body.attemptId);
    if (!response.ok) {
      // Never echo the request body: it can contain file contents.
      throw new PlatformError(response.status, json?.code ?? null, `platform ${body.action} failed with HTTP ${response.status}${json?.error ? `: ${String(json.error).slice(0, 200)}` : ""}`);
    }
    return json ?? {};
  }

  return {
    /** @returns {Promise<import("../../lib/research-loop/contracts.ts").AgentClaimResponse>} */
    claim: () => call({ action: "claim" }),
    /** @returns {Promise<import("../../lib/research-loop/contracts.ts").AgentHeartbeatResponse>} */
    heartbeat: (attemptId, leaseEpoch) => call({ action: "heartbeat", attemptId, leaseEpoch }),
    events: (attemptId, leaseEpoch, events) => call({ action: "events", attemptId, leaseEpoch, events }),
    /** @param {import("../../lib/research-loop/contracts.ts").AgentResultRequest} request */
    result: (request) => call(request),
  };
}
