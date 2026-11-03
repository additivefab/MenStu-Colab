// Isolation startup policy, launcher plumbing and preflight (G01). Local
// simulation only: on this machine every probe runs under the same UID, so
// the honest preflight result is FAIL. Nothing here proves host isolation.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveAttemptContext, expandLauncherArgv, validateLauncherConfig, writeLauncherStub } from "../isolation-canary/launcher.mjs";
import { emitReport } from "../isolation-canary/report.mjs";
import { buildClaudeEnv } from "./adapters/claude.mjs";
import { buildCodexEnv } from "./adapters/codex.mjs";
import { evaluateStartupIsolation, IsolationConfigError, prepareWorkerIsolation, runAgentPreflight } from "./preflight.mjs";
import { captureLogs, makeConfig, provisionProfile, startFakePlatform, tempDir, WORKER_TOKEN } from "./test-support/harness.mjs";
import { createLogger, Redactor } from "./sanitize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALICE_TOKEN = "sk-ant-oat01-ALICE-SECRET-0123456789abcdefghij";
const BOB_TOKEN = "sk-ant-oat01-BOB-SECRET-0123456789abcdefghijkl";

async function shortDir(t) {
  // Unix socket paths must stay < 104 bytes on macOS.
  const dir = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "awp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(t, server, address) {
  await new Promise((resolve) => server.listen(address, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address();
}

/** A worker root with two real-looking profiles and a token file. */
async function workerRoot(t, { profiles = ["cred_alice", "cred_bob"], overrides = {} } = {}) {
  const root = await tempDir(t, "agent-preflight-");
  const config = makeConfig(root, "http://127.0.0.1:9", { tokenFile: path.join(root, "worker.token"), ...overrides });
  await writeFile(config.tokenFile, `${WORKER_TOKEN}\n`, { mode: 0o600 });
  const tokens = { cred_alice: ALICE_TOKEN, cred_bob: BOB_TOKEN };
  for (const id of profiles) await provisionProfile(config.profilesDir, id, { claudeToken: tokens[id] ?? `sk-ant-oat01-${id}-0123456789abcdefghij` });
  return { root, config };
}

const containerLauncher = (extra = {}) => ({
  argv: ["/usr/bin/podman", "run", "--rm", "-i", "--network", "tanyan-egress", "-v", "{repoDir}:{repoDir}:rw", "-v", "{homeDir}:{homeDir}:rw", "-v", "{tmpDir}:{tmpDir}:rw", "-v", "{profileDir}:{profileDir}:rw", "-w", "{repoDir}", "{envFlags}", "registry.example/agent-runtime@sha256:" + "b".repeat(64), "{binary}"],
  envFlag: "--env",
  binaries: { codex: "/usr/local/bin/codex", claude: "/usr/local/bin/claude" },
  ...extra,
});

// ---------------------------------------------------------------------------
// Startup policy
// ---------------------------------------------------------------------------

test("pilot + mode none + 2 profiles refuses to start and explains the cross-profile risk", () => {
  const decision = evaluateStartupIsolation({ deployment: "pilot", isolation: { mode: "none" } }, { profileCount: 2 });
  assert.equal(decision.allowed, false);
  assert.match(decision.errors[0], /2 credential profiles/);
  assert.match(decision.errors[0], /can read every other user's subscription credentials/);
  assert.match(decision.errors[0], /no override/i);

  const accepted = evaluateStartupIsolation({ deployment: "pilot", isolation: { mode: "none", acceptSharedUidRisk: true } }, { profileCount: 2 });
  assert.equal(accepted.allowed, false, "acceptSharedUidRisk cannot override more than one profile");
  assert.match(accepted.errors[0], /only for single-user pilots/);

  const implicitNone = evaluateStartupIsolation({ deployment: "pilot" }, { profileCount: 3 });
  assert.equal(implicitNone.allowed, false, "a missing isolation block means mode none");
});

test("local_dev without an isolation block is unchanged: allowed, no warnings, adapters untouched", async (t) => {
  const { config } = await workerRoot(t);
  assert.deepEqual(evaluateStartupIsolation(config, { profileCount: 2 }), { allowed: true, deployment: "local_dev", mode: "none", profileCount: 2, errors: [], warnings: [] });
  const logs = captureLogs();
  const { adapterConfig } = await prepareWorkerIsolation(config, { logger: createLogger(new Redactor(), logs.write) });
  assert.equal(adapterConfig, config, "same config object: claudePath/codexPath unchanged");
  assert.equal(logs.lines.length, 0, "nothing logged");
});

test("acceptSharedUidRisk with one profile starts with a loud warning; without it a pilot refuses", async (t) => {
  const { config } = await workerRoot(t, { profiles: ["cred_alice"], overrides: { deployment: "pilot", isolation: { mode: "none", acceptSharedUidRisk: true } } });
  const logs = captureLogs();
  const { adapterConfig } = await prepareWorkerIsolation(config, { logger: createLogger(new Redactor(), logs.write) });
  assert.equal(adapterConfig, config);
  assert.equal(logs.lines.length, 1);
  const record = JSON.parse(logs.lines[0]);
  assert.equal(record.level, "warn");
  assert.match(record.message, /ISOLATION WARNING.*SHARED-UID RISK ACCEPTED/);

  const strict = { ...config, isolation: { mode: "none" } };
  await assert.rejects(prepareWorkerIsolation(strict, {}), (error) => error instanceof IsolationConfigError && /requires isolation.acceptSharedUidRisk: true/.test(error.message));

  const production = { ...config, deployment: "production" };
  await assert.rejects(prepareWorkerIsolation(production, {}), /production" requires isolation.mode/);
});

test("invalid deployment, mode or launcher configs are refused", () => {
  assert.equal(evaluateStartupIsolation({ deployment: "prod" }, { profileCount: 0 }).allowed, false);
  assert.equal(evaluateStartupIsolation({ isolation: { mode: "sandbox" } }, { profileCount: 0 }).allowed, false);
  assert.equal(evaluateStartupIsolation({ isolation: { mode: "none", acceptSharedUidRisk: "yes" } }, { profileCount: 0 }).allowed, false);
  const base = { deployment: "pilot", workRoot: "/var/lib/w/work", profilesDir: "/var/lib/w/profiles" };
  assert.equal(evaluateStartupIsolation({ ...base, isolation: { mode: "container" } }, { profileCount: 2 }).allowed, false, "container without launcher");
  const ok = evaluateStartupIsolation({ ...base, isolation: { mode: "container", launcher: containerLauncher() } }, { profileCount: 5 });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.allowed, true);

  const bad = (argv, extra = {}) => validateLauncherConfig({ ...containerLauncher(extra), argv }, { mode: "container", workRoot: base.workRoot, profilesDir: base.profilesDir });
  assert.match(bad(["/usr/bin/podman", "run", "-v", "/var/lib/w/profiles:/p", "-v", "{repoDir}:{repoDir}", "{profileDir}", "img", "{binary}"]).join(), /must not name profilesDir/);
  assert.match(bad(["/usr/bin/podman", "run", "-v", "/var/run/docker.sock:/s", "{repoDir}", "{profileDir}", "img", "{binary}"]).join(), /runtime socket/);
  assert.match(bad(["/usr/bin/podman", "run", "--network", "host", "{repoDir}", "{profileDir}", "img", "{binary}"]).join(), /--network host/);
  assert.match(bad(["/usr/bin/podman", "run", "--privileged", "{repoDir}", "{profileDir}", "img", "{binary}"]).join(), /--privileged/);
  assert.match(bad(["podman", "run", "{repoDir}", "{profileDir}", "img"]).join(), /absolute path.*\{binary\}|\{binary\}/s);
  assert.match(bad(["/usr/bin/sudo", "-n", "/usr/local/libexec/run-as", "{binary}"]).join(), /\{profileDir\}/);
});

// ---------------------------------------------------------------------------
// worker.mjs startup hook (real process)
// ---------------------------------------------------------------------------

function runWorkerProcess(configPath, { stopWhen, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.join(here, "worker.mjs"), "--config", configPath], {
      env: { PATH: process.env.PATH, AGENT_WORKER_TOKEN: WORKER_TOKEN },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const poll = stopWhen ? setInterval(() => {
      if (stopWhen()) {
        clearInterval(poll);
        child.kill("SIGTERM");
      }
    }, 20) : null;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve({ code, signal, stderr });
    });
  });
}

