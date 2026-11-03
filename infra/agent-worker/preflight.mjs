#!/usr/bin/env -S node --experimental-strip-types
// Agent worker isolation: startup policy + host preflight (G01, T14/T15).
//
// 1. Startup policy (`prepareWorkerIsolation`, called by worker.mjs main()):
//    deployment "pilot"/"production" with isolation.mode "none" and more than
//    one credential profile refuses to start. Every profile lives under one
//    service UID, so 0700/0600 does not keep one user's agent from reading
//    another user's credentials. A single-user pilot may run mode "none" only
//    with an explicit, loudly logged isolation.acceptSharedUidRisk: true.
//    Modes "per_attempt_uid" and "container" route both provider binaries
//    through the operator's launcher (infra/isolation-canary/launcher.mjs).
//
// 2. Preflight CLI, run by an operator on the real host:
//      node --experimental-strip-types infra/agent-worker/preflight.mjs --config <path> [--as-attempt] [--json] [--out report.json]
//    Without --as-attempt: static checks only (startup policy, launcher config).
//    With --as-attempt: also plants random canaries (another profile's
//    credential, another attempt's workspace), starts the probe exactly the
//    way an attempt's agent would be started (same env, through the launcher
//    when one is configured) and reports PASS/FAIL per check. Canaries are
//    removed afterwards. Output never contains canary or credential contents.
//
// Nothing here has been run on a real host yet; see docs/ops/主机隔离验收.md.

import { copyFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveAttemptContext, expandLauncherArgv, validateLauncherConfig, writeLauncherStub } from "../isolation-canary/launcher.mjs";
import {
  buildReport,
  CanaryKit,
  emitReport,
  evaluateProbeChecks,
  exitCodeFor,
  parseHostPort,
  PLAN_SCHEMA,
  PROBE_MJS,
  randomTag,
  runProbeCommand,
  scrub,
} from "../isolation-canary/report.mjs";

export const DEPLOYMENTS = Object.freeze(["local_dev", "pilot", "production"]);
export const ISOLATION_MODES = Object.freeze(["none", "per_attempt_uid", "container"]);
export const DEFAULT_DOCKER_SOCKETS = Object.freeze(["/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock", "/run/containerd/containerd.sock"]);
export const DEFAULT_DENIED_HOSTS = Object.freeze(["1.1.1.1:443", "example.com:80"]);
const PROFILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class IsolationConfigError extends Error {
  constructor(decision) {
    super(`agent worker refused to start (isolation): ${decision.errors.join(" | ")}`);
    this.name = "IsolationConfigError";
    this.code = "ISOLATION_CONFIG_REFUSED";
    this.decision = decision;
  }
}

/** Number of provisioned credential profiles (directories named like a profile id). */
export async function countCredentialProfiles(profilesDir) {
  const entries = await readdir(profilesDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory() && PROFILE_ID.test(entry.name)).length;
}

export function crossProfileRiskText(profileCount) {
  return [
    `isolation.mode is "none" and ${profileCount} credential profiles are provisioned under profilesDir.`,
    "Every agent run shares the worker's Unix user, so a shell command run by one user's agent (for example a test command that executes repository code)",
    "can read every other user's subscription credentials (codex/auth.json, claude/oauth_token) and the worker token; modes 0700/0600 do not separate profiles under one UID.",
    'Set isolation.mode to "per_attempt_uid" or "container" with isolation.launcher (infra/agent-worker/README.md, docs/ops/主机隔离验收.md).',
    "There is no override for more than one profile.",
  ].join(" ");
}

/**
 * Pure startup decision. local_dev without an isolation block is allowed with
 * no warnings (unchanged behaviour).
 */
