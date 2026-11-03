// Job launcher: the process the scheduler actually runs (Slurm batch step or
// the local adapter's detached child). It
//   1. records the execution node's GPU driver/model via nvidia-smi (or "");
//   2. spawns the prepared container argv with an explicit environment (no
//      shell, no inherited variables except an allowlist);
//   3. enforces walltime (SIGTERM, then SIGKILL after a grace period);
//   4. forwards SIGTERM/SIGINT (scancel / local cancel) to the container;
//   5. writes <runDir>/status.json atomically and exits with the job's code.
// Status/env files live in the run directory, which is NOT mounted into the
// container, so the job cannot forge them.
import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function writeJsonSync(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function probeGpu(nvidiaSmi) {
  return new Promise((resolve) => {
    if (!nvidiaSmi) {
      resolve({ driverVersion: "", gpuModel: "" });
      return;
    }
    let output = "";
    let child;
    try {
      child = spawn(nvidiaSmi, ["--query-gpu=driver_version,name", "--format=csv,noheader"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
    } catch {
      resolve({ driverVersion: "", gpuModel: "" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve({ driverVersion: "", gpuModel: "" }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ driverVersion: "", gpuModel: "" });
        return;
      }
      const rows = output.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [driver, ...name] = line.split(",");
        return { driver: driver.trim(), name: name.join(",").trim() };
      });
      resolve({
        driverVersion: [...new Set(rows.map((row) => row.driver).filter(Boolean))].join(", "),
        gpuModel: [...new Set(rows.map((row) => row.name).filter(Boolean))].join(", "),
      });
    });
  });
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

export async function runLauncher(jobJsonPath) {
  const job = JSON.parse(readFileSync(jobJsonPath, "utf8"));
  const statusPath = join(job.runDir, "status.json");
  const startedAt = new Date().toISOString();
  writeJsonSync(statusPath, { state: "starting", pid: process.pid, startedAt: null, endedAt: null, exitCode: null });

  const gpu = await probeGpu(job.nvidiaSmi);
  writeJsonSync(join(job.runDir, "env.json"), gpu);

  const env = { ...job.env };
  for (const name of job.hostEnv ?? []) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  // Scheduler-assigned GPU visibility must survive --cleanenv.
  for (const name of job.forwardIntoContainer ?? []) {
    if (typeof process.env[name] === "string") env[`APPTAINERENV_${name}`] = process.env[name];
  }

  mkdirSync(dirname(job.logPath), { recursive: true });
  const logFd = openSync(job.logPath, "a", 0o600);
  let timedOut = false;
  let canceled = false;
  let killTimer;
  const child = spawn(job.argv[0], job.argv.slice(1), {
    cwd: job.cwd ?? job.runDir,
    env,
    shell: false,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  writeJsonSync(statusPath, { state: "running", pid: process.pid, childPid: child.pid ?? null, startedAt, endedAt: null, exitCode: null });

  const graceMs = Math.max(1, Number(job.killGraceSeconds ?? 30)) * 1000;
  function terminate() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, graceMs);
  }
  const walltimeMs = Number(job.walltimeSeconds) > 0 ? Number(job.walltimeSeconds) * 1000 : 0;
  const walltimeTimer = walltimeMs ? setTimeout(() => { timedOut = true; terminate(); }, walltimeMs) : undefined;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => { canceled = true; terminate(); });
  }

  const { code, signal } = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: 127, signal: null, error }));
    child.on("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(walltimeTimer);
  clearTimeout(killTimer);
  closeSync(logFd);
  // Exit code convention: the process's own code, or 128 + signal number.
  const exitCode = typeof code === "number" ? code : 128 + (SIGNAL_NUMBERS[signal] ?? 0);
  const state = timedOut ? "timeout" : canceled ? "canceled" : exitCode === 0 ? "finished" : "failed";
  writeJsonSync(statusPath, {
    state,
    pid: process.pid,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode,
    signal: signal ?? null,
    reason: timedOut ? `walltime exceeded (${job.walltimeSeconds}s)` : canceled ? "canceled by signal" : null,
  });
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runLauncher(process.argv[2]).then((code) => process.exit(code), (error) => {
    process.stderr.write(`job-launcher: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(70);
  });
}
