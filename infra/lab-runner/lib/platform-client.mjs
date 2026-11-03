// Client for POST /api/lab/runs (spec §6.3). Outbound HTTPS only (D4).

export class LeaseLostError extends Error {
  constructor(runId) {
    super(`lease lost for ${runId}`);
    this.code = "LEASE_LOST";
  }
}

export class PlatformError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function createPlatformClient({ platformUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
  const endpoint = new URL("/api/lab/runs", platformUrl).href;

  async function post(body) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (response.status === 409 && payload?.code === "LEASE_LOST") throw new LeaseLostError(body.runId ?? "");
    if (!response.ok) {
      const detail = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new PlatformError(`${body.action} rejected: ${detail}`, response.status, payload);
    }
    return payload ?? {};
  }

  return {
    /** @returns {Promise<import("../../../lib/research-loop/contracts.ts").ComputeClaimResponse>} */
    claim: () => post({ action: "claim" }),
    heartbeat: (request) => post({ action: "heartbeat", ...request }),
    reconcile: (request) => post({ action: "reconcile", ...request }),
    complete: (request) => post({ action: "complete", ...request }),
  };
}
