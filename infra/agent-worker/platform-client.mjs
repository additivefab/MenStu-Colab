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
  /** status 0 = no (complete) HTTP answer: network error, timeout, reset. */
  constructor(status, code, message) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.code = code;
  }
}

/**
 * How a failed platform call is handled (R04):
 * - "lease_lost": 409 LEASE_LOST. Definitive: the lease moved on; never resend.
 * - "transient": no answer, 408/425/429, 5xx, and 401/403 (credentials an
 *   operator can fix). Retry later; nothing is dropped.
 * - "rejected": any other 4xx (validation). Definitive; keep for an operator.
 */
export function classifyPlatformError(error) {
  if (error instanceof LeaseLostError) return "lease_lost";
  if (!(error instanceof PlatformError)) return "transient";
  const { status } = error;
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
  if (status === 401 || status === 403) return "transient";
  if (status >= 400) return "rejected";
  return "transient";
}

/** Exponential backoff with jitter in [ceiling/2, ceiling], ceiling capped at maxDelayMs. */
export function backoffDelay(attempt, { baseDelayMs = 1000, maxDelayMs = 30_000, random = Math.random } = {}) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs fn(attempt) up to `attempts` times while it fails with a transient
 * error. Definitive errors (lease lost, rejected), the last transient error,
 * and any error after `signal` aborts are rethrown.
 */
export async function retryTransient(fn, { attempts = 5, baseDelayMs = 1000, maxDelayMs = 30_000, signal, onRetry } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (classifyPlatformError(error) !== "transient" || attempt >= attempts || signal?.aborted) throw error;
      const delayMs = backoffDelay(attempt, { baseDelayMs, maxDelayMs });
      onRetry?.(error, attempt, delayMs);
      await abortableSleep(delayMs, signal);
      if (signal?.aborted) throw error;
    }
  }
}

export function createPlatformClient({ platformUrl, workerToken, fetchImpl = fetch, timeoutMs = 30_000 }) {
  if (!platformUrl) throw new Error("platformUrl is required");
  if (!workerToken) throw new Error("worker token is required");
  const endpoint = new URL("/api/lab/agent-attempts", platformUrl).toString();

  async function call(body) {
    let response;
    let text;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      // The request may or may not have been processed. Callers retry; the
      // platform answers a same-epoch result replay with the stored result.
      throw new PlatformError(0, "NETWORK", `platform ${body.action} got no answer (${String(error?.cause?.code ?? error?.name ?? "error")})`);
    }
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
