import { createLocalScheduler } from "./local.mjs";
import { createSlurmScheduler } from "./slurm.mjs";
import { pickEnv } from "../lib/process.mjs";

/** Scheduler interface: submit(job, submitTag) → {jobId}; findByTag(tag) →
 * [{jobId, state, exitCode, reason}]; query(jobId) → {state, exitCode, reason};
 * cancel(jobId). States: pending | running | finished | failed | canceled | unknown. */
export function createScheduler(config) {
  const scheduler = config.scheduler;
  const names = scheduler.passEnv ?? ["PATH", "HOME", "USER", "LANG", "SLURM_CONF"];
  const forbidden = names.filter((name) => /TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name));
  if (forbidden.length) throw new Error(`scheduler.passEnv must not forward credentials: ${forbidden.join(", ")}`);
  const env = pickEnv(names);
  if (scheduler.type === "local") {
    return createLocalScheduler({ workRoot: config.workRoot, nodePath: config.nodePath, env });
  }
  if (scheduler.type === "slurm") {
    return createSlurmScheduler({ ...(scheduler.slurm ?? {}), env });
  }
  throw new Error(`unknown scheduler type: ${scheduler.type}`);
}