test("worker.mjs refuses to start in pilot with mode none and two profiles", async (t) => {
  const platform = await startFakePlatform(t);
  const { root, config } = await workerRoot(t, { overrides: { platformUrl: platform.url, deployment: "pilot", isolation: { mode: "none", acceptSharedUidRisk: true } } });
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ ...config, tokenFile: undefined }));
  const result = await runWorkerProcess(configPath);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refused to start \(isolation\)/);
  assert.match(result.stderr, /2 credential profiles/);
  assert.equal(platform.requests.length, 0, "never contacted the platform");
  assert.ok(!result.stderr.includes(WORKER_TOKEN) && !result.stderr.includes(ALICE_TOKEN));
});

test("worker.mjs starts a single-user pilot with acceptSharedUidRisk and logs the warning first", async (t) => {
  const platform = await startFakePlatform(t);
  const { root, config } = await workerRoot(t, { profiles: ["cred_alice"], overrides: { platformUrl: platform.url, deployment: "pilot", isolation: { mode: "none", acceptSharedUidRisk: true } } });
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ ...config, tokenFile: undefined }));
  // Stop it once it has polled the platform: it really started.
  const result = await runWorkerProcess(configPath, { stopWhen: () => platform.byAction("claim").length > 0 });
  assert.equal(result.code, 0, `clean shutdown after SIGTERM: ${result.stderr}`);
  const warning = JSON.parse(result.stderr.trim().split("\n")[0]);
  assert.equal(warning.level, "warn");
  assert.match(warning.message, /ISOLATION WARNING/);
});