export function evaluateStartupIsolation(config, { profileCount }) {
  const deployment = config.deployment ?? "local_dev";
  const isolation = config.isolation ?? {};
  const mode = isolation.mode ?? "none";
  const accept = isolation.acceptSharedUidRisk;
  const errors = [];
  const warnings = [];
  if (!DEPLOYMENTS.includes(deployment)) errors.push(`deployment must be one of ${DEPLOYMENTS.join(", ")} (got ${JSON.stringify(deployment)})`);
  if (!ISOLATION_MODES.includes(mode)) errors.push(`isolation.mode must be one of ${ISOLATION_MODES.join(", ")} (got ${JSON.stringify(mode)})`);
  if (accept !== undefined && typeof accept !== "boolean") errors.push("isolation.acceptSharedUidRisk must be true or false");
  if (errors.length) return { allowed: false, deployment, mode, profileCount, errors, warnings };

  const strict = deployment !== "local_dev";
  if (mode === "none") {
    if (strict && profileCount > 1) {
      errors.push(`deployment "${deployment}": ${crossProfileRiskText(profileCount)}${accept ? " isolation.acceptSharedUidRisk is accepted only for single-user pilots (at most one profile)." : ""}`);
    } else if (deployment === "production") {
      errors.push('deployment "production" requires isolation.mode "per_attempt_uid" or "container"; acceptSharedUidRisk is not available in production.');
    } else if (strict && accept !== true) {
      errors.push(`deployment "pilot" with isolation.mode "none" requires isolation.acceptSharedUidRisk: true, which is allowed only for a single-user pilot (profiles now: ${profileCount}). The agent can still read the worker token and anything else the service user can read.`);
    } else if (strict) {
      warnings.push(`SHARED-UID RISK ACCEPTED (isolation.acceptSharedUidRisk=true, deployment "pilot", ${profileCount} profile): agent commands run as the worker's own Unix user and can read the worker token, every file under profilesDir and anything else that user can read. Adding a second profile makes the worker refuse to start.`);
    }
  } else {
    errors.push(...validateLauncherConfig(isolation.launcher, { mode, workRoot: config.workRoot, profilesDir: config.profilesDir }));
    if (accept) warnings.push(`isolation.acceptSharedUidRisk is ignored with mode "${mode}"`);
    for (const provider of ["codex", "claude"]) {
      if (isolation.launcher && !isolation.launcher.binaries?.[provider]) warnings.push(`isolation.launcher.binaries.${provider} is not set: ${provider} attempts will fail (AGENT_FAILED) instead of running unisolated`);
    }
  }
  return { allowed: errors.length === 0, deployment, mode, profileCount, errors, warnings };
}

/**
 * Startup hook for worker.mjs. Throws IsolationConfigError when the
 * configuration is unsafe for its deployment. Returns the config the adapters
 * should be built from: unchanged for mode "none", or with codexPath /
 * claudePath pointing at generated launcher stubs.
 */
