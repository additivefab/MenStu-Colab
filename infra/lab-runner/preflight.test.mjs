// Runner isolation preflight against the test Apptainer shim. The shim
// provides NO isolation, so the honest result is FAIL (network reachable,
// data mount writable, host home visible). This proves the tool reports
// failures; it says nothing about a real Apptainer host.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { emitReport } from "../isolation-canary/report.mjs";
import { runRunnerPreflight } from "./preflight.mjs";
import { createDataset, installShim, makeConfig, tempRoot } from "./test-support/fixtures.mjs";

const RUNNER_TOKEN = "lrt_preflight_secret_token_0123456789abcdef";
const here = fileURLToPath(new URL(".", import.meta.url));

function hasPython() {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function setup(t) {
  const root = tempRoot(t);
  const dataset = createDataset(root);
  const shim = installShim(root);
  const config = makeConfig({ root, platformUrl: "http://127.0.0.1:9", dataset, shimPath: shim.path });
  config.tokenFile = join(root, "runner.token");
  writeFileSync(config.tokenFile, `${RUNNER_TOKEN}\n`, { mode: 0o600 });
  const hostHome = join(root, "home");
  mkdirSync(hostHome);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { root, dataset, shim, config, hostHome, target: `127.0.0.1:${server.address().port}` };
}

const statusOf = (report, id) => report.checks.find((check) => check.id === id)?.status;

for (const interpreter of ["python3", process.execPath]) {
  const label = interpreter === "python3" ? "probe.py" : "probe.mjs";
  test(`runner preflight via the shim (${label}) reports FAIL for network isolation and cleans up`, { skip: interpreter === "python3" && !hasPython() ? "python3 not installed" : false }, async (t) => {
    const env = await setup(t);
    const { report, secrets } = await runRunnerPreflight(env.config, { interpreter, deniedHosts: [env.target], hostHome: env.hostHome, connectTimeoutMs: 1000 });

    assert.equal(statusOf(report, "probe_context_sane"), "PASS", JSON.stringify(report.checks));
    assert.equal(statusOf(report, "network_blocked"), "FAIL", "the shim has no network namespace");
    assert.equal(statusOf(report, "data_mount_readonly"), "FAIL", "the shim binds nothing read-only");
    assert.equal(statusOf(report, "host_home_hidden"), "FAIL");
    assert.equal(statusOf(report, "other_projects_unreadable"), "FAIL");
    assert.equal(statusOf(report, "gpu_as_allocated"), "SKIP");
    assert.equal(report.overall, "FAIL");
    assert.deepEqual(report.context.hostReachableTargets, [env.target]);
    assert.deepEqual(report.context.isolationFlags, ["--containall", "--cleanenv", "--no-home", "--net", "--network", "none"]);

    // The probe really went through the configured runtime with the runner's flags.
    const [call] = env.shim.calls();
    for (const flag of ["--containall", "--cleanenv", "--no-home", "--network"]) assert.ok(call.flags.includes(flag), flag);
    assert.equal(call.binds["/data"].mode, "ro");
    assert.ok(!call.hostEnvKeys.includes("TANYAN_LAB_RUNNER_TOKEN"));

    let printed = "";
    await emitReport(report, { secrets, write: (text) => (printed += text) });
    assert.equal(secrets.length, 2, "data canary + host home canary");
    for (const secret of [...secrets, RUNNER_TOKEN, ...env.dataset.files.map((file) => file.sha256)]) assert.ok(!printed.includes(secret));
    assert.ok(!printed.includes("tanyan-canary-"));
    assert.match(printed, /FAIL\s+network_blocked/);

    assert.deepEqual(readdirSync(env.config.workRoot).filter((name) => name.startsWith(".preflight-")), [], "probe directories removed");
    assert.deepEqual(readdirSync(env.hostHome), [], "host home canary removed");
  });
}

test("network check is inconclusive (not PASS) when the host cannot reach the target either", async (t) => {
  const env = await setup(t);
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const { report } = await runRunnerPreflight(env.config, { interpreter: process.execPath, deniedHosts: [`127.0.0.1:${port}`], hostHome: env.hostHome, connectTimeoutMs: 500 });
  assert.equal(statusOf(report, "network_blocked"), "SKIP");
  assert.match(report.checks.find((check) => check.id === "network_blocked").detail, /inconclusive/);
});

test("runner preflight CLI prints text + JSON, exits 1, and leaks nothing", async (t) => {
  const env = await setup(t);
  const configPath = join(env.root, "runner.json");
  writeFileSync(configPath, JSON.stringify({
    platformUrl: "http://127.0.0.1:9",
    runnerId: "rnr_test",
    tokenFile: env.config.tokenFile,
    workRoot: env.config.workRoot,
    scheduler: { type: "local" },
    nvidiaSmi: null,
    apptainer: { binary: env.shim.path, images: env.config.apptainer.images },
    datasets: [{ versionId: "ds_1", dataPath: env.dataset.dataPath, manifestPath: env.dataset.manifestPath }],
  }));
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, "preflight.mjs"), "--config", configPath, "--interpreter", process.execPath, "--deny-host", env.target, "--host-home", env.hostHome], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /OVERALL: FAIL/);
  const json = JSON.parse(result.stdout.split("--- report JSON ---\n")[1]);
  assert.equal(json.tool, "lab-runner");
  assert.ok(!result.stdout.includes(RUNNER_TOKEN) && !result.stdout.includes("tanyan-canary-"));
});