// ---------------------------------------------------------------------------
// Launcher plumbing
// ---------------------------------------------------------------------------

test("launcher derives the attempt from the real adapters' child env and exposes only that attempt", async (t) => {
  const { config } = await workerRoot(t);
  const attemptDir = path.join(config.workRoot, "att_123");
  const workspace = { homeDir: path.join(attemptDir, "home"), tmpDir: path.join(attemptDir, "tmp") };
  const claudeEnv = buildClaudeEnv({ token: ALICE_TOKEN, configDir: path.join(config.profilesDir, "cred_alice", "claude", "config"), ...workspace });
  const codexEnv = buildCodexEnv({ codexHome: path.join(config.profilesDir, "cred_bob", "codex"), ...workspace });

  const claudeCtx = deriveAttemptContext(claudeEnv, "claude", config);
  assert.equal(claudeCtx.profileDir, path.join(config.profilesDir, "cred_alice"));
  assert.equal(claudeCtx.repoDir, path.join(attemptDir, "repo"));
  assert.equal(deriveAttemptContext(codexEnv, "codex", config).profileId, "cred_bob");

  const argv = expandLauncherArgv(containerLauncher().argv, { ...claudeCtx, binary: "/usr/local/bin/claude" }, { envFlag: "--env" });
  assert.ok(argv.includes(`${claudeCtx.profileDir}:${claudeCtx.profileDir}:rw`));
  assert.ok(argv.includes("CLAUDE_CODE_OAUTH_TOKEN"), "variable name passed");
  assert.ok(!argv.join(" ").includes(ALICE_TOKEN), "token value never in argv");
  assert.ok(!argv.some((element) => element.includes("cred_bob")), "no other profile mentioned");

  assert.throws(() => deriveAttemptContext({ ...claudeEnv, HOME: "/home/someone" }, "claude", config), /attempt home/);
  assert.throws(() => deriveAttemptContext({ ...claudeEnv, CLAUDE_CONFIG_DIR: "/elsewhere/claude/config" }, "claude", config), /profilesDir/);
  assert.throws(() => expandLauncherArgv(["/x", "{profilesDir}"], claudeCtx), /unknown launcher placeholder/);
});

