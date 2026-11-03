// Codex adapter on @openai/codex-sdk (verified against the 0.166.0 typings):
//   new Codex({ env, config, codexPathOverride })   env replaces process.env
//   codex.startThread({ model, sandboxMode, workingDirectory, skipGitRepoCheck,
//                       networkAccessEnabled, webSearchMode, approvalPolicy })
//   thread.runStreamed(input, { signal }) -> { events: AsyncGenerator<ThreadEvent> }
// Auth: ChatGPT sign-in cache in CODEX_HOME=<profile>/codex (auth.json, file
// store). Codex refreshes and rewrites auth.json in place during runs, so the
// directory is persistent and runs on one profile are serialized by the worker.

import { createRequire } from "node:module";
import path from "node:path";

import { assertPrivateDir, assertPrivateFile } from "../profiles.mjs";
import { BaseAdapter, matchTestCommand } from "./base.mjs";

const tail = (text, max = 2000) => (typeof text === "string" && text.length > max ? `…${text.slice(-max)}` : text ?? "");

function sdkPackageVersion() {
  try {
    const require = createRequire(import.meta.url);
    return `@openai/codex-sdk@${require("@openai/codex-sdk/package.json").version}`;
  } catch {
    return "@openai/codex-sdk@unknown";
  }
}

/** Child environment: an explicit allowlist; nothing else from the worker's
 * environment (worker token, other profiles) reaches Codex. */
export function buildCodexEnv({ codexHome, homeDir, tmpDir, childPath }) {
  return {
    PATH: childPath ?? process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeDir,
    TMPDIR: tmpDir,
    LANG: "C.UTF-8",
    CODEX_HOME: codexHome,
  };
}

/** Thread options: workspace-write sandbox rooted at the checkout, no
 * network, no web search, never ask for approval (nobody can answer). */
export function buildThreadOptions({ modelId, workspaceDir }) {
  return {
    ...(modelId ? { model: modelId } : {}),
    sandboxMode: "workspace-write",
    workingDirectory: workspaceDir,
    skipGitRepoCheck: false,
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  };
}

/** --config overrides: do not auto-inject AGENTS.md as instructions (the
 * prompt tells the agent to treat it as task material), keep credentials in
 * the file store under CODEX_HOME, and do not write session history. */
export const CODEX_CONFIG_OVERRIDES = Object.freeze({
  project_doc_max_bytes: 0,
  cli_auth_credentials_store: "file",
  history: { persistence: "none" },
});

export class CodexAdapter extends BaseAdapter {
  /** @param {{loadSdk?: () => Promise<any>, codexPath?: string, childPath?: string}} options */
  constructor({ loadSdk, codexPath, childPath } = {}) {
    super("codex");
    this.loadSdk = loadSdk ?? (() => import("@openai/codex-sdk"));
    this.codexPath = codexPath;
    this.childPath = childPath;
  }

  capabilities() {
    // resume: the SDK has resumeThread(), but this adapter does not implement
    // resuming with approved context, so it reports false and rejects.
    return { provider: "codex", streaming: true, cancel: true, resume: false, toolApproval: false, structuredResult: false, usage: true };
  }

  async run(state, emit) {
    const { input } = state;
    const codexHome = path.join(input.profile.dir, "codex");
    await assertPrivateDir(codexHome);
    await assertPrivateFile(path.join(codexHome, "auth.json"));

    const sdk = await this.loadSdk();
    state.sdkVersion = sdk.version ? `@openai/codex-sdk@${sdk.version}` : sdkPackageVersion();
    const codex = new sdk.Codex({
      env: buildCodexEnv({ codexHome, homeDir: input.workspace.homeDir, tmpDir: input.workspace.tmpDir, childPath: this.childPath }),
      config: CODEX_CONFIG_OVERRIDES,
      ...(this.codexPath ? { codexPathOverride: this.codexPath } : {}),
    });
    const thread = codex.startThread(buildThreadOptions({ modelId: input.modelId, workspaceDir: input.workspace.repoDir }));
    const { events } = await thread.runStreamed(input.prompt, { signal: state.abort.signal });

    let failure = null;
    for await (const event of events) {
      const mapped = mapCodexEvent(event, input.policy.testCommandPrefixes);
      if (event.type === "turn.completed" && event.usage) state.usage = normalizeCodexUsage(event.usage);
      if (event.type === "turn.failed") failure = { errorCode: "AGENT_FAILED", errorMessage: event.error?.message ?? "turn failed" };
      if (event.type === "error") failure = { errorCode: "AGENT_FAILED", errorMessage: event.message ?? "stream error" };
      for (const item of mapped) emit(item.kind, item.payload, item.test ? { test: item.test } : {});
    }
    if (state.cancelRequested) return { outcome: "canceled" };
    return failure ? { outcome: "failed", ...failure } : { outcome: "completed" };
  }
}

