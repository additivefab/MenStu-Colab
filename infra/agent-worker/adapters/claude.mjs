// Claude adapter: headless `claude -p` with stream-json output.
// Auth: the user's own long-lived token from `claude setup-token`, read from
// <profile>/claude/oauth_token and passed ONLY as CLAUDE_CODE_OAUTH_TOKEN in
// the child environment. `--bare` is NOT used: per the docs bare mode never
// reads CLAUDE_CODE_OAUTH_TOKEN. Repository-supplied configuration is kept out
// with --safe-mode, --setting-sources user (user = the profile's own
// CLAUDE_CONFIG_DIR), --settings {"disableAllHooks":true} and
// --strict-mcp-config without --mcp-config. The prompt goes through stdin so
// it is not visible in the process list.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { assertPrivateFile, ensureClaudeConfigDir } from "../profiles.mjs";
import { BaseAdapter, matchTestCommand } from "./base.mjs";

export const CLAUDE_FILE_TOOLS = Object.freeze(["Read", "Edit", "Write", "Glob", "Grep"]);

/** Plan mode (FB2): read-only tools only. No Edit/Write and no Bash at all. */
export const CLAUDE_PLAN_TOOLS = Object.freeze(["Read", "Glob", "Grep"]);

/** Tools that can change the working tree: denied in plan mode, and the run
 * is aborted if the CLI still reports one of them at init. */
export const CLAUDE_WRITE_TOOLS = Object.freeze(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

/** Denied even when they would otherwise be available. Bash entries are
 * belt-and-braces: Bash is only auto-approved for the test prefixes anyway. */
export const CLAUDE_DENIED_TOOLS = Object.freeze([
  "WebFetch",
  "WebSearch",
  "mcp__*",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(ssh *)",
  "Bash(scp *)",
  "Bash(git push *)",
  "Bash(git remote *)",
  "Bash(git config *)",
  "Bash(pip install *)",
  "Bash(npm install *)",
]);

/** Tools that must never appear in the init message. */
const FORBIDDEN_TOOL = (name) => name === "WebFetch" || name === "WebSearch" || name.startsWith("mcp__");

const isPlanPolicy = (policy) => policy?.mode === "plan" || policy?.sandbox === "read-only";

export function buildClaudeArgs({ policy, modelId }) {
  if (isPlanPolicy(policy)) {
    return [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--safe-mode",
      "--setting-sources", "user",
      "--settings", JSON.stringify({ disableAllHooks: true }),
      "--strict-mcp-config",
      "--tools", CLAUDE_PLAN_TOOLS.join(","),
      "--allowedTools", CLAUDE_PLAN_TOOLS.join(","),
      "--disallowedTools", [...CLAUDE_WRITE_TOOLS, ...CLAUDE_DENIED_TOOLS.filter((rule) => !rule.startsWith("Bash("))].join(","),
      "--permission-mode", "dontAsk",
      "--max-turns", String(policy.maxTurns),
      "--no-session-persistence",
      ...(modelId ? ["--model", modelId] : []),
    ];
  }
  const bashRules = policy.testCommandPrefixes.flatMap((prefix) => [`Bash(${prefix})`, `Bash(${prefix} *)`]);
  const tools = [...CLAUDE_FILE_TOOLS, ...(bashRules.length ? ["Bash"] : [])];
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--safe-mode",
    "--setting-sources", "user",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    "--tools", tools.join(","),
    "--allowedTools", [...CLAUDE_FILE_TOOLS, ...bashRules].join(","),
    "--disallowedTools", CLAUDE_DENIED_TOOLS.join(","),
    "--permission-mode", "dontAsk",
    "--max-turns", String(policy.maxTurns),
    "--no-session-persistence",
    ...(modelId ? ["--model", modelId] : []),
  ];
}

/** Explicit allowlist environment. No API keys, no cloud-provider switches,
 * no worker token: only the profile's own OAuth token. */
export function buildClaudeEnv({ token, configDir, homeDir, tmpDir, childPath }) {
  return {
    PATH: childPath ?? process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeDir,
    TMPDIR: tmpDir,
    LANG: "C.UTF-8",
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block === "string" ? block : block?.text ?? "")).join("\n");
  return "";
};
const tail = (text, max = 2000) => (text.length > max ? `…${text.slice(-max)}` : text);

export class ClaudeAdapter extends BaseAdapter {
  /** @param {{claudePath?: string, childPath?: string, cancelGraceMs?: number}} options */
  constructor({ claudePath = "claude", childPath, cancelGraceMs = 5000 } = {}) {
    super("claude");
    this.claudePath = claudePath;
    this.childPath = childPath;
    this.cancelGraceMs = cancelGraceMs;
  }

  capabilities() {
    return { provider: "claude", streaming: true, cancel: true, resume: false, toolApproval: false, structuredResult: false, usage: true };
  }

