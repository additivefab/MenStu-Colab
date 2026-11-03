#!/usr/bin/env node
// Lab runner isolation preflight (T15). Run by an operator on the real GPU
// host, as the runner's Unix user, with the runner's config:
//
//   node infra/lab-runner/preflight.mjs --config <runner.json> [--image <imageRef>]
//        [--interpreter python3|node] [--gpus <n>] [--deny-host host:port]...
//        [--host-home <dir>] [--json] [--out report.json]
//
// It builds the container command with the runner's own buildContainerCommand
// (same isolation flags, binds and environment rules as a real job), runs a
// tiny probe inside the configured image and reports PASS/FAIL for: network
// denial, read-only data mount, no Docker socket, host home invisible, other
// datasets / runner token unreadable, and GPU visibility as allocated. The
// probe gets a temporary dataset with a random canary; a random canary is also
// placed in the host home. Everything is removed afterwards and no canary or
// token content is ever printed.
//
// Nothing here has been run on a real host yet; see docs/ops/主机隔离验收.md.
// Against test-support/apptainer-shim.mjs (no isolation) it reports FAIL,
// which is the honest result.

import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildReport,
  CanaryKit,
  emitReport,
  evaluateProbeChecks,
  exitCodeFor,
  parseHostPort,
  PLAN_SCHEMA,
  PROBE_MJS,
  PROBE_PY,
  randomTag,
  runProbeCommand,
  scrub,
} from "../isolation-canary/report.mjs";
import { loadConfig } from "./lib/config.mjs";
import { buildContainerCommand, DEFAULT_ISOLATION_FLAGS } from "./lib/container.mjs";

export const DEFAULT_RUNNER_DENIED_HOSTS = Object.freeze(["1.1.1.1:443", "example.com:80"]);
export const RUNTIME_SOCKETS = Object.freeze(["/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock", "/run/containerd/containerd.sock"]);

export const RUNNER_PROBE_CHECKS = Object.freeze([
  {
    id: "probe_context_sane",
    title: "Probe ran inside the container with the run's mounts",
    passText: "the probe read the data canary via TANYAN_DATA_DIR and wrote TANYAN_OUT_DIR",
    failText: "the probe could not see its data or output mount; the container context is broken and the other results do not mean much",
  },
  {
    id: "network_blocked",
    title: "Network is blocked inside the container",
    passText: "connections to the probe targets fail inside the container",
    failText: "a probe target IS reachable from inside the container (network not isolated)",
  },
  {
    id: "data_mount_readonly",
    title: "Data mount is read-only",
    passText: "writing into the data mount fails",
    failText: "the data mount IS writable from inside the container",
  },
  {
    id: "docker_socket_absent",
    title: "Container runtime sockets are absent",
    passText: "no Docker/Podman/containerd socket is visible inside the container",
    failText: "a container runtime socket is visible inside the container",
  },
  {
    id: "host_home_hidden",
    title: "Host home directory is not visible",
    passText: "a canary in the host home directory is not visible inside the container",
    failText: "a canary in the host home directory IS readable inside the container",
    skipReason: "could not plant a canary in the host home (use --host-home)",
  },
  {
    id: "other_projects_unreadable",
    title: "Other datasets and the runner token are unreadable",
    passText: "configured dataset paths, workRoot and the runner token are not readable inside the container",
    failText: "another dataset, another run's directory or the runner token IS readable inside the container",
  },
]);

function canConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function runtimeVersion(binary) {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 15_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }, (error, stdout) => {
      resolve(error ? "unknown" : String(stdout).trim().split("\n")[0].slice(0, 200));
    });
  });
}

/** Mirrors job-launcher.mjs: the job env plus allowed host variables. */
function containerEnv(command, apptainer) {
  const env = { ...command.env };
  for (const name of apptainer.hostEnv ?? []) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  for (const name of apptainer.forwardIntoContainer ?? []) {
    if (typeof process.env[name] === "string") env[`APPTAINERENV_${name}`] = process.env[name];
  }
  return env;
}

