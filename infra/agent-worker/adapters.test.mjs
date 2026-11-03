// Adapter contract tests. The Codex SDK is replaced by an injected fake
// module and the Claude CLI by a fake `claude` binary on a temp PATH: these
// check argv/env/event mapping, not real model behaviour.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildClaudeArgs, ClaudeAdapter, mapClaudeMessage } from "./adapters/claude.mjs";
import { CODEX_CONFIG_OVERRIDES, CodexAdapter, mapCodexEvent } from "./adapters/codex.mjs";
import { FakeAdapter } from "./adapters/fake.mjs";
import { matchTestCommand, UnsupportedError } from "./adapters/base.mjs";
import { createPlatformClient } from "./platform-client.mjs";
import { acquireProfileLock } from "./profiles.mjs";
import { buildAgentPolicy } from "./prompt.mjs";
import { createLogger, Redactor, sanitizePayload } from "./sanitize.mjs";
import {
  captureLogs, createRepoFixture, makeConfig, makeTask, makeWork, provisionProfile, startFakePlatform, tempDir, WORKER_TOKEN,
} from "./test-support/harness.mjs";
import { runAttempt } from "./worker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function adapterInput(t, overrides = {}) {
  const root = await tempDir(t);
  const workspace = { root, repoDir: path.join(root, "repo"), homeDir: path.join(root, "home"), tmpDir: path.join(root, "tmp") };
  for (const dir of [workspace.repoDir, workspace.homeDir, workspace.tmpDir]) await mkdir(dir, { recursive: true });
  const profilesDir = path.join(root, "profiles");
  const profile = { id: "cred_alice", dir: await provisionProfile(profilesDir, "cred_alice") };
  const secrets = [];
  return {
    attemptId: "att_adapter",
    workspace,
    baseCommitSha: "0".repeat(40),
    prompt: "do the task",
    policy: buildAgentPolicy(makeTask(), { agent: { maxTurns: 7, testCommandPrefixes: ["pytest", "python -m pytest"] } }),
    modelId: "model-x",
    profile,
    registerSecret: (value) => secrets.push(value),
    secrets,
    ...overrides,
  };
}

async function drain(adapter, attemptId) {
  const events = [];
  for await (const event of adapter.streamEvents(attemptId)) events.push(event);
  return { events, result: await adapter.result(attemptId) };
}

// ---------------------------------------------------------------------------
// Capabilities and resume (T24)
// ---------------------------------------------------------------------------

