// Slurm scheduler adapter. Every command is spawned with an argv array and an
// explicit minimal environment (sbatch's default --export=ALL would otherwise
// forward the runner's own environment into the job).
//
//   submit     sbatch --parsable --job-name=<submitTag> --time=<min> --mem=<G>G
//                     [--gres=gpu:<n>] --output=<runDir>/slurm-%j.log
//                     --chdir=<runDir> [extraArgs…] <runDir>/job.mjs
//   findByTag  squeue -h -n <tag> -o %i|%T        (active jobs)
//              sacct -n -X -P --name=<tag> -S <date> -o JobID,State,ExitCode  (finished jobs)
//   query      squeue -h -j <id> -o %i|%T, then sacct -n -X -P -j <id> -o JobID,State,ExitCode
//   cancel     scancel <id>
//
// Submit uniqueness (R05): a job name is not unique on the Slurm side, so the
// adapter creates <runDir>/submit-receipt.json with O_EXCL before sbatch runs
// and records the job id in it afterwards. A second submit for the same runDir
// returns the recorded job id, or throws SubmitOutcomeUnknownError when the
// receipt has none: sbatch may have been accepted, and only findByTag may
// settle it. sbatch failures are "rejected" only for messages that prove the
// controller refused the job (classifySbatchFailure); everything else is unknown.
import { runCommand } from "../lib/process.mjs";
import { createSubmitReceipt, SubmitOutcomeUnknownError, SubmitRejectedError, updateSubmitReceipt } from "./submit-outcome.mjs";

const JOB_ID = /^[0-9]+(?:_[0-9]+)?$/;

/** Maps Slurm job states (squeue %T / sacct State) to the protocol vocabulary. */
export function mapSlurmState(raw) {
  const state = String(raw ?? "").trim().split(/\s+/)[0].replace(/\+$/, "").toUpperCase();
  switch (state) {
    case "PENDING": case "CONFIGURING": case "REQUEUED": case "REQUEUE_HOLD": case "REQUEUE_FED": case "RESV_DEL_HOLD":
      return { state: "pending", reason: null };
    case "RUNNING": case "COMPLETING": case "SUSPENDED": case "STAGE_OUT": case "SIGNALING": case "RESIZING":
      return { state: "running", reason: null };
    case "COMPLETED":
      return { state: "finished", reason: null };
    case "CANCELLED":
      return { state: "canceled", reason: "CANCELLED" };
    case "TIMEOUT": case "DEADLINE":
      return { state: "failed", reason: `walltime exceeded (${state})`, timedOut: true };
    case "FAILED": case "OUT_OF_MEMORY": case "NODE_FAIL": case "PREEMPTED": case "BOOT_FAIL": case "SPECIAL_EXIT": case "REVOKED":
      return { state: "failed", reason: state };
    default:
      return { state: "unknown", reason: state || "no state" };
  }
}

function parseExitCode(value) {
  const match = /^(\d+):(\d+)$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const code = Number(match[1]);
  const signal = Number(match[2]);
  return signal ? 128 + signal : code;
}

// sbatch messages that prove slurmctld (or sbatch's own option parsing) refused
// the job, so no job exists. Matched only when no transport-ish wording appears.
const SBATCH_DEFINITIVE = [
  /invalid account/i,
  /invalid partition/i,
  /invalid qos/i,
  /invalid generic resource/i,
  /invalid feature specification/i,
  /invalid job array specification/i,
  /requested node configuration is not available/i,
  /requested time limit is invalid/i,
  /memory required by task is not available/i,
  /job violates accounting\/qos policy/i,
  /unrecognized option|invalid option/i,
  /unable to open file/i,
  /batch script contains dos line breaks/i,
];
const SBATCH_AMBIGUOUS = /time(d)? ?out|socket|connect|communication|unable to contact|try again|temporar|zero bytes|slurmctld|protocol|interrupted|i\/o error/i;

/** "rejected" when an sbatch result proves no job was created; otherwise "unknown". */
export function classifySbatchFailure({ code, signal, stderr = "" }) {
  if (!Number.isInteger(code) || code === 0 || signal) return "unknown";
  const text = String(stderr);
  if (SBATCH_AMBIGUOUS.test(text)) return "unknown";
  return SBATCH_DEFINITIVE.some((pattern) => pattern.test(text)) ? "rejected" : "unknown";
}

function formatDate(date) {
  return date.toISOString().slice(0, 19);
}