export async function prepareWorkerIsolation(config, { logger, stubDir } = {}) {
  const profileCount = await countCredentialProfiles(config.profilesDir);
  const decision = evaluateStartupIsolation(config, { profileCount });
  if (!decision.allowed) throw new IsolationConfigError(decision);
  for (const warning of decision.warnings) {
    logger?.warn(`!!! ISOLATION WARNING !!! ${warning}`, { deployment: decision.deployment, isolationMode: decision.mode, profileCount });
  }
  if (decision.mode === "none") return { decision, adapterConfig: config };

  const launcher = config.isolation.launcher;
  const dir = stubDir ?? path.join(config.workRoot, ".isolation-launchers");
  const common = { dir, launcher, workRoot: config.workRoot, profilesDir: config.profilesDir };
  const codexPath = await writeLauncherStub({ ...common, provider: "codex" });
  const claudePath = await writeLauncherStub({ ...common, provider: "claude" });
  logger?.info("agent runs go through the isolation launcher", { isolationMode: decision.mode, launcher: launcher.argv[0], codexBinary: launcher.binaries?.codex ?? null, claudeBinary: launcher.binaries?.claude ?? null });
  return {
    decision,
    adapterConfig: { ...config, codex: { ...config.codex, codexPath }, claude: { ...config.claude, claudePath } },
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export const AGENT_PROBE_CHECKS = Object.freeze([
  {
    id: "probe_context_sane",
    title: "Probe ran in a usable attempt context",
    passText: "the probe wrote its own workspace and read its own profile canary",
    failText: "the probe could not use its own workspace or profile; the launcher context is broken and the other results do not mean much",
  },
  {
    id: "other_profile_unreadable",
    title: "Another user's credential profile is unreadable",
    passText: "another profile's canary credential (and every real profile's credential files) is unreadable",
    failText: "another profile's credentials ARE readable from the agent context (cross-user credential exposure)",
  },
  {
    id: "worker_token_unreadable",
    title: "Worker token is unreadable",
    passText: "the worker token file is unreadable and no token variable is set",
    failText: "the worker token is readable from the agent context",
    skipReason: "no tokenFile configured",
  },
  {
    id: "raw_data_absent",
    title: "Raw-data mounts are absent",
    passText: "no configured raw-data path is visible",
    failText: "a raw-data path is readable from the agent context",
    skipReason: "isolation.rawDataPaths is empty: list the host's dataset mount points",
  },
  {
    id: "docker_socket_inaccessible",
    title: "Container runtime sockets are inaccessible",
    passText: "no container runtime socket accepts a connection",
    failText: "a container runtime socket accepts connections from the agent context (host root equivalent)",
  },
  {
    id: "egress_limited",
    title: "Outbound network is limited to the allowlist",
    passText: "connections to non-allowlisted targets fail",
    failText: "a non-allowlisted target is reachable from the agent context",
    skipReason: "no probe targets (isolation.probeDeniedHosts)",
  },
  {
    id: "egress_allowlist_reachable",
    title: "Allowlisted endpoints are reachable (positive control, warning only)",
    passText: "allowlisted endpoints accept connections",
    failText: "an allowlisted endpoint is not reachable; agents may fail to reach the model",
  },
  {
    id: "other_attempt_unreadable",
    title: "Another attempt's workspace is unreadable",
    passText: "another attempt's workspace canary is unreadable",
    failText: "another attempt's workspace IS readable from the agent context",
  },
]);

function staticCheck(decision) {
  if (!decision.allowed) return { id: "startup_policy", status: "FAIL", title: "Worker startup policy", detail: `the worker would refuse to start: ${decision.errors.join(" | ")}` };
  if (decision.mode === "none") {
    return {
      id: "startup_policy",
      status: "WARN",
      title: "Worker startup policy",
      detail: `deployment ${decision.deployment}, isolation.mode none: the worker starts, but agent runs share the worker's UID${decision.warnings.length ? ` (${decision.warnings.join(" | ")})` : ""}`,
    };
  }
  return {
    id: "startup_policy",
    status: decision.warnings.length ? "WARN" : "PASS",
    title: "Worker startup policy",
    detail: `deployment ${decision.deployment}, isolation.mode ${decision.mode}: launcher config passes the static checks (this does not prove isolation)${decision.warnings.length ? `; ${decision.warnings.join(" | ")}` : ""}`,
  };
}

async function realProfileCredentialOps(profilesDir, excluded) {
  const entries = await readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  const ops = [];
  for (const entry of entries.filter((item) => item.isDirectory() && PROFILE_ID.test(item.name) && !excluded.has(item.name)).slice(0, 50)) {
    const dir = path.join(profilesDir, entry.name);
    ops.push({ id: `profile:${entry.name}/codex/auth.json`, check: "other_profile_unreadable", expect: "blocked", op: "read", path: path.join(dir, "codex", "auth.json") });
    ops.push({ id: `profile:${entry.name}/claude/oauth_token`, check: "other_profile_unreadable", expect: "blocked", op: "read", path: path.join(dir, "claude", "oauth_token") });
  }
  return ops;
}

/**
 * Runs the preflight. `asAttempt` plants canaries and runs the probe in the
 * attempt context; otherwise only the static checks run.
 */
export async function runAgentPreflight(config, { asAttempt = false, probeTimeoutMs = 120_000 } = {}) {
  const profileCount = await countCredentialProfiles(config.profilesDir);
  const decision = evaluateStartupIsolation(config, { profileCount });
  const isolation = config.isolation ?? {};
  const context = {
    deployment: decision.deployment,
    isolationMode: decision.mode,
    credentialProfiles: profileCount,
    launcher: Array.isArray(isolation.launcher?.argv) ? isolation.launcher.argv[0] : null,
    asAttempt,
  };
  const checks = [staticCheck(decision)];
  const notes = ["This report describes only the host, user and configuration it ran on."];

  if (!asAttempt) {
    for (const definition of AGENT_PROBE_CHECKS) {
      if (definition.id === "egress_allowlist_reachable") continue;
      checks.push({ id: definition.id, status: "SKIP", title: definition.title, detail: "not probed: run with --as-attempt" });
    }
    return { report: buildReport({ tool: "agent-worker", checks, context, notes }), secrets: [] };
  }
  if (decision.mode !== "none" && decision.errors.length) {
    notes.push("Launcher configuration is invalid; probes were not started.");
    for (const definition of AGENT_PROBE_CHECKS) {
      if (definition.id !== "egress_allowlist_reachable") checks.push({ id: definition.id, status: "SKIP", title: definition.title, detail: "not probed: fix startup_policy first" });
    }
    return { report: buildReport({ tool: "agent-worker", checks, context, notes }), secrets: [] };
  }

  const kit = new CanaryKit();
  const tag = randomTag();
  try {
    const selfAttempt = kit.track(path.join(config.workRoot, `preflight-${tag}-self`));
    const otherAttempt = kit.track(path.join(config.workRoot, `preflight-${tag}-other`));
    const selfProfile = kit.track(path.join(config.profilesDir, `preflight-${tag}-self`));
    const otherProfile = kit.track(path.join(config.profilesDir, `preflight-${tag}-other`));
    for (const sub of ["repo", "home", "tmp"]) await kit.dir(path.join(selfAttempt, sub));
    await kit.dir(path.join(selfProfile, "codex"));
    await kit.dir(path.join(selfProfile, "claude", "config"));
    const ownCanary = await kit.canary(path.join(selfProfile, "claude", "oauth_token"));
    const otherToken = await kit.canary(path.join(otherProfile, "claude", "oauth_token"));
    const otherAuth = await kit.canary(path.join(otherProfile, "codex", "auth.json"));
    const otherWorkspace = await kit.canary(path.join(otherAttempt, "repo", "canary.txt"));

    const ops = [
      { id: "own_workspace_write", check: "probe_context_sane", expect: "allowed", op: "write", path: path.join(selfAttempt, "repo") },
      { id: "own_profile_read", check: "probe_context_sane", expect: "allowed", op: "read", path: ownCanary },
      { id: "canary_profile_token", check: "other_profile_unreadable", expect: "blocked", op: "read", path: otherToken },
      { id: "canary_profile_auth", check: "other_profile_unreadable", expect: "blocked", op: "read", path: otherAuth },
      { id: "canary_profile_dir", check: "other_profile_unreadable", expect: "blocked", op: "read", path: otherProfile },
      ...(await realProfileCredentialOps(config.profilesDir, new Set([path.basename(selfProfile), path.basename(otherProfile)]))),
      { id: "canary_workspace_file", check: "other_attempt_unreadable", expect: "blocked", op: "read", path: otherWorkspace },
      { id: "canary_workspace_dir", check: "other_attempt_unreadable", expect: "blocked", op: "read", path: otherAttempt },
    ];
    if (config.tokenFile) {
      ops.push({ id: "token_file", check: "worker_token_unreadable", expect: "blocked", op: "read", path: config.tokenFile });
      ops.push({ id: "token_env", check: "worker_token_unreadable", expect: "blocked", op: "env", names: ["AGENT_WORKER_TOKEN", "TANYAN_LAB_RUNNER_TOKEN"] });
    }
    for (const dataPath of isolation.rawDataPaths ?? []) ops.push({ id: `data:${dataPath}`, check: "raw_data_absent", expect: "blocked", op: "read", path: dataPath });
    for (const socketPath of isolation.dockerSockets ?? DEFAULT_DOCKER_SOCKETS) ops.push({ id: `socket:${socketPath}`, check: "docker_socket_inaccessible", expect: "blocked", op: "unix", path: socketPath });
    for (const target of isolation.probeDeniedHosts ?? DEFAULT_DENIED_HOSTS) {
      const { host, port } = parseHostPort(target);
      ops.push({ id: `deny:${target}`, check: "egress_limited", expect: "blocked", op: "connect", host, port, timeoutMs: isolation.probeTimeoutMs ?? 3000 });
    }
    for (const target of isolation.egressAllowlist ?? []) {
      if (target.includes("*")) continue;
      const { host, port } = parseHostPort(target);
      ops.push({ id: `allow:${target}`, check: "egress_allowlist_reachable", expect: "allowed", op: "connect", host, port, timeoutMs: isolation.probeTimeoutMs ?? 3000 });
    }

    const tmpDir = path.join(selfAttempt, "tmp");
    const probePath = path.join(tmpDir, "probe.mjs");
    const planPath = path.join(tmpDir, "plan.json");
    await copyFile(PROBE_MJS, probePath);
    await writeFile(planPath, JSON.stringify({ schema: PLAN_SCHEMA, ops }), { mode: 0o600 });

    // Same environment shape the Codex adapter gives its child.
    const env = {
      PATH: config.codex?.childPath ?? process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(selfAttempt, "home"),
      TMPDIR: tmpDir,
      LANG: "C.UTF-8",
      CODEX_HOME: path.join(selfProfile, "codex"),
    };
    let argv;
    if (decision.mode === "none") {
      argv = [process.execPath, probePath, planPath];
    } else {
      const ctx = deriveAttemptContext(env, "codex", { workRoot: config.workRoot, profilesDir: config.profilesDir });
      const launcher = isolation.launcher;
      argv = [...expandLauncherArgv(launcher.argv, { ...ctx, binary: launcher.probeNode ?? "node" }, { envFlag: launcher.envFlag }), probePath, planPath];
    }
    context.probeCommand = argv[0];
    const run = await runProbeCommand(argv, { env, cwd: path.join(selfAttempt, "repo"), timeoutMs: probeTimeoutMs });
    if (!run.ok) {
      checks.push({ id: "probe_context_sane", status: "FAIL", title: "Probe ran in a usable attempt context", detail: scrub(`${run.error}; stderr: ${run.stderr.trim().slice(-500)}`, kit.secrets) });
      for (const definition of AGENT_PROBE_CHECKS.slice(1)) {
        if (definition.id !== "egress_allowlist_reachable") checks.push({ id: definition.id, status: "SKIP", title: definition.title, detail: "probe did not run" });
      }
    } else {
      context.probeUid = run.result.uid;
      context.probeRuntime = run.result.runtime;
      const definitions = AGENT_PROBE_CHECKS.filter((definition) => definition.id !== "egress_allowlist_reachable" || (isolation.egressAllowlist ?? []).length);
      const tokenFileExists = config.tokenFile ? await stat(config.tokenFile).then(() => true, () => false) : false;
      for (const check of evaluateProbeChecks(definitions, run.result)) {
        if (check.id === "egress_allowlist_reachable" && check.status === "FAIL") check.status = "WARN";
        if (check.id === "worker_token_unreadable" && check.status === "PASS" && !tokenFileExists) {
          check.status = "SKIP";
          check.detail = `inconclusive: tokenFile does not exist on this host, so "unreadable" proves nothing [${check.detail}]`;
        }
        checks.push(check);
      }
      if (decision.mode === "per_attempt_uid") {
        const same = run.result.uid === (typeof process.getuid === "function" ? process.getuid() : null);
        checks.push({ id: "attempt_uid_distinct", status: same ? "FAIL" : "PASS", title: "Attempt runs under a different UID", detail: same ? "the probe ran under the worker's own UID" : `probe uid ${run.result.uid} differs from the worker's` });
      }
    }
    if (decision.mode === "none") notes.push("isolation.mode none: the probe ran as the worker's own user, exactly as an agent would. FAIL results here are the expected, honest outcome.");
    const leftovers = await kit.cleanup();
    if (leftovers.length) notes.push(`cleanup failed for: ${leftovers.join("; ")}`);
    else notes.push("all canaries and preflight directories were removed");
    return { report: buildReport({ tool: "agent-worker", checks, context, notes }), secrets: kit.secrets };
  } finally {
    await kit.cleanup();
  }
}

function parseArgs(argv) {
  const options = { asAttempt: false, json: false, out: null, config: process.env.AGENT_WORKER_CONFIG ?? null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") options.config = argv[++index];
    else if (arg === "--as-attempt") options.asAttempt = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.config) throw new Error("usage: preflight.mjs --config <config.json> [--as-attempt] [--json] [--out report.json]");
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  // Imported lazily: worker.mjs pulls in the TypeScript contracts.
  const { loadConfig } = await import("./worker.mjs");
  const config = await loadConfig(options.config);
  const { report, secrets } = await runAgentPreflight(config, { asAttempt: options.asAttempt });
  await emitReport(report, { json: options.json, out: options.out, secrets });
  process.exitCode = exitCodeFor(report.overall);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`preflight error: ${error?.message ?? error}\n`);
    process.exit(64);
  });
}