test("T24: capabilities are explicit and resume is rejected as unsupported by every adapter", async () => {
  const adapters = [new CodexAdapter({ loadSdk: async () => ({}) }), new ClaudeAdapter(), new FakeAdapter()];
  const table = adapters.map((adapter) => adapter.capabilities());
  assert.deepEqual(table[0], { provider: "codex", streaming: true, cancel: true, resume: false, toolApproval: false, structuredResult: false, usage: true });
  assert.deepEqual(table[1], { provider: "claude", streaming: true, cancel: true, resume: false, toolApproval: false, structuredResult: false, usage: true });
  for (const adapter of adapters) {
    await assert.rejects(adapter.resume("att_x", {}), (error) => error instanceof UnsupportedError && error.code === "UNSUPPORTED");
  }
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function fakeCodexSdk(script) {
  const calls = { constructor: null, startThread: null, runStreamed: null };
  class Codex {
    constructor(options) {
      calls.constructor = options;
    }

    startThread(options) {
      calls.startThread = options;
      return {
        runStreamed: async (input, turnOptions) => {
          calls.runStreamed = { input, turnOptions };
          return { events: script(turnOptions.signal) };
        },
      };
    }
  }
  return { sdk: { Codex, version: "0.0.0-fake" }, calls };
}

test("codex adapter passes CODEX_HOME, sandbox and options to the SDK and maps events", async (t) => {
  const input = await adapterInput(t);
  const { sdk, calls } = fakeCodexSdk(async function* () {
    yield { type: "thread.started", thread_id: "th_1" };
    yield { type: "turn.started" };
    yield { type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc 'pytest -q'", aggregated_output: "", status: "in_progress" } };
    yield { type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc 'pytest -q'", aggregated_output: "3 passed", exit_code: 0, status: "completed" } };
    yield { type: "item.completed", item: { id: "i2", type: "command_execution", command: "ls -la", aggregated_output: "x", exit_code: 0, status: "completed" } };
    yield { type: "item.completed", item: { id: "i3", type: "file_change", changes: [{ path: "src/model.py", kind: "update" }], status: "completed" } };
    yield { type: "item.completed", item: { id: "i4", type: "reasoning", text: "thinking" } };
    yield { type: "item.completed", item: { id: "i5", type: "agent_message", text: "done" } };
    yield { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 3 } };
  });
  const adapter = new CodexAdapter({ loadSdk: async () => sdk, childPath: "/usr/bin:/bin" });
  await adapter.start(input);
  const { events, result } = await drain(adapter, input.attemptId);

  assert.deepEqual(calls.constructor.env, {
    PATH: "/usr/bin:/bin",
    HOME: input.workspace.homeDir,
    TMPDIR: input.workspace.tmpDir,
    LANG: "C.UTF-8",
    CODEX_HOME: path.join(input.profile.dir, "codex"),
  });
  assert.deepEqual(calls.constructor.config, CODEX_CONFIG_OVERRIDES);
  assert.deepEqual(calls.startThread, {
    model: "model-x",
    sandboxMode: "workspace-write",
    workingDirectory: input.workspace.repoDir,
    skipGitRepoCheck: false,
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  });
  assert.equal(calls.runStreamed.input, "do the task");
  assert.ok(calls.runStreamed.turnOptions.signal instanceof AbortSignal);

  assert.deepEqual(events.map((event) => event.kind), ["status", "status", "tool_call", "tool_result", "test", "tool_result", "file_change", "message", "usage", "status"]);
  assert.deepEqual(events.filter((event) => event.test).map((event) => event.test), [{ command: "bash -lc 'pytest -q'", exitCode: 0, summary: "3 passed" }]);
  assert.deepEqual(events.at(-1).payload, { phase: "finished", outcome: "completed" });
  assert.deepEqual(result, { outcome: "completed", sdkVersion: "@openai/codex-sdk@0.0.0-fake" });
  assert.deepEqual(adapter.usage(input.attemptId), { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 5, reasoningOutputTokens: 3 });
});

test("codex adapter cancel aborts the SDK turn; turn.failed is reported as failed", async (t) => {
  const input = await adapterInput(t);
  const { sdk } = fakeCodexSdk(async function* (signal) {
    yield { type: "turn.started" };
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  const adapter = new CodexAdapter({ loadSdk: async () => sdk });
  await adapter.start(input);
  setTimeout(() => adapter.requestCancel(input.attemptId), 20);
  const { result } = await drain(adapter, input.attemptId);
  assert.equal(result.outcome, "canceled");

  const input2 = await adapterInput(t, { attemptId: "att_failed" });
  const failing = fakeCodexSdk(async function* () {
    yield { type: "turn.failed", error: { message: "usage limit reached" } };
  });
  const adapter2 = new CodexAdapter({ loadSdk: async () => failing.sdk });
  await adapter2.start(input2);
  const { result: result2 } = await drain(adapter2, input2.attemptId);
  assert.deepEqual({ outcome: result2.outcome, errorCode: result2.errorCode }, { outcome: "failed", errorCode: "AGENT_FAILED" });
});

test("codex adapter refuses a credential cache readable by others", async (t) => {
  const input = await adapterInput(t);
  await chmod(path.join(input.profile.dir, "codex", "auth.json"), 0o644);
  let loaded = false;
  const adapter = new CodexAdapter({ loadSdk: async () => {
    loaded = true;
    return {};
  } });
  await adapter.start(input);
  const { result } = await drain(adapter, input.attemptId);
  assert.equal(result.errorCode, "PROFILE_INSECURE");
  assert.equal(loaded, false);
});

test("codex event mapping covers errors and unknown events", () => {
  assert.deepEqual(mapCodexEvent({ type: "error", message: "boom" }), [{ kind: "error", payload: { code: "STREAM_ERROR", message: "boom" } }]);
  assert.deepEqual(mapCodexEvent({ type: "something.new" }), []);
  assert.equal(matchTestCommand("/bin/zsh -lc \"pytest tests\"", ["pytest"]), true);
  assert.equal(matchTestCommand("pytestx", ["pytest"]), false);
  assert.equal(matchTestCommand("curl x && pytest", ["pytest"]), false);
});

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

async function fakeClaudeBin(t) {
  const bin = await tempDir(t, "fake-claude-");
  const target = path.join(bin, "claude");
  await copyFile(path.join(here, "test-support", "fake-claude.mjs"), path.join(bin, "fake-claude.mjs"));
  await writeFile(target, "#!/bin/sh\nexec node \"$(dirname \"$0\")/fake-claude.mjs\" \"$@\"\n", { mode: 0o755 });
  return { bin, claudePath: target, childPath: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, invocation: async () => JSON.parse(await readFile(path.join(bin, "invocation.json"), "utf8")) };
}

test("claude adapter runs the documented argv/env through the worker and never leaks the token", async (t) => {
  const fake = await fakeClaudeBin(t);
  const root = await tempDir(t);
  const repo = await createRepoFixture(root);
  const platform = await startFakePlatform(t);
  const config = makeConfig(root, platform.url, { gitReadFallback: { urlTemplate: `${repo.remoteBase}/{fullName}.git` }, agent: { maxTurns: 9, testCommandPrefixes: ["pytest", "python -m pytest"] } });
  const claudeToken = "sk-ant-oat01-SECRET-claude-token-abcdefghijklmnopqrstuvwxyz";
  const profileDirPath = await provisionProfile(config.profilesDir, "cred_alice", { claudeToken });
  const logs = captureLogs();
  const client = createPlatformClient({ platformUrl: platform.url, workerToken: WORKER_TOKEN });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-should-never-be-forwarded-000000";
  t.after(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  const work = makeWork(repo, { provider: "claude", modelId: "claude-sonnet-test" });
  const adapter = new ClaudeAdapter({ claudePath: fake.claudePath, childPath: fake.childPath });
  await runAttempt(work, { config, client, adapters: { claude: adapter }, baseSecrets: [WORKER_TOKEN], logWrite: logs.write });

  const invocation = await fake.invocation();
  assert.deepEqual(invocation.argv, [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--safe-mode",
    "--setting-sources", "user",
    "--settings", "{\"disableAllHooks\":true}",
    "--strict-mcp-config",
    "--tools", "Read,Edit,Write,Glob,Grep,Bash",
    "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash(pytest),Bash(pytest *),Bash(python -m pytest),Bash(python -m pytest *)",
    "--disallowedTools", "WebFetch,WebSearch,mcp__*,Bash(curl *),Bash(wget *),Bash(ssh *),Bash(scp *),Bash(git push *),Bash(git remote *),Bash(git config *),Bash(pip install *),Bash(npm install *)",
    "--permission-mode", "dontAsk",
    "--max-turns", "9",
    "--no-session-persistence",
    "--model", "claude-sonnet-test",
  ]);
  const extraEnvKeys = invocation.envKeys.filter((key) => !["PATH", "HOME", "TMPDIR", "LANG", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"].includes(key));
  // macOS may inject a few process-level variables (e.g. __CF_USER_TEXT_ENCODING); none may be credentials.
  assert.ok(extraEnvKeys.every((key) => !/KEY|TOKEN|SECRET|ANTHROPIC|OPENAI|AWS/i.test(key)), extraEnvKeys.join(","));
  assert.ok(!invocation.envKeys.includes("ANTHROPIC_API_KEY"));
  assert.equal(invocation.tokenSha256, sha256(claudeToken));
  assert.equal(invocation.env.CLAUDE_CONFIG_DIR, path.join(profileDirPath, "claude", "config"));
  const stripPrivate = (value) => value.replace(/^\/private(?=\/)/, "");
  assert.equal(stripPrivate(invocation.cwd), stripPrivate(path.join(config.workRoot, work.attemptId, "repo")));
  assert.match(invocation.prompt, /# Research task task_0123456789abcdef/);
  assert.ok(!invocation.argv.join(" ").includes(claudeToken));

  const [result] = platform.byAction("result");
  assert.equal(result.outcome, "change_ready", result.errorMessage);
  assert.equal(result.sdkVersion, "claude-cli@9.9.9-fake");
  assert.deepEqual(result.files.map((file) => file.path), ["src/model.py"]);
  assert.deepEqual(result.tests.map(({ command, exitCode }) => ({ command, exitCode })), [
    { command: "pytest -q", exitCode: 0 },
    { command: "python -m pytest tests/test_x.py", exitCode: 1 },
  ]);
  assert.equal(result.usage.inputTokens, 50);
  assert.equal(result.usage.numTurns, 5);
  const everything = JSON.stringify(platform.requests.map((request) => request.body)) + logs.text();
  assert.ok(!everything.includes(claudeToken), "claude token leaked");
  assert.ok(platform.events().some((event) => event.kind === "message" && /my token is \[REDACTED\]/.test(event.payload.text)));
});

test("claude adapter aborts with POLICY_VIOLATION when the CLI reports MCP servers or web tools", async (t) => {
  const fake = await fakeClaudeBin(t);
  const input = await adapterInput(t, { prompt: "FAKE_MODE=mcp" });
  const adapter = new ClaudeAdapter({ claudePath: fake.claudePath, childPath: fake.childPath, cancelGraceMs: 100 });
  await adapter.start(input);
  const { events, result } = await drain(adapter, input.attemptId);
  assert.equal(result.outcome, "failed");
  assert.equal(result.errorCode, "POLICY_VIOLATION");
  assert.ok(events.some((event) => event.kind === "error" && event.payload.code === "TOOL_POLICY_BREACH"));
  assert.equal(input.secrets.length, 1, "token registered for redaction");
});

test("claude adapter cancel sends SIGINT and reports canceled", async (t) => {
  const fake = await fakeClaudeBin(t);
  const input = await adapterInput(t, { prompt: "FAKE_MODE=hang" });
  const adapter = new ClaudeAdapter({ claudePath: fake.claudePath, childPath: fake.childPath, cancelGraceMs: 200 });
  await adapter.start(input);
  const iterator = adapter.streamEvents(input.attemptId)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.payload.phase, "init");
  await adapter.requestCancel(input.attemptId);
  for (let next = await iterator.next(); !next.done; next = await iterator.next());
  const result = await adapter.result(input.attemptId);
  assert.equal(result.outcome, "canceled");
});

test("claude adapter refuses a token file readable by others and fails cleanly without the CLI", async (t) => {
  const input = await adapterInput(t);
  await chmod(path.join(input.profile.dir, "claude", "oauth_token"), 0o640);
  const adapter = new ClaudeAdapter({ claudePath: "/nonexistent/claude" });
  await adapter.start(input);
  assert.equal((await drain(adapter, input.attemptId)).result.errorCode, "PROFILE_INSECURE");

  const input2 = await adapterInput(t, { attemptId: "att_nocli" });
  const adapter2 = new ClaudeAdapter({ claudePath: "/nonexistent/claude" });
  await adapter2.start(input2);
  assert.equal((await drain(adapter2, input2.attemptId)).result.errorCode, "AGENT_START_FAILED");
});

test("claude message mapping never invents an exit code", () => {
  const uses = new Map();
  mapClaudeMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "pytest" } }] } }, uses, ["pytest"]);
  const out = mapClaudeMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: "something broke" }] } }, uses, ["pytest"]);
  assert.ok(!out.some((event) => event.test));
  assert.ok(out.some((event) => event.payload.phase === "test_exit_code_unknown"));
  const noBash = buildClaudeArgs({ policy: { testCommandPrefixes: [], maxTurns: 3 }, modelId: "" });
  assert.equal(noBash[noBash.indexOf("--tools") + 1], "Read,Edit,Write,Glob,Grep");
  assert.equal(noBash[noBash.indexOf("--allowedTools") + 1], "Read,Edit,Write,Glob,Grep");
  assert.ok(!noBash.includes("--model"));
});