export function createSlurmScheduler({
  sbatch = "sbatch",
  squeue = "squeue",
  sacct = "sacct",
  scancel = "scancel",
  extraArgs = [],
  env = { PATH: "/usr/local/bin:/usr/bin:/bin" },
  sacctLookbackDays = 14,
  commandTimeoutMs = 60_000,
} = {}) {
  for (const arg of extraArgs) {
    if (typeof arg !== "string" || !arg.startsWith("--")) throw new Error(`slurm.extraArgs entries must be --flags: ${arg}`);
  }
  const run = (file, args) => runCommand(file, args, { env, timeoutMs: commandTimeoutMs });

  async function squeueLines(args) {
    const result = await run(squeue, ["-h", ...args, "-o", "%i|%T"]);
    if (result.code !== 0) {
      // squeue -j <id> exits non-zero for an id it no longer knows.
      if (/invalid job id/i.test(result.stderr)) return [];
      throw new Error(`squeue failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    }
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [jobId, state] = line.split("|");
      return { jobId, ...mapSlurmState(state), exitCode: null };
    });
  }

  async function sacctLines(args) {
    const since = formatDate(new Date(Date.now() - sacctLookbackDays * 86_400_000));
    const result = await run(sacct, ["-n", "-X", "-P", ...args, "-S", since, "-o", "JobID,State,ExitCode"]);
    if (result.code !== 0) throw new Error(`sacct failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [jobId, state, exit] = line.split("|");
      const mapped = mapSlurmState(state);
      const exitCode = parseExitCode(exit);
      return { jobId, ...mapped, exitCode, reason: mapped.reason ?? (mapped.state === "failed" ? `exit code ${exitCode}` : null) };
    });
  }

  return {
    kind: "slurm",

    async submit(job, submitTag) {
      const args = [
        "--parsable",
        `--job-name=${submitTag}`,
        `--time=${Math.max(1, Math.ceil(job.resources.walltimeMinutes))}`,
        ...(job.resources.memoryGb > 0 ? [`--mem=${job.resources.memoryGb}G`] : []),
        ...(job.resources.gpuCount > 0 ? [`--gres=gpu:${job.resources.gpuCount}`] : []),
        `--output=${job.runDir}/slurm-%j.log`,
        `--chdir=${job.runDir}`,
        ...extraArgs,
        job.jobScript,
      ];
      const receipt = await createSubmitReceipt(job.runDir, submitTag);
      if (!receipt.created) {
        const existing = receipt.receipt;
        if (existing?.submitTag === submitTag && typeof existing.jobId === "string" && JOB_ID.test(existing.jobId)) return { jobId: existing.jobId, reused: true };
        throw new SubmitOutcomeUnknownError(`submit receipt for ${submitTag} exists without a job id; sbatch may already have been accepted`);
      }
      let result;
      try {
        result = await run(sbatch, args);
      } catch (error) {
        // sbatch could not be started at all: nothing reached the controller.
        if (error?.code === "ENOENT" || error?.code === "EACCES") {
          await updateSubmitReceipt(job.runDir, { outcome: "rejected" });
          throw new SubmitRejectedError(`sbatch could not be started: ${error.message}`, { cause: error });
        }
        throw new SubmitOutcomeUnknownError(`sbatch outcome unknown: ${error?.message ?? error}`, { cause: error });
      }
      if (result.code !== 0) {
        const message = `sbatch failed (${result.code ?? result.signal}): ${result.stderr.trim().slice(0, 300)}`;
        if (classifySbatchFailure(result) === "rejected") {
          await updateSubmitReceipt(job.runDir, { outcome: "rejected" });
          throw new SubmitRejectedError(message);
        }
        throw new SubmitOutcomeUnknownError(message);
      }
      const jobId = result.stdout.trim().split("\n").pop().split(";")[0].trim();
      if (!JOB_ID.test(jobId)) throw new SubmitOutcomeUnknownError(`sbatch returned an unexpected job id: ${JSON.stringify(jobId)}`);
      await updateSubmitReceipt(job.runDir, { jobId });
      return { jobId };
    },

    async findByTag(submitTag) {
      const active = await squeueLines(["-n", submitTag]);
      const finished = await sacctLines([`--name=${submitTag}`]);
      const byId = new Map();
      for (const entry of [...finished, ...active]) byId.set(entry.jobId, { ...byId.get(entry.jobId), ...entry });
      return [...byId.values()].filter((entry) => JOB_ID.test(entry.jobId));
    },

    async query(jobId) {
      if (!JOB_ID.test(jobId)) throw new Error(`invalid Slurm job id: ${jobId}`);
      const active = await squeueLines(["-j", jobId]);
      if (active.length) return active[0];
      const finished = await sacctLines(["-j", jobId]);
      return finished[0] ?? { state: "unknown", exitCode: null, reason: "job not found in squeue or sacct" };
    },

    async cancel(jobId) {
      if (!JOB_ID.test(jobId)) throw new Error(`invalid Slurm job id: ${jobId}`);
      const result = await run(scancel, [jobId]);
      if (result.code !== 0) throw new Error(`scancel failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    },
  };
}
