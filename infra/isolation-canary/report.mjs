// Shared pieces of the isolation preflight tools (agent worker and lab
// runner): random canaries, running a probe command, turning probe results
// into PASS/FAIL checks, and printing a report that never contains a secret.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLAN_SCHEMA, PROBE_SCHEMA } from "./probe.mjs";

export const REPORT_SCHEMA = "tanyan.isolation-preflight/v1";
export const PROBE_MJS = fileURLToPath(new URL("./probe.mjs", import.meta.url));
export const PROBE_PY = fileURLToPath(new URL("./probe.py", import.meta.url));
export { PLAN_SCHEMA };

export const randomTag = () => randomBytes(6).toString("hex");

/**
 * Tracks everything the tool creates (for cleanup) and every random value it
 * plants (for output scrubbing).
 */
export class CanaryKit {
  constructor() {
    this.paths = [];
    this.secrets = [];
  }

  async dir(dirPath, mode = 0o700) {
    await mkdir(dirPath, { recursive: true, mode });
    await chmod(dirPath, mode);
    return dirPath;
  }

  /** Marks a path for removal at cleanup (created by the tool). */
  track(target) {
    this.paths.push(target);
    return target;
  }

  /** Writes a file with fresh random content; the content is a secret. */
  async canary(filePath, mode = 0o600) {
    const secret = `tanyan-canary-${randomBytes(24).toString("hex")}`;
    this.secrets.push(secret);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, `${secret}\n`, { mode });
    await chmod(filePath, mode);
    return filePath;
  }

  async cleanup() {
    const failures = [];
    for (const target of this.paths.reverse()) {
      try {
        await rm(target, { recursive: true, force: true });
      } catch (error) {
        failures.push(`${target}: ${error.code ?? error.message}`);
      }
    }
    this.paths = [];
    return failures;
  }
}

/** Replaces every known secret in `text` (belt and braces: nothing should contain one). */
export function scrub(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/**
 * Runs a probe command and returns its parsed result. `argv` is the full
 * command (launcher prefix + interpreter + probe + plan). Output parsing takes
 * the last JSON line with the probe schema.
 */
export function runProbeCommand(argv, { env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: `could not start probe: ${error.code ?? error.message}`, stderr: "" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `could not start probe: ${error.code ?? error.message}`, stderr });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").reverse().find((candidate) => {
        try {
          return JSON.parse(candidate).schema === PROBE_SCHEMA;
        } catch {
          return false;
        }
      });
      if (!line) {
        resolve({ ok: false, error: `probe produced no result (exit ${signal ?? code})`, stderr });
        return;
      }
      resolve({ ok: true, result: JSON.parse(line), exitCode: code, stderr });
    });
  });
}

/**
 * Groups probe results by `check` and decides PASS/FAIL per group: PASS only
 * when every op of the group produced its expected outcome. Ops whose base
 * path could not be resolved count as not passing.
 */
export function evaluateProbeChecks(definitions, probeResult) {
  const results = probeResult?.results ?? [];
  return definitions.map((definition) => {
    const ops = results.filter((result) => result.check === definition.id);
    if (!ops.length) return { id: definition.id, status: "SKIP", title: definition.title, detail: definition.skipReason ?? "no probe operations for this check" };
    const failing = ops.filter((result) => result.outcome !== result.expect);
    const observed = ops.map((result) => `${result.id}=${result.outcome}${result.code ? `(${result.code})` : ""}`).join(", ");
    return {
      id: definition.id,
      status: failing.length ? "FAIL" : "PASS",
      title: definition.title,
      detail: failing.length ? `${definition.failText} [${observed}]` : `${definition.passText} [${observed}]`,
      ops: ops.map(({ id, op, expect, outcome, code }) => ({ id, op, expect, outcome, ...(code ? { code } : {}) })),
    };
  });
}

export function overallStatus(checks) {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  if (checks.some((check) => check.status === "SKIP")) return "INCOMPLETE";
  return "PASS";
}

export function hostFacts() {
  return {
    hostname: os.hostname(),
    platform: `${process.platform} ${os.release()}`,
    arch: process.arch,
    node: process.version,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    user: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return null;
      }
    })(),
  };
}

export function buildReport({ tool, checks, context = {}, notes = [] }) {
  return {
    schema: REPORT_SCHEMA,
    tool,
    generatedAt: new Date().toISOString(),
    host: hostFacts(),
    context,
    overall: overallStatus(checks),
    checks,
    notes,
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`Tanyan isolation preflight: ${report.tool}`);
  lines.push(`host ${report.host.hostname} (${report.host.platform}, uid ${report.host.uid}), ${report.generatedAt}`);
  for (const [key, value] of Object.entries(report.context)) {
    if (value !== undefined && value !== null && typeof value !== "object") lines.push(`  ${key}: ${value}`);
    else if (Array.isArray(value)) lines.push(`  ${key}: ${value.join(" ")}`);
  }
  lines.push("");
  const width = Math.max(...report.checks.map((check) => check.id.length), 10);
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id.padEnd(width)}  ${check.detail}`);
  lines.push("");
  for (const note of report.notes) lines.push(`note: ${note}`);
  lines.push(`OVERALL: ${report.overall}`);
  return `${lines.join("\n")}\n`;
}

/** Writes the report: human text then JSON (or JSON only), scrubbed. */
export async function emitReport(report, { json = false, out = null, secrets = [], write = (text) => process.stdout.write(text) } = {}) {
  const jsonText = scrub(JSON.stringify(report, null, 2), secrets);
  if (out) await writeFile(out, `${jsonText}\n`, { mode: 0o600 });
  write(json ? `${jsonText}\n` : `${scrub(formatReport(report), secrets)}\n--- report JSON ---\n${jsonText}\n`);
}

export const exitCodeFor = (overall) => (overall === "PASS" ? 0 : overall === "FAIL" ? 1 : 2);

/** "host:port" → {host, port}; IPv6 literals as "[::1]:443". */
export function parseHostPort(value) {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(value ?? ""));
  if (!match) throw new Error(`expected host:port, got ${JSON.stringify(value)}`);
  return { host: match[1], port: Number(match[2]) };
}