export async function runRunnerPreflight(config, options = {}) {
  const interpreter = options.interpreter ?? "python3";
  const gpus = Number.isInteger(options.gpus) ? options.gpus : null;
  const deniedHosts = options.deniedHosts?.length ? options.deniedHosts : DEFAULT_RUNNER_DENIED_HOSTS;
  const imageRef = options.imageRef ?? Object.keys(config.apptainer.images ?? {})[0];
  const hostHome = options.hostHome ?? os.homedir();
  const isolationFlags = config.apptainer.isolationFlags ?? DEFAULT_ISOLATION_FLAGS;
  const context = {
    apptainerBinary: config.apptainer.binary,
    apptainerVersion: await runtimeVersion(config.apptainer.binary),
    isolationFlags,
    extraFlags: config.apptainer.extraFlags ?? [],
    image: imageRef ?? null,
    scheduler: config.scheduler.type,
    interpreter,
    gpusRequested: gpus,
  };
  const notes = [
    "The probe ran directly from this shell with the runner's container command, not through the scheduler. Run it inside an allocation (e.g. srun --gres=gpu:N) to test GPU visibility.",
  ];
  const checks = [];
  if (!imageRef) {
    checks.push({ id: "probe_context_sane", status: "FAIL", title: "Image available", detail: "no image configured (apptainer.images) and no --image given" });
    return { report: buildReport({ tool: "lab-runner", checks, context, notes }), secrets: [] };
  }

  const kit = new CanaryKit();
  const tag = randomTag();
  try {
    const root = kit.track(path.join(config.workRoot, `.preflight-${tag}`));
    const srcDir = await kit.dir(path.join(root, "src"));
    const dataDir = await kit.dir(path.join(root, "data"));
    const outDir = await kit.dir(path.join(root, "out"));
    await kit.canary(path.join(dataDir, "canary.txt"));

    let homeCanary = null;
    try {
      homeCanary = kit.track(path.join(hostHome, `.tanyan-preflight-${tag}`));
      await kit.canary(homeCanary);
    } catch {
      homeCanary = null;
    }

    const ops = [
      { id: "data_canary_read", check: "probe_context_sane", expect: "allowed", op: "read", envBase: "TANYAN_DATA_DIR", rel: "canary.txt" },
      { id: "out_write", check: "probe_context_sane", expect: "allowed", op: "write", envBase: "TANYAN_OUT_DIR", rel: "" },
      { id: "data_write", check: "data_mount_readonly", expect: "blocked", op: "write", envBase: "TANYAN_DATA_DIR", rel: "" },
    ];
    for (const target of deniedHosts) {
      const { host, port } = parseHostPort(target);
      ops.push({ id: `deny:${target}`, check: "network_blocked", expect: "blocked", op: "connect", host, port, timeoutMs: options.connectTimeoutMs ?? 3000 });
    }
    for (const socketPath of RUNTIME_SOCKETS) ops.push({ id: `socket:${socketPath}`, check: "docker_socket_absent", expect: "blocked", op: "exists", path: socketPath });
    if (homeCanary) ops.push({ id: "host_home_canary", check: "host_home_hidden", expect: "blocked", op: "read", path: homeCanary });
    for (const dataset of Object.values(config.datasets)) ops.push({ id: `dataset:${dataset.versionId}`, check: "other_projects_unreadable", expect: "blocked", op: "read", path: dataset.dataPath });
    ops.push({ id: "work_root", check: "other_projects_unreadable", expect: "blocked", op: "read", path: config.workRoot });
    if (config.tokenFile) ops.push({ id: "runner_token_file", check: "other_projects_unreadable", expect: "blocked", op: "read", path: config.tokenFile });
    ops.push({ id: "token_env", check: "other_projects_unreadable", expect: "blocked", op: "env", names: ["TANYAN_LAB_RUNNER_TOKEN", "AGENT_WORKER_TOKEN"] });
    if (gpus !== null) ops.push({ id: "gpu", check: "gpu_as_allocated", expect: "info", op: "gpu" });

    const probeName = interpreter.includes("python") ? "probe.py" : "probe.mjs";
    await copyFile(probeName === "probe.py" ? PROBE_PY : PROBE_MJS, path.join(srcDir, probeName));
    await writeFile(path.join(srcDir, "plan.json"), JSON.stringify({ schema: PLAN_SCHEMA, ops }), { mode: 0o600 });

    // Host-side control: a target the host itself cannot reach proves nothing.
    const hostReach = [];
    for (const target of deniedHosts) {
      const { host, port } = parseHostPort(target);
      if (await canConnect(host, port, options.connectTimeoutMs ?? 3000)) hostReach.push(target);
    }
    context.hostReachableTargets = hostReach;

    const spec = {
      network: "deny",
      entrypoint: { imageRef, argv: [interpreter, probeName, "plan.json"], params: {} },
      resources: { gpuCount: gpus ?? 0 },
    };
    const command = buildContainerCommand({ spec, runId: `preflight-${tag}`, srcDir, dataPath: dataDir, outDir, apptainer: config.apptainer });
    const run = await runProbeCommand(command.argv, { env: containerEnv(command, config.apptainer), cwd: root, timeoutMs: options.probeTimeoutMs ?? 300_000 });
    if (!run.ok) {
      checks.push({ id: "probe_context_sane", status: "FAIL", title: RUNNER_PROBE_CHECKS[0].title, detail: scrub(`${run.error}; stderr: ${run.stderr.trim().slice(-500)}`, kit.secrets) });
      for (const definition of RUNNER_PROBE_CHECKS.slice(1)) checks.push({ id: definition.id, status: "SKIP", title: definition.title, detail: "probe did not run" });
    } else {
      context.probeUid = run.result.uid;
      context.probeRuntime = run.result.runtime;
      for (const check of evaluateProbeChecks(RUNNER_PROBE_CHECKS, run.result)) {
        if (check.id === "network_blocked" && check.status === "PASS" && !hostReach.length) {
          check.status = "SKIP";
          check.detail = `inconclusive: the targets are not reachable from the host either; use --deny-host with a target the host can reach [${check.detail}]`;
        }
        checks.push(check);
      }
      checks.push(gpuCheck(run.result, gpus));
    }
    context.containerCommandPrefix = command.argv.slice(0, command.argv.indexOf("--bind"));
    const leftovers = await kit.cleanup();
    notes.push(leftovers.length ? `cleanup failed for: ${leftovers.join("; ")}` : "all canaries and preflight directories were removed");
    return { report: buildReport({ tool: "lab-runner", checks, context, notes }), secrets: kit.secrets };
  } finally {
    await kit.cleanup();
  }
}

