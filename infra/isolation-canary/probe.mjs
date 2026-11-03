#!/usr/bin/env node
// Isolation probe. Runs INSIDE the context an agent or a training job would
// run in (dedicated UID, container, or plain same-UID process) and tries the
// operations listed in a plan file. It reports only outcomes: "allowed" or
// "blocked" plus an error code. It never prints file contents, environment
// values (other than CUDA_VISIBLE_DEVICES), or anything it read.
//
//   node probe.mjs <plan.json>
//
// Plan (tanyan.isolation-probe-plan/v1):
//   { "schema": "...", "ops": [ {id, check, expect, op, ...} ] }
//   op "read"    {path | envBase+rel}      open + read 1 byte (file) or readdir (dir)
//   op "write"   {path | envBase+rel}      create and remove a file inside that directory
//   op "connect" {host, port, timeoutMs}   TCP connect
//   op "unix"    {path}                    connect to a Unix socket
//   op "exists"  {path}                    "allowed" when lstat succeeds (the path is visible)
//   op "env"     {names}                   "allowed" when any named variable is set (names only)
//   op "gpu"     {}                        visible NVIDIA devices (counts only)
// A Python port with the same semantics lives in probe.py for images without Node.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_SCHEMA = "tanyan.isolation-probe/v1";
export const PLAN_SCHEMA = "tanyan.isolation-probe-plan/v1";

function resolveTarget(op, env) {
  if (op.envBase) {
    const base = env[op.envBase];
    if (!base) return { error: "BASE_UNSET" };
    return { target: path.join(base, op.rel ?? "") };
  }
  return { target: op.path };
}

const codeOf = (error) => String(error?.code ?? error?.name ?? "ERROR");

function probeRead(target) {
  try {
    const info = statSync(target);
    if (info.isDirectory()) {
      readdirSync(target);
      return { outcome: "allowed", kind: "dir" };
    }
    const fd = openSync(target, "r");
    try {
      readSync(fd, Buffer.alloc(1), 0, 1, 0);
    } finally {
      closeSync(fd);
    }
    return { outcome: "allowed", kind: "file" };
  } catch (error) {
    return { outcome: "blocked", code: codeOf(error) };
  }
}

function probeWrite(target) {
  const file = path.join(target, `.tanyan-probe-${randomBytes(6).toString("hex")}`);
  let fd;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    return { outcome: "blocked", code: codeOf(error) };
  }
  try {
    writeSync(fd, "x");
  } catch {
    // creation already succeeded: the directory is writable
  } finally {
    closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      // best effort
    }
  }
  return { outcome: "allowed" };
}

function probeSocket(options, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect(options);
    socket.setTimeout(timeoutMs, () => finish({ outcome: "blocked", code: "TIMEOUT" }));
    socket.once("connect", () => finish({ outcome: "allowed" }));
    socket.once("error", (error) => finish({ outcome: "blocked", code: codeOf(error) }));
  });
}

function probeGpu(env) {
  let devNodes = 0;
  try {
    devNodes = readdirSync("/dev").filter((name) => /^nvidia\d+$/.test(name)).length;
  } catch {
    devNodes = 0;
  }
  let smiCount = null;
  let smiCode = null;
  try {
    const out = execFileSync("nvidia-smi", ["-L"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    smiCount = out.split("\n").filter((line) => /^GPU \d+:/.test(line.trim())).length;
  } catch (error) {
    smiCode = codeOf(error);
  }
  return { outcome: "info", devNodes, smiCount, ...(smiCode ? { code: smiCode } : {}), cudaVisibleDevices: env.CUDA_VISIBLE_DEVICES ?? null };
}

/** Executes a plan and returns the result object (no contents, ever). */
export async function runProbe(plan, env = process.env) {
  if (plan?.schema !== PLAN_SCHEMA || !Array.isArray(plan.ops)) throw new Error("not a tanyan isolation probe plan");
  const results = [];
  for (const op of plan.ops) {
    const base = { id: String(op.id), check: String(op.check), op: op.op, expect: op.expect };
    let outcome;
    if (op.op === "read" || op.op === "write") {
      const { target, error } = resolveTarget(op, env);
      outcome = error ? { outcome: "error", code: error } : op.op === "read" ? probeRead(target) : probeWrite(target);
    } else if (op.op === "connect") {
      outcome = await probeSocket({ host: String(op.host), port: Number(op.port) }, Number(op.timeoutMs) || 3000);
    } else if (op.op === "unix") {
      outcome = await probeSocket({ path: String(op.path) }, Number(op.timeoutMs) || 2000);
    } else if (op.op === "exists") {
      try {
        lstatSync(String(op.path));
        outcome = { outcome: "allowed" };
      } catch (error) {
        outcome = { outcome: "blocked", code: codeOf(error) };
      }
    } else if (op.op === "env") {
      const present = (op.names ?? []).filter((name) => typeof env[name] === "string");
      outcome = { outcome: present.length ? "allowed" : "blocked", present };
    } else if (op.op === "gpu") {
      outcome = probeGpu(env);
    } else {
      outcome = { outcome: "error", code: "UNKNOWN_OP" };
    }
    results.push({ ...base, ...outcome });
  }
  return {
    schema: PROBE_SCHEMA,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    runtime: `node ${process.version}`,
    results,
  };
}

async function main(argv) {
  const planPath = argv[0];
  if (!planPath) {
    process.stderr.write("usage: probe.mjs <plan.json>\n");
    process.exit(64);
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const result = await runProbe(plan);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function invokedDirectly() {
  // The probe is often copied into a temp dir behind a symlink (/tmp, /var on macOS).
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`probe failed: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
