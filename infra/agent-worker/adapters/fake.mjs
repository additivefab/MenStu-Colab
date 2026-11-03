// Test adapter. A script function plays the agent: it edits files in the
// workspace, emits events, and can wait for cancellation. Records every
// start() input so tests can assert what the adapter was given.

import { BaseAdapter } from "./base.mjs";

export class FakeAdapter extends BaseAdapter {
  /** @param {{provider?: string, script?: (ctx) => Promise<object|void>, ignoreCancel?: boolean}} options */
  constructor({ provider = "codex", script = async () => {}, ignoreCancel = false } = {}) {
    super(provider);
    this.script = script;
    this.ignoreCancel = ignoreCancel;
    this.received = [];
    this.cancelCalls = [];
  }

  capabilities() {
    return { provider: this.provider, streaming: true, cancel: !this.ignoreCancel, resume: false, toolApproval: false, structuredResult: false, usage: true };
  }

  async cancel(state) {
    this.cancelCalls.push(state.input.attemptId);
    if (!this.ignoreCancel) state.abort.abort(new Error("cancel requested"));
  }

  async run(state, emit) {
    const { input } = state;
    this.received.push({ attemptId: input.attemptId, prompt: input.prompt, policy: input.policy, modelId: input.modelId, profile: input.profile, workspaceDir: input.workspace.repoDir });
    state.sdkVersion = "fake-0";
    const ctx = {
      workspaceDir: input.workspace.repoDir,
      input,
      signal: state.abort.signal,
      emit,
      test: (command, exitCode, summary = "") => emit("test", { command, exitCode, summary }, { test: { command, exitCode, summary } }),
      setUsage: (usage) => {
        state.usage = usage;
      },
      waitForCancel: () => new Promise((resolve) => {
        if (state.abort.signal.aborted) resolve();
        else state.abort.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    const result = await this.script(ctx);
    if (state.abort.signal.aborted) return { outcome: "canceled" };
    return result ?? { outcome: "completed" };
  }
}
