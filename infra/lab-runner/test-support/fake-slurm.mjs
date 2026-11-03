// Test-only fake of sbatch/squeue/sacct/scancel. State lives in a JSON file in
// the fake's directory; jobs really run (the generated job.mjs is executed as
// a detached process) so cancel and exit codes are observable.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const SELF_URL = pathToFileURL(fileURLToPath(import.meta.url)).href;

/** Writes executables into `binDir`; returns their paths. */
export function installFakeSlurm(binDir) {
  writeFileSync(join(binDir, "state.json"), JSON.stringify({ nextId: 1000, jobs: [] }));
  writeFileSync(join(binDir, "control.json"), JSON.stringify({}));
  const paths = {};
  for (const command of ["sbatch", "squeue", "sacct", "scancel"]) {
    const path = join(binDir, command);
    writeFileSync(path, `#!${process.execPath}\nimport(${JSON.stringify(SELF_URL)}).then((m) => m.main(${JSON.stringify(command)}, ${JSON.stringify(binDir)}, process.argv.slice(2)));\n`);
    chmodSync(path, 0o755);
    paths[command] = path;
  }
  return paths;
}

export function readFakeSlurm(binDir) {
  const calls = existsSync(join(binDir, "calls.jsonl"))
    ? readFileSync(join(binDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { state: JSON.parse(readFileSync(join(binDir, "state.json"), "utf8")), calls };
}

export function setFakeSlurmControl(binDir, control) {
  writeFileSync(join(binDir, "control.json"), JSON.stringify(control));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function jobState(job) {
  if (alive(job.pid)) return { state: job.canceled ? "COMPLETING" : "RUNNING", exit: "0:0" };
  let status = null;
  try {
    status = JSON.parse(readFileSync(join(job.chdir, "status.json"), "utf8"));
  } catch {
    status = null;
  }
  if (job.canceled) return { state: "CANCELLED", exit: `0:15` };
  if (status?.state === "timeout") return { state: "TIMEOUT", exit: `0:15` };
  const code = typeof status?.exitCode === "number" ? status.exitCode : 1;
  return { state: code === 0 ? "COMPLETED" : "FAILED", exit: `${code}:0` };
}

function option(args, name) {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

export function main(command, binDir, args) {
  const statePath = join(binDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const control = JSON.parse(readFileSync(join(binDir, "control.json"), "utf8"));
  appendFileSync(join(binDir, "calls.jsonl"), `${JSON.stringify({ command, args, envKeys: Object.keys(process.env).sort() })}\n`);
  const save = () => writeFileSync(statePath, JSON.stringify(state));

  if (command === "sbatch") {
    const script = args[args.length - 1];
    const chdir = option(args, "chdir");
    const id = String(state.nextId++);
    const output = (option(args, "output") ?? join(chdir, "slurm-%j.log")).replace("%j", id);
    const fd = openSync(output, "a");
    const child = spawn(script, [], { cwd: chdir, detached: true, stdio: ["ignore", fd, fd], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SLURM_JOB_ID: id } });
    child.unref();
    state.jobs.push({ id, name: option(args, "job-name"), pid: child.pid, chdir, canceled: false, time: option(args, "time") });
    save();
    if (control.sbatchLoseResponse) {
      process.stderr.write("sbatch: error: Socket timed out on send/recv operation\n");
      process.exit(1);
    }
    process.stdout.write(`${id}\n`);
    process.exit(0);
  }
  if (command === "squeue") {
    const nameIndex = args.indexOf("-n");
    const idIndex = args.indexOf("-j");
    const jobs = state.jobs.filter((job) => (nameIndex >= 0 ? job.name === args[nameIndex + 1] : job.id === args[idIndex + 1]));
    for (const job of jobs) {
      const { state: jobStatus } = jobState(job);
      if (jobStatus === "RUNNING" || jobStatus === "COMPLETING") process.stdout.write(`${job.id}|${jobStatus}\n`);
    }
    process.exit(0);
  }
  if (command === "sacct") {
    const name = option(args, "name");
    const idIndex = args.indexOf("-j");
    const jobs = state.jobs.filter((job) => (name ? job.name === name : job.id === args[idIndex + 1]));
    for (const job of jobs) {
      const { state: jobStatus, exit } = jobState(job);
      process.stdout.write(`${job.id}|${jobStatus}|${exit}\n`);
    }
    process.exit(0);
  }
  if (command === "scancel") {
    const job = state.jobs.find((entry) => entry.id === args[0]);
    if (!job) {
      process.stderr.write("scancel: error: Invalid job id specified\n");
      process.exit(1);
    }
    job.canceled = true;
    save();
    try { process.kill(job.pid, "SIGTERM"); } catch { /* already exited */ }
    process.exit(0);
  }
  process.exit(2);
}