export function normalizeCodexUsage(usage) {
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    cacheWriteInputTokens: usage.cache_write_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
  };
}

/** Maps one Codex ThreadEvent to zero or more AgentEvent drafts. */
export function mapCodexEvent(event, testPrefixes = []) {
  switch (event?.type) {
    case "thread.started":
      return [{ kind: "status", payload: { phase: "thread_started", threadId: event.thread_id ?? null } }];
    case "turn.started":
      return [{ kind: "status", payload: { phase: "turn_started" } }];
    case "turn.completed":
      return [{ kind: "usage", payload: normalizeCodexUsage(event.usage ?? {}) }];
    case "turn.failed":
      return [{ kind: "error", payload: { code: "TURN_FAILED", message: event.error?.message ?? "" } }];
    case "error":
      return [{ kind: "error", payload: { code: "STREAM_ERROR", message: event.message ?? "" } }];
    case "item.started":
    case "item.updated":
    case "item.completed":
      return mapCodexItem(event.type, event.item ?? {}, testPrefixes);
    default:
      return [];
  }
}

function mapCodexItem(phase, item, testPrefixes) {
  const completed = phase === "item.completed";
  switch (item.type) {
    case "agent_message":
      return completed ? [{ kind: "message", payload: { role: "assistant", text: item.text ?? "" } }] : [];
    case "command_execution": {
      if (phase === "item.started") return [{ kind: "tool_call", payload: { tool: "shell", itemId: item.id, command: item.command ?? "" } }];
      if (!completed) return [];
      const out = [{ kind: "tool_result", payload: { tool: "shell", itemId: item.id, command: item.command ?? "", status: item.status ?? null, exitCode: item.exit_code ?? null, output: tail(item.aggregated_output) } }];
      // Report as a test only when the CLI recorded a real exit code.
      if (Number.isInteger(item.exit_code) && matchTestCommand(item.command, testPrefixes)) {
        const test = { command: item.command, exitCode: item.exit_code, summary: tail(item.aggregated_output, 500) };
        out.push({ kind: "test", payload: test, test });
      }
      return out;
    }
    case "file_change":
      return completed ? [{ kind: "file_change", payload: { status: item.status ?? null, changes: (item.changes ?? []).map((change) => ({ path: change.path, kind: change.kind })) } }] : [];
    case "mcp_tool_call":
      return completed
        ? [{ kind: "tool_result", payload: { tool: `mcp:${item.server}/${item.tool}`, status: item.status ?? null, error: item.error?.message ?? null } }]
        : phase === "item.started" ? [{ kind: "tool_call", payload: { tool: `mcp:${item.server}/${item.tool}` } }] : [];
    case "web_search":
      return phase === "item.started" ? [{ kind: "tool_call", payload: { tool: "web_search", query: item.query ?? "" } }] : [];
    case "todo_list":
      return completed || phase === "item.updated" ? [{ kind: "status", payload: { phase: "plan", items: (item.items ?? []).map((todo) => ({ text: todo.text, completed: Boolean(todo.completed) })) } }] : [];
    case "error":
      return [{ kind: "error", payload: { code: "ITEM_ERROR", message: item.message ?? "" } }];
    default:
      // reasoning summaries are not forwarded.
      return [];
  }
}
