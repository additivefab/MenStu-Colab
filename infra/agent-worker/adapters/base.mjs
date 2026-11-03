// AgentAdapter (design pack 02 §4), JS form:
//   capabilities()                       -> AdapterCapabilities
//   start(input)                         -> Promise<void>; begins the run
//   streamEvents(attemptId)              -> AsyncIterable<{kind, payload, test?}>
//                                           ends with {kind:"status", payload:{phase:"finished", outcome}}
//   requestCancel(attemptId)             -> Promise<{accepted: boolean}>
//   resume(attemptId, approvedContext)   -> rejects UnsupportedError when not supported
//   collectChanges(attemptId)            -> {files, unifiedDiff, totalBytes} vs base commit
//   usage(attemptId)                     -> provider usage object
//   result(attemptId)                    -> Promise<{outcome, errorCode?, errorMessage?, sdkVersion}>
//   finalMessage(attemptId)              -> last assistant/final message text ("" if none);
//                                           the plan in plan mode (FB2)
//
// start() input: {attemptId, workspace, baseCommitSha, prompt, policy,
// modelId, profile: {id, dir}, registerSecret(value)}. Adapters must register
// every credential they read so the worker can redact it. policy.mode ===
// "plan" (policy.sandbox === "read-only") means the run must not be able to
// write: each adapter maps it to its own read-only mechanism.

import { collectChanges } from "../workspace.mjs";

export class UnsupportedError extends Error {
  constructor(operation, provider) {
    super(`${operation} is not supported by the ${provider} adapter`);
    this.name = "UnsupportedError";
    this.code = "UNSUPPORTED";
    this.operation = operation;
  }
}

export class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** True when `command` starts with one of the configured test prefixes.
 * Only these commands are reported as tests; all commands still appear as
 * tool events. */
export function matchTestCommand(command, prefixes) {
  if (typeof command !== "string") return false;
  // Codex reports commands wrapped as `bash -lc '<cmd>'`; unwrap that form.
  const unwrapped = command.replace(/^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/, "$2").trim();
  return prefixes.some((prefix) => unwrapped === prefix || unwrapped.startsWith(`${prefix} `));
}

export class BaseAdapter {
  constructor(provider) {
    this.provider = provider;
    this.runs = new Map();
  }

  capabilities() {
    throw new Error("capabilities() not implemented");
  }

  async start(input) {
    if (this.runs.has(input.attemptId)) throw new Error(`attempt ${input.attemptId} already started`);
    const state = {
      input,
      queue: new AsyncQueue(),
      abort: new AbortController(),
      usage: {},
      sdkVersion: "unknown",
      cancelRequested: false,
      finalMessage: "",
    };
    this.runs.set(input.attemptId, state);
    const emit = (kind, payload, extra = {}) => {
      // The agent's last assistant/final text is its answer (the plan in plan mode).
      if (kind === "message" && (payload?.role === "assistant" || payload?.role === "final") && typeof payload.text === "string" && payload.text.trim()) {
        state.finalMessage = payload.text;
      }
      state.queue.push({ kind, payload, ...extra });
    };
    state.done = (async () => {
      let result;
      try {
        result = await this.run(state, emit);
      } catch (error) {
        result = state.cancelRequested
          ? { outcome: "canceled" }
          : { outcome: "failed", errorCode: error.code ?? "AGENT_FAILED", errorMessage: error.message };
      }
      if (state.cancelRequested && result.outcome !== "failed") result = { ...result, outcome: "canceled" };
      emit("status", { phase: "finished", outcome: result.outcome, ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
      state.queue.close();
      return { ...result, sdkVersion: state.sdkVersion };
    })();
  }

  /** Subclasses implement the provider run. Returns {outcome, errorCode?, errorMessage?}. */
  async run() {
    throw new Error("run() not implemented");
  }

  state(attemptId) {
    const state = this.runs.get(attemptId);
    if (!state) throw new Error(`unknown attempt ${attemptId}`);
    return state;
  }

  streamEvents(attemptId) {
    return this.state(attemptId).queue;
  }

  async requestCancel(attemptId) {
    const state = this.runs.get(attemptId);
    if (!state) return { accepted: false };
    state.cancelRequested = true;
    await this.cancel(state);
    return { accepted: true };
  }

  /** Default cancel: abort the run's signal. */
  async cancel(state) {
    state.abort.abort(new Error("cancel requested"));
  }

  async resume() {
    throw new UnsupportedError("resume", this.provider);
  }

  async collectChanges(attemptId) {
    const { input } = this.state(attemptId);
    return collectChanges(input.workspace, input.baseCommitSha);
  }

  usage(attemptId) {
    return { ...this.state(attemptId).usage };
  }

  result(attemptId) {
    return this.state(attemptId).done;
  }

  finalMessage(attemptId) {
    return this.state(attemptId).finalMessage;
  }

  release(attemptId) {
    this.runs.delete(attemptId);
  }
}