function gpuCheck(probeResult, gpus) {
  const title = "GPUs visible only as allocated";
  if (gpus === null) return { id: "gpu_as_allocated", status: "SKIP", title, detail: "not tested: pass --gpus <n> inside an allocation of exactly n GPUs" };
  const gpu = probeResult.results.find((result) => result.check === "gpu_as_allocated");
  if (!gpu || gpu.smiCount === null || gpu.smiCount === undefined) {
    return { id: "gpu_as_allocated", status: "SKIP", title, detail: `nvidia-smi not usable inside the container${gpu?.code ? ` (${gpu.code})` : ""}; /dev/nvidiaN nodes visible: ${gpu?.devNodes ?? "?"}` };
  }
  const ok = gpu.smiCount === gpus;
  return {
    id: "gpu_as_allocated",
    status: ok ? "PASS" : "FAIL",
    title,
    detail: `nvidia-smi lists ${gpu.smiCount} GPU(s), allocated ${gpus}; /dev/nvidiaN nodes: ${gpu.devNodes}; CUDA_VISIBLE_DEVICES=${gpu.cudaVisibleDevices ?? "unset"}`,
  };
}

function parseArgs(argv) {
  const options = { config: null, json: false, out: null, deniedHosts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") options.config = argv[++index];
    else if (arg === "--image") options.imageRef = argv[++index];
    else if (arg === "--interpreter") options.interpreter = argv[++index];
    else if (arg === "--gpus") options.gpus = Number.parseInt(argv[++index], 10);
    else if (arg === "--deny-host") options.deniedHosts.push(argv[++index]);
    else if (arg === "--host-home") options.hostHome = argv[++index];
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.config) throw new Error("usage: preflight.mjs --config <runner.json> [--image ref] [--interpreter python3|node] [--gpus n] [--deny-host host:port] [--host-home dir] [--json] [--out file]");
  if (options.gpus !== undefined && (!Number.isInteger(options.gpus) || options.gpus < 0)) throw new Error("--gpus must be a non-negative integer");
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const config = await loadConfig(options.config);
  const { report, secrets } = await runRunnerPreflight(config, options);
  await emitReport(report, { json: options.json, out: options.out, secrets });
  process.exitCode = exitCodeFor(report.overall);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`preflight error: ${error?.message ?? error}\n`);
    process.exit(64);
  });
}
