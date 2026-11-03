// Per-attempt launcher for the agent worker (isolation modes
// "per_attempt_uid" and "container").
//
// The adapters start one provider binary per attempt: the Claude adapter
// spawns `claudePath`, and the Codex SDK spawns `codexPathOverride` (it runs
// `codex exec`; the SDK itself only orchestrates in the worker process, every
// agent tool call runs inside that child). In an isolated mode the worker
// points both at a small generated stub that calls `main()` below. The stub:
//
//   1. derives the attempt from the child environment the adapter built
//      (HOME=<workRoot>/<attemptId>/home, TMPDIR=<...>/tmp,
//      CODEX_HOME=<profilesDir>/<id>/codex or
//      CLAUDE_CONFIG_DIR=<profilesDir>/<id>/claude/config) and refuses
//      anything that does not match that layout;
//   2. expands the operator's launcher argv template (no shell) with that
//      attempt's paths only;
//   3. execs it with the provider's original arguments appended, forwarding
//      SIGINT/SIGTERM and the exit status.
//
// The launcher itself (sudo helper, podman/docker/apptainer) is what makes the
// isolation real. Run the preflight with --as-attempt semantics on the host to
// prove it (docs/ops/主机隔离验收.md).

import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PLACEHOLDERS = Object.freeze(["binary", "provider", "attemptId", "attemptDir", "repoDir", "homeDir", "tmpDir", "profileId", "profileDir", "envNames", "envFlags"]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export class LauncherError extends Error {
  constructor(message) {
    super(message);
    this.name = "LauncherError";
    this.code = "ISOLATION_LAUNCH_REFUSED";
  }
}

/** Derives the attempt paths from the environment an adapter gives its child. */
export function deriveAttemptContext(env, provider, { workRoot, profilesDir }) {
  const root = path.resolve(workRoot);
  const profiles = path.resolve(profilesDir);
  const homeDir = env.HOME ? path.resolve(env.HOME) : "";
  if (!homeDir || path.basename(homeDir) !== "home") throw new LauncherError("HOME is not an attempt home directory");
  const attemptDir = path.dirname(homeDir);
  const attemptId = path.basename(attemptDir);
  if (path.dirname(attemptDir) !== root || !ID.test(attemptId)) throw new LauncherError("HOME is not under workRoot/<attemptId>/home");
  const tmpDir = path.join(attemptDir, "tmp");
  if (!env.TMPDIR || path.resolve(env.TMPDIR) !== tmpDir) throw new LauncherError("TMPDIR is not the attempt's tmp directory");

  let profileDir;
  if (provider === "codex") {
    const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : "";
    if (path.basename(codexHome) !== "codex") throw new LauncherError("CODEX_HOME is not <profile>/codex");
    profileDir = path.dirname(codexHome);
  } else if (provider === "claude") {
    const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : "";
    if (path.basename(configDir) !== "config" || path.basename(path.dirname(configDir)) !== "claude") throw new LauncherError("CLAUDE_CONFIG_DIR is not <profile>/claude/config");
    profileDir = path.dirname(path.dirname(configDir));
  } else {
    throw new LauncherError(`unknown provider ${provider}`);
  }
  const profileId = path.basename(profileDir);
  if (path.dirname(profileDir) !== profiles || !ID.test(profileId)) throw new LauncherError("credential profile is not directly under profilesDir");

  return {
    provider,
    attemptId,
    attemptDir,
    repoDir: path.join(attemptDir, "repo"),
    homeDir,
    tmpDir,
    profileId,
    profileDir,
    envNames: Object.keys(env).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort(),
  };
}

/**
 * Expands the argv template. An element that is exactly "{envFlags}" becomes
 * [envFlag, NAME, envFlag, NAME, ...] (names only: the runtime reads the
 * values from the launcher's environment, so no secret lands in argv).
 * "{envNames}" inside an element becomes NAME,NAME,... (for
 * `sudo --preserve-env=`). Unknown placeholders are an error.
 */
export function expandLauncherArgv(template, ctx, { envFlag } = {}) {
  const out = [];
  for (const element of template) {
    if (element === "{envFlags}") {
      if (!envFlag) throw new LauncherError("launcher.envFlag is required when the template uses {envFlags}");
      for (const name of ctx.envNames ?? []) out.push(envFlag, name);
      continue;
    }
    out.push(element.replace(/\{([A-Za-z]+)\}/g, (match, name) => {
      if (!PLACEHOLDERS.includes(name) || name === "envFlags") throw new LauncherError(`unknown launcher placeholder ${match}`);
      if (name === "envNames") return (ctx.envNames ?? []).join(",");
      const value = ctx[name];
      if (typeof value !== "string" || !value) throw new LauncherError(`launcher placeholder ${match} has no value`);
      return value;
    }));
  }
  return out;
}

const HOST_NAMESPACE = /^--(?:net|network|pid|ipc|uts|userns)=host$/;
const NAMESPACE_FLAG = /^--(?:net|network|pid|ipc|uts|userns)$/;

/**
 * Static checks on the launcher config. They catch obvious mistakes (whole
 * profilesDir mounted, docker socket, host network); they do not prove
 * isolation. Returns a list of problems (empty = acceptable).
 */
export function validateLauncherConfig(launcher, { mode, workRoot, profilesDir }) {
  const problems = [];
  const argv = launcher?.argv;
  if (!Array.isArray(argv) || !argv.length || argv.some((element) => typeof element !== "string" || !element)) {
    return [`isolation.launcher.argv must be a non-empty array of strings for mode ${mode}`];
  }
  if (!path.isAbsolute(argv[0])) problems.push("isolation.launcher.argv[0] must be an absolute path");
  const joined = argv.join("\u0000");
  if (!joined.includes("{binary}")) problems.push("isolation.launcher.argv must contain {binary} (the provider binary inside the isolated context)");
  if (!joined.includes("{profileDir}")) problems.push("isolation.launcher.argv must reference {profileDir}: only this attempt's profile may be made available");
  if (!joined.includes("{repoDir}") && !joined.includes("{attemptDir}")) problems.push("isolation.launcher.argv must reference {repoDir} or {attemptDir}: only this attempt's workspace may be made available");
  for (const [label, dir] of [["profilesDir", profilesDir], ["workRoot", workRoot]]) {
    const resolved = dir ? path.resolve(dir) : null;
    if (resolved && argv.some((element) => element.includes(resolved))) problems.push(`isolation.launcher.argv must not name ${label} (${resolved}) directly; use {profileDir}/{repoDir} so only one attempt is exposed`);
  }
  if (argv.some((element) => /docker\.sock|podman\.sock|containerd\.sock/.test(element))) problems.push("isolation.launcher.argv must not expose a container runtime socket");
  if (argv.some((element) => element === "--privileged" || HOST_NAMESPACE.test(element))) problems.push("isolation.launcher.argv must not use --privileged or host namespaces");
  argv.forEach((element, index) => {
    if (NAMESPACE_FLAG.test(element) && argv[index + 1] === "host") problems.push(`isolation.launcher.argv must not use ${element} host`);
  });
  if (joined.includes("{envFlags}") && !launcher.envFlag) problems.push("isolation.launcher.envFlag is required when argv uses {envFlags}");
  for (const provider of ["codex", "claude"]) {
    const binary = launcher.binaries?.[provider];
    if (binary !== undefined && binary !== null && (typeof binary !== "string" || !path.isAbsolute(binary))) problems.push(`isolation.launcher.binaries.${provider} must be an absolute path`);
  }
  if (!launcher.binaries?.codex && !launcher.binaries?.claude) problems.push("isolation.launcher.binaries needs at least one of codex / claude");
  return problems;
}

/**
 * Writes the executable stub the adapter will spawn instead of the provider
 * binary. The stub embeds only non-secret launcher settings.
 */
export async function writeLauncherStub({ dir, provider, launcher, workRoot, profilesDir, nodePath = process.execPath }) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const spec = {
    provider,
    binary: launcher.binaries?.[provider] ?? null,
    argv: launcher.argv,
    envFlag: launcher.envFlag ?? null,
    workRoot: path.resolve(workRoot),
    profilesDir: path.resolve(profilesDir),
  };
  const moduleUrl = import.meta.url;
  const stubPath = path.join(dir, `launch-${provider}`);
  await writeFile(stubPath, `#!${nodePath}\n// Generated by the tanyan agent worker at startup. Do not edit.\nimport(${JSON.stringify(moduleUrl)}).then((m) => m.main(${JSON.stringify(spec)}));\n`, { mode: 0o700 });
  await chmod(stubPath, 0o700);
  return stubPath;
}

/** Stub entry point. */
export function main(spec, { argv = process.argv.slice(2), env = process.env } = {}) {
  let command;
  try {
    if (!spec.binary) throw new LauncherError(`no isolated binary configured for ${spec.provider} (isolation.launcher.binaries.${spec.provider}); refusing to run it unisolated`);
    const ctx = { ...deriveAttemptContext(env, spec.provider, spec), binary: spec.binary };
    command = expandLauncherArgv(spec.argv, ctx, { envFlag: spec.envFlag });
  } catch (error) {
    process.stderr.write(`tanyan launcher: ${error.message}\n`);
    process.exit(126);
    return;
  }
  const child = spawn(command[0], [...command.slice(1), ...argv], { stdio: "inherit", env, shell: false });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.once("error", (error) => {
    process.stderr.write(`tanyan launcher: could not start ${command[0]}: ${error.code ?? error.message}\n`);
    process.exit(127);
  });
  child.once("close", (code, signal) => process.exit(code ?? (signal === "SIGKILL" ? 137 : 143)));
}
