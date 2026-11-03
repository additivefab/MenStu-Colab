// Local scheduler: runs the job launcher as a detached child on this host.
// Jobs are recorded in <workRoot>/.local-scheduler/<submitTag>.json BEFORE the
// process is spawned, so a crash between spawn and the runner persisting the
// job id still leaves a record findByTag() can adopt (T11).
// submit() is idempotent per submitTag (R05): the record is published
// exclusively (link(2), EEXIST like O_EXCL), and a second submit for the same
// tag returns the recorded job id instead of spawning a second process.
//
// Limitations (documented in README): no queueing or GPU arbitration between
// concurrent runs, memory limits only via Apptainer cgroups, PID liveness is
// best effort (PID reuse after a host reboot is not detected).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readJsonIfExists, writeJsonAtomic } from "../lib/fsutil.mjs";
import { SubmitOutcomeUnknownError, SubmitRejectedError, writeJsonExclusive } from "./submit-outcome.mjs";

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function createLocalScheduler({ workRoot, nodePath = process.execPath, startupGraceMs = 30_000, env = {} }) {
  const registry = join(workRoot, ".local-scheduler");
  const recordPath = (submitTag) => join(registry, `${submitTag}.json`);

  async function stateOf(record) {
    if (record.spawnError) return { state: "failed", exitCode: null, reason: `launcher could not be started: ${record.spawnError}` };
    const status = await readJsonIfExists(join(record.runDir, "status.json"));
    if (status) {
      if (status.state === "finished") return { state: "finished", exitCode: status.exitCode, reason: null };
      if (status.state === "failed") return { state: "failed", exitCode: status.exitCode, reason: `exit code ${status.exitCode}` };
      if (status.state === "timeout") return { state: "failed", exitCode: status.exitCode, reason: status.reason || "walltime exceeded", timedOut: true };
      if (status.state === "canceled") return { state: "canceled", exitCode: status.exitCode, reason: status.reason || "canceled" };
      if (alive(status.pid)) return { state: status.state === "running" ? "running" : "pending", exitCode: null, reason: null };
      if (record.canceledAt) return { state: "canceled", exitCode: null, reason: "canceled before the launcher recorded a status" };
      return { state: "failed", exitCode: null, reason: "launcher exited without recording a final status" };
    }
    if (record.canceledAt) return { state: "canceled", exitCode: null, reason: "canceled before start" };
    if (alive(record.pid)) return { state: "pending", exitCode: null, reason: null };
    if (Date.now() - Date.parse(record.submittedAt) < startupGraceMs) return { state: "pending", exitCode: null, reason: null };
    return { state: "failed", exitCode: null, reason: "launcher never started" };
  }

  async function allRecords() {
    let names = [];
    try {
      names = await readdir(registry);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const records = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const record = await readJsonIfExists(join(registry, name));
      if (record) records.push(record);
    }
    return records;
  }

  async function recordById(jobId) {
    return (await allRecords()).find((record) => record.jobId === jobId) ?? null;
  }

  return {
    kind: "local",

    async submit(job, submitTag) {
      const record = {
        jobId: `local-${randomUUID()}`,
        submitTag,
        runDir: job.runDir,
        pid: null,
        submittedAt: new Date().toISOString(),
      };
      if (!(await writeJsonExclusive(recordPath(submitTag), record))) {
        const existing = await readJsonIfExists(recordPath(submitTag)).catch(() => null);
        if (typeof existing?.jobId === "string") return { jobId: existing.jobId, reused: true };
        throw new SubmitOutcomeUnknownError(`local job record for ${submitTag} exists without a job id`);
      }
      const child = spawn(nodePath, [job.jobScript], {
        cwd: job.runDir,
        env,
        shell: false,
        detached: true,
        stdio: "ignore",
      });
      try {
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      } catch (error) {
        // The launcher never started, so no job exists: a definitive rejection.
        record.spawnError = String(error?.message ?? error).slice(0, 300);
        await writeJsonAtomic(recordPath(submitTag), record);
        throw new SubmitRejectedError(`local launcher could not be started: ${record.spawnError}`, { cause: error });
      }
      child.unref();
      record.pid = child.pid;
      await writeJsonAtomic(recordPath(submitTag), record);
      return { jobId: record.jobId };
    },

    async findByTag(submitTag) {
      const record = await readJsonIfExists(recordPath(submitTag));
      if (!record) return [];
      return [{ jobId: record.jobId, ...(await stateOf(record)) }];
    },

    async query(jobId) {
      const record = await recordById(jobId);
      if (!record) return { state: "unknown", exitCode: null, reason: "job not found" };
      return stateOf(record);
    },

    async cancel(jobId) {
      const record = await recordById(jobId);
      if (!record) return;
      const status = await readJsonIfExists(join(record.runDir, "status.json"));
      const pid = status?.pid ?? record.pid;
      if (!record.canceledAt) {
        record.canceledAt = new Date().toISOString();
        await writeJsonAtomic(recordPath(record.submitTag), record);
      }
      if (alive(pid)) {
        try { process.kill(pid, "SIGTERM"); } catch { /* exited meanwhile */ }
      }
    },
  };
}