  async cancel(state) {
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // SIGINT ends the turn; escalate if the CLI does not exit.
    child.kill("SIGINT");
    const term = setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), this.cancelGraceMs);
    const kill = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), this.cancelGraceMs * 2);
    term.unref();
    kill.unref();
  }

  async run(state, emit) {
    const { input } = state;
    const tokenFile = path.join(input.profile.dir, "claude", "oauth_token");
    await assertPrivateFile(tokenFile);
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (!token) throw Object.assign(new Error("oauth_token file is empty"), { code: "PROFILE_NOT_FOUND" });
    input.registerSecret(token);
    const configDir = await ensureClaudeConfigDir(path.join(input.profile.dir, "claude", "config"));

    const args = buildClaudeArgs({ policy: input.policy, modelId: input.modelId });
    const env = buildClaudeEnv({ token, configDir, homeDir: input.workspace.homeDir, tmpDir: input.workspace.tmpDir, childPath: this.childPath });
    state.sdkVersion = "claude-cli/unknown";

    const child = spawn(this.claudePath, args, { cwd: input.workspace.repoDir, env, stdio: ["pipe", "pipe", "pipe"] });
    state.child = child;
    const exit = new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("close", (code, signal) => resolve({ code, signal, error: null }));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.prompt);

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = tail(stderrTail + chunk, 4000);
    });

    const toolUses = new Map();
    let finalResult = null;
    let policyBreach = null;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        emit("message", { role: "cli", text: tail(line, 1000) });
        continue;
      }
      if (message.type === "system" && message.subtype === "init") {
        if (typeof message.claude_code_version === "string") state.sdkVersion = `claude-cli@${message.claude_code_version}`;
        const tools = Array.isArray(message.tools) ? message.tools.map(String) : [];
        const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
        const planMode = isPlanPolicy(input.policy);
        const forbidden = tools.filter((name) => FORBIDDEN_TOOL(name) || (planMode && CLAUDE_WRITE_TOOLS.includes(name)));
        if (forbidden.length || servers.length) {
          policyBreach = `tool policy not applied: tools=${forbidden.join(",") || "-"} mcp_servers=${servers.length}`;
          emit("error", { code: "TOOL_POLICY_BREACH", message: policyBreach });
          await this.cancel(state);
          continue;
        }
      }
      for (const item of mapClaudeMessage(message, toolUses, input.policy.testCommandPrefixes)) emit(item.kind, item.payload, item.test ? { test: item.test } : {});
      if (message.type === "result") {
        finalResult = message;
        state.usage = normalizeClaudeUsage(message);
      }
    }
    const { code, signal, error } = await exit;
    if (error) throw Object.assign(new Error(`failed to start claude: ${error.message}`), { code: "AGENT_START_FAILED" });
    if (policyBreach) return { outcome: "failed", errorCode: "POLICY_VIOLATION", errorMessage: policyBreach };
    if (state.cancelRequested) return { outcome: "canceled" };
    if (finalResult && finalResult.subtype === "success" && !finalResult.is_error && code === 0) return { outcome: "completed" };
    const reason = finalResult?.subtype === "error_max_turns" ? "MAX_TURNS" : "AGENT_FAILED";
    const detail = finalResult ? textOf(finalResult.result ?? finalResult.subtype) : stderrTail;
    return { outcome: "failed", errorCode: reason, errorMessage: `claude exited ${signal ?? code}: ${tail(String(detail ?? ""), 500)}` };
  }
}

export function normalizeClaudeUsage(result) {
  const usage = result.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    numTurns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? null,
    // Client-side estimate per the docs; not a bill. Subscription runs are not billed per call.
    estimatedCostUsd: result.total_cost_usd ?? null,
  };
}

/** Maps one stream-json message to AgentEvent drafts. */
export function mapClaudeMessage(message, toolUses = new Map(), testPrefixes = []) {
  const out = [];
  switch (message?.type) {
    case "system":
      if (message.subtype === "init") {
        out.push({ kind: "status", payload: { phase: "init", model: message.model ?? null, permissionMode: message.permissionMode ?? null, tools: Array.isArray(message.tools) ? message.tools : [] } });
      } else if (message.subtype === "api_retry") {
        out.push({ kind: "status", payload: { phase: "api_retry", attempt: message.attempt ?? null, error: message.error ?? null } });
      } else if (message.subtype === "permission_denied") {
        out.push({ kind: "status", payload: { phase: "permission_denied", tool: message.tool_name ?? message.tool ?? null } });
      }
      break;
    case "assistant":
      for (const block of message.message?.content ?? []) {
        if (block.type === "text" && block.text) out.push({ kind: "message", payload: { role: "assistant", text: block.text } });
        if (block.type === "tool_use") {
          toolUses.set(block.id, { name: block.name, command: block.input?.command });
          out.push({ kind: "tool_call", payload: { tool: block.name, toolUseId: block.id, input: block.input ?? {} } });
          if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name) && block.input?.file_path) {
            out.push({ kind: "file_change", payload: { tool: block.name, path: block.input.file_path } });
          }
        }
      }
      break;
    case "user":
      for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
        if (block.type !== "tool_result") continue;
        const use = toolUses.get(block.tool_use_id);
        const text = textOf(block.content);
        out.push({ kind: "tool_result", payload: { tool: use?.name ?? null, toolUseId: block.tool_use_id, isError: Boolean(block.is_error), output: tail(text) } });
        if (use?.name === "Bash" && matchTestCommand(use.command, testPrefixes)) {
          // Claude Code marks a non-zero exit as is_error; the exact code is
          // only known when the output states it. Never guess one.
          const stated = /exit code[:\s]+(\d+)/i.exec(text);
          const exitCode = block.is_error ? (stated ? Number(stated[1]) : null) : 0;
          if (exitCode === null) out.push({ kind: "status", payload: { phase: "test_exit_code_unknown", command: use.command } });
          else {
            const test = { command: use.command, exitCode, summary: tail(text, 500) };
            out.push({ kind: "test", payload: test, test });
          }
        }
      }
      break;
    case "result":
      out.push({ kind: "usage", payload: { subtype: message.subtype ?? null, isError: Boolean(message.is_error), ...normalizeClaudeUsage(message) } });
      if (message.result) out.push({ kind: "message", payload: { role: "final", text: textOf(message.result) } });
      break;
    default:
      break;
  }
  return out;
}