// ---------------------------------------------------------------------------
// Profile lock across processes
// ---------------------------------------------------------------------------

test("profile lock file blocks while another live process holds it and recovers from a dead holder", async (t) => {
  const root = await tempDir(t);
  await provisionProfile(root, "cred_x");
  const lockPath = path.join(root, "cred_x", ".run.lock");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  t.after(() => holder.kill());
  await writeFile(lockPath, JSON.stringify({ pid: holder.pid }));
  let acquired = false;
  const pending = acquireProfileLock(root, "cred_x", { pollMs: 20 }).then((release) => {
    acquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(acquired, false, "must wait for the live holder");
  holder.kill();
  await new Promise((resolve) => holder.once("exit", resolve));
  const release = await pending;
  assert.equal(acquired, true);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid);
  await release();

  const controller = new AbortController();
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
  setTimeout(() => controller.abort(new Error("stop waiting")), 50);
  await assert.rejects(acquireProfileLock(root, "cred_x", { pollMs: 10, signal: controller.signal }), /stop waiting/);
  await assert.rejects(acquireProfileLock(root, "../etc", {}), { code: "PROFILE_INVALID" });
});

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

test("redactor removes registered and pattern secrets; payloads stay under the event size limit", () => {
  const redactor = new Redactor().add("exact-secret-value-123");
  const text = [
    "exact-secret-value-123",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "github_pat_11ABCDEFG0123456789_abcdefghijkl",
    "sk-proj-abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer abc.def.ghi-jkl_mnopqrstuv",
    "AKIAABCDEFGHIJKLMNOP",
    "password=hunter2hunter2",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    "https://x-access-token:ghs_zzzzzzzzzzzzzzzzzzzzzzzz@github.com/a/b",
  ].join("\n");
  const out = redactor.redact(text);
  for (const leaked of ["exact-secret-value-123", "ghp_abc", "github_pat_11", "sk-proj-abc", "abc.def.ghi", "AKIAABCD", "hunter2", "MIIabc", "ghs_zzz"]) {
    assert.ok(!out.includes(leaked), `${leaked} survived: ${out}`);
  }
  assert.match(out, /password=\[REDACTED\]/);
  assert.match(out, /x-access-token:\[REDACTED\]@github\.com/);

  const huge = sanitizePayload({ text: "x".repeat(100_000), nested: Array.from({ length: 200 }, (_, index) => ({ index, value: "y".repeat(500) })) }, redactor);
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= 16_000);

  const logs = captureLogs();
  createLogger(redactor, logs.write).info("token exact-secret-value-123", { detail: "Bearer zzzzzzzzzzzzzzzzzzzz" });
  assert.doesNotMatch(logs.text(), /exact-secret|zzzzzzzzzzzzzzzz/);
});

test("worker entrypoint loads with --experimental-strip-types and reports usage errors", () => {
  let failed = null;
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", path.join(here, "worker.mjs")], { encoding: "utf8", stdio: "pipe", env: { PATH: process.env.PATH } });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed);
  assert.match(failed.stderr, /usage: worker\.mjs --config/);
});
