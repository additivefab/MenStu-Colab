// The only way this package starts processes: argv arrays through spawn with
// shell disabled, an explicit environment, and bounded captured output.
import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 1_000_000;

/**
 * Runs `file` with `args` and resolves with { code, signal, stdout, stderr }.
 * Never rejects on a non-zero exit; rejects only when the process cannot be
 * started or exceeds `timeoutMs` (it is then killed).
 */
export function runCommand(file, args, { env = {}, cwd, timeoutMs = 120_000, input } = {}) {
  if (typeof file !== "string" || !file) throw new TypeError("runCommand: file must be a non-empty string");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("runCommand: args must be an array of strings");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes < MAX_CAPTURE_BYTES) stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < MAX_CAPTURE_BYTES) stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${file} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Copies only the named variables from `source` (default: this process). */
export function pickEnv(names, source = process.env) {
  const env = {};
  for (const name of names) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  return env;
}