test("generated stub runs the binary through the launcher with the provider's args, no secrets in argv", async (t) => {
  const { root, config } = await workerRoot(t);
  const record = path.join(root, "launcher-calls.jsonl");
  const fakeLauncher = path.join(root, "fake-launcher.mjs");
  // Records its argv, then runs everything after "--" (a non-isolating stand-in for podman/sudo).
  await writeFile(fakeLauncher, `import { appendFileSync } from "node:fs"; import { spawnSync } from "node:child_process";
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, envKeys: Object.keys(process.env).sort() }) + "\\n");
const rest = args.slice(args.indexOf("--") + 1); const r = spawnSync(rest[0], rest.slice(1), { stdio: "inherit" }); process.exit(r.status ?? 1);\n`);
  const fakeBinary = path.join(root, "fake-binary.mjs");
  await writeFile(fakeBinary, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`, { mode: 0o755 });
  const launcher = { argv: [process.execPath, fakeLauncher, "--profile", "{profileDir}", "--workspace", "{repoDir}", "{envFlags}", "--", "{binary}"], envFlag: "--env", binaries: { claude: fakeBinary } };
  const stub = await writeLauncherStub({ dir: path.join(config.workRoot, ".isolation-launchers"), provider: "claude", launcher, workRoot: config.workRoot, profilesDir: config.profilesDir });
  const attemptDir = path.join(config.workRoot, "att_9");
  const env = buildClaudeEnv({ token: ALICE_TOKEN, configDir: path.join(config.profilesDir, "cred_alice", "claude", "config"), homeDir: path.join(attemptDir, "home"), tmpDir: path.join(attemptDir, "tmp"), childPath: process.env.PATH });

  const run = (spawnEnv, providerArgs) => new Promise((resolve) => {
    const child = spawn(stub, providerArgs, { env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  const ok = await run(env, ["-p", "--output-format", "stream-json"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).args, ["-p", "--output-format", "stream-json"]);
  const [call] = (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(call.args.slice(0, 4), ["--profile", path.join(config.profilesDir, "cred_alice"), "--workspace", path.join(attemptDir, "repo")]);
  assert.ok(call.args.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.ok(!JSON.stringify(call).includes(ALICE_TOKEN));

  const refused = await run({ ...env, HOME: "/tmp" }, ["-p"]);
  assert.equal(refused.code, 126, "bad attempt layout is refused before anything runs");
  const codexStub = await writeLauncherStub({ dir: path.join(config.workRoot, ".isolation-launchers"), provider: "codex", launcher, workRoot: config.workRoot, profilesDir: config.profilesDir });
  const noBinary = await new Promise((resolve) => {
    const child = spawn(codexStub, ["exec"], { env: buildCodexEnv({ codexHome: path.join(config.profilesDir, "cred_bob", "codex"), homeDir: path.join(attemptDir, "home"), tmpDir: path.join(attemptDir, "tmp") }), stdio: "ignore" });
    child.once("close", resolve);
  });
  assert.equal(noBinary, 126, "provider without an isolated binary fails closed");
});

test("prepareWorkerIsolation in container mode points both adapters at launcher stubs", async (t) => {
  const { config } = await workerRoot(t, { overrides: { deployment: "pilot" } });
  const withLauncher = { ...config, isolation: { mode: "container", launcher: containerLauncher() } };
  const logs = captureLogs();
  const { adapterConfig } = await prepareWorkerIsolation(withLauncher, { logger: createLogger(new Redactor(), logs.write) });
  assert.equal(adapterConfig.codex.codexPath, path.join(config.workRoot, ".isolation-launchers", "launch-codex"));
  assert.equal(adapterConfig.claude.claudePath, path.join(config.workRoot, ".isolation-launchers", "launch-claude"));
  const stub = await readFile(adapterConfig.claude.claudePath, "utf8");
  assert.ok(!stub.includes(WORKER_TOKEN) && !stub.includes(ALICE_TOKEN));
});

// ---------------------------------------------------------------------------
// Preflight (simulated: same UID on this machine, so FAIL is the honest result)
// ---------------------------------------------------------------------------

async function preflightFixture(t, overrides = {}) {
  const sockDir = await shortDir(t);
  const socketPath = path.join(sockDir, "docker.sock");
  await listen(t, net.createServer((socket) => socket.destroy()), socketPath);
  const { port } = await listen(t, net.createServer((socket) => socket.destroy()), { host: "127.0.0.1", port: 0 });
  const { root, config } = await workerRoot(t, { overrides });
  const dataDir = path.join(root, "rawdata");
  await provisionProfile(dataDir, "dataset-a");
  config.isolation = { mode: "none", rawDataPaths: [dataDir], dockerSockets: [socketPath], probeDeniedHosts: [`127.0.0.1:${port}`], probeTimeoutMs: 1000, ...(overrides.isolation ?? {}) };
  return { root, config };
}

const statusOf = (report, id) => report.checks.find((check) => check.id === id)?.status;

test("preflight --as-attempt reports FAIL on a same-UID host and never prints canary or credential contents", async (t) => {
  const { config } = await preflightFixture(t);
  const { report, secrets } = await runAgentPreflight(config, { asAttempt: true });
  assert.equal(report.overall, "FAIL");
  assert.equal(statusOf(report, "startup_policy"), "WARN");
  assert.equal(statusOf(report, "probe_context_sane"), "PASS");
  for (const id of ["other_profile_unreadable", "worker_token_unreadable", "raw_data_absent", "docker_socket_inaccessible", "egress_limited", "other_attempt_unreadable"]) {
    assert.equal(statusOf(report, id), "FAIL", id);
  }
  assert.equal(secrets.length, 4, "four random canaries were planted");

  let printed = "";
  await emitReport(report, { secrets, write: (text) => (printed += text) });
  for (const secret of [...secrets, WORKER_TOKEN, ALICE_TOKEN, BOB_TOKEN, "rt_fake_refresh_token_value"]) assert.ok(!printed.includes(secret), "no secret in the output");
  assert.ok(!printed.includes("tanyan-canary-"));
  assert.match(printed, /OVERALL: FAIL/);
  assert.match(printed, /--- report JSON ---/);

  assert.deepEqual((await readdir(config.profilesDir)).sort(), ["cred_alice", "cred_bob"], "canary profiles removed");
  assert.deepEqual((await readdir(config.workRoot)).filter((name) => name.startsWith("preflight-")), [], "canary workspaces removed");
});

test("preflight CLI: text + JSON output without secrets, exit 1 on FAIL; static mode is INCOMPLETE", async (t) => {
  const { root, config } = await preflightFixture(t);
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const cli = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.join(here, "preflight.mjs"), "--config", configPath, ...args], { env: { PATH: process.env.PATH, AGENT_WORKER_TOKEN: WORKER_TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  const full = await cli(["--as-attempt", "--out", path.join(root, "report.json")]);
  assert.equal(full.code, 1, full.stderr);
  for (const secret of [WORKER_TOKEN, ALICE_TOKEN, BOB_TOKEN, "tanyan-canary-"]) {
    assert.ok(!full.stdout.includes(secret) && !full.stderr.includes(secret));
  }
  const saved = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
  assert.equal(saved.schema, "tanyan.isolation-preflight/v1");
  assert.equal(saved.overall, "FAIL");
  assert.ok(saved.host.hostname && saved.generatedAt);

  const staticOnly = await cli(["--json"]);
  assert.equal(staticOnly.code, 2);
  const report = JSON.parse(staticOnly.stdout);
  assert.equal(report.overall, "INCOMPLETE");
  assert.equal(statusOf(report, "other_profile_unreadable"), "SKIP");
});

test("preflight flags pilot + none + 2 profiles statically", async (t) => {
  const { config } = await preflightFixture(t, { deployment: "pilot" });
  const { report } = await runAgentPreflight(config, { asAttempt: false });
  assert.equal(statusOf(report, "startup_policy"), "FAIL");
  assert.equal(report.overall, "FAIL");
});

test("a launcher that does not actually isolate is caught by the probe", async (t) => {
  const { root, config } = await preflightFixture(t);
  const passthrough = path.join(root, "passthrough.mjs");
  await writeFile(passthrough, `import { spawnSync } from "node:child_process"; const a = process.argv.slice(2); const rest = a.slice(a.indexOf("--") + 1); process.exit(spawnSync(rest[0], rest.slice(1), { stdio: "inherit" }).status ?? 1);\n`);
  config.isolation = { ...config.isolation, mode: "container", launcher: { argv: [process.execPath, passthrough, "{profileDir}", "{repoDir}", "--", "{binary}"], binaries: { codex: "/usr/local/bin/codex", claude: "/usr/local/bin/claude" }, probeNode: process.execPath } };
  const { report } = await runAgentPreflight(config, { asAttempt: true });
  assert.equal(report.context.isolationMode, "container");
  assert.equal(statusOf(report, "startup_policy"), "PASS", "static checks alone cannot prove isolation");
  assert.equal(statusOf(report, "probe_context_sane"), "PASS");
  assert.equal(statusOf(report, "other_profile_unreadable"), "FAIL");
  assert.equal(report.overall, "FAIL");
});

test("config.example.json is a pilot config whose container launcher passes the static checks", async () => {
  const { loadConfig } = await import("./worker.mjs");
  const config = await loadConfig(path.join(here, "config.example.json"));
  const decision = evaluateStartupIsolation(config, { profileCount: 10 });
  assert.equal(config.deployment, "pilot");
  assert.equal(decision.mode, "container");
  assert.deepEqual(decision.errors, []);
  assert.deepEqual(decision.warnings, []);
});
