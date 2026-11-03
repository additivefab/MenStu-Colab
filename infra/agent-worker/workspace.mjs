// Isolated git workspace per attempt: fetch exactly the base commit, keep no
// credentials and no remotes, and turn the agent's working tree into a
// constrained change set (ChangedFile[] + unified diff) against that commit.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeRepoPath } from "../../lib/research-loop/contracts.ts";

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

/** Environment for every git command the worker runs: no system/global
 * config, no prompts, no inherited credentials helpers. */
export function gitEnv(homeDir, extra = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeDir,
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
}

// Options that neutralize repository-controlled execution during collection:
// hooks, fsmonitor, external diff and textconv drivers.
const SAFE_GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"];

export function runGit(args, { cwd, env, maxBuffer = 64 * 1024 * 1024, encoding = "utf8" } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", [...SAFE_GIT_FLAGS, ...args], { cwd, env, maxBuffer, encoding }, (error, stdout, stderr) => {
      if (error) {
        const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
        const wrapped = new Error(`git ${args[0]} failed: ${detail.trim().slice(0, 500) || error.message}`);
        wrapped.gitArgs = args;
        reject(wrapped);
      } else resolve(stdout);
    });
  });
}

const SHA1 = /^[0-9a-f]{40}$/;

/** Resolves where to fetch from. Platform-minted token (preferred) or the
 * worker's configured fallback (deploy key / local mirror) when `repository`
 * is null. The token never enters argv, .git/config or the remote list: it is
 * supplied as a one-shot http.extraHeader through GIT_CONFIG_* env vars. */
export function resolveFetchSource(work, config) {
  const fullName = work.repository?.fullName ?? work.repositoryFullName;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName ?? "")) throw new WorkspaceError("WORKSPACE_ERROR", "invalid repository full name");
  if (work.repository?.token) {
    const base = (config.githubBaseUrl ?? "https://github.com").replace(/\/+$/, "");
    const url = `${base}/${fullName}.git`;
    const basic = Buffer.from(`x-access-token:${work.repository.token}`).toString("base64");
    return {
      url,
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${base}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` },
      secrets: [work.repository.token, basic],
    };
  }
  const fallback = config.gitReadFallback;
  if (!fallback?.urlTemplate) throw new WorkspaceError("NO_READ_ACCESS", "platform returned no read token and gitReadFallback is not configured");
  const url = fallback.urlTemplate.replaceAll("{fullName}", fullName);
  const env = {};
  if (fallback.sshKeyFile) {
    const knownHosts = fallback.knownHostsFile ? ` -o UserKnownHostsFile=${fallback.knownHostsFile}` : "";
    env.GIT_SSH_COMMAND = `ssh -i ${fallback.sshKeyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes${knownHosts}`;
  }
  return { url, env, secrets: [] };
}

/**
 * Creates work/<attemptId>/{repo,home,tmp}, fetches exactly baseCommitSha and
 * checks it out detached. Returns paths plus a snapshot of the trusted
 * .git/config used to restore it before collection.
 */
export async function prepareWorkspace({ work, config, workRoot, redactor }) {
  if (!SHA1.test(work.baseCommitSha ?? "")) throw new WorkspaceError("WORKSPACE_ERROR", "baseCommitSha is not a commit SHA");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(work.attemptId ?? "")) throw new WorkspaceError("WORKSPACE_ERROR", "invalid attemptId");
  const root = path.join(workRoot, work.attemptId);
  const repoDir = path.join(root, "repo");
  const homeDir = path.join(root, "home");
  const tmpDir = path.join(root, "tmp");
  await rm(root, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true, mode: 0o700 });
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });

  const source = resolveFetchSource(work, config);
  for (const secret of source.secrets) redactor?.add(secret);
  const baseEnv = gitEnv(homeDir);
  await runGit(["init", "-q", "--initial-branch=tanyan-work", repoDir], { cwd: root, env: baseEnv });
  try {
    await runGit(["fetch", "-q", "--no-tags", "--depth=1", source.url, work.baseCommitSha], { cwd: repoDir, env: { ...baseEnv, ...source.env } });
  } catch (error) {
    throw new WorkspaceError("WORKSPACE_ERROR", redactor ? redactor.redact(error.message) : "git fetch failed");
  }
  await runGit(["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", work.baseCommitSha], { cwd: repoDir, env: baseEnv });
  const head = (await runGit(["rev-parse", "HEAD"], { cwd: repoDir, env: baseEnv })).trim();
  if (head !== work.baseCommitSha) throw new WorkspaceError("WORKSPACE_ERROR", `HEAD ${head} does not match base ${work.baseCommitSha}`);

  // No remotes (hence no push target), no stored credentials.
  const remotes = (await runGit(["remote"], { cwd: repoDir, env: baseEnv })).trim();
  if (remotes) throw new WorkspaceError("WORKSPACE_ERROR", "workspace unexpectedly has a remote");
  const gitConfigPath = path.join(repoDir, ".git", "config");
  const gitConfig = await readFile(gitConfigPath, "utf8");
  for (const secret of source.secrets) {
    if (gitConfig.includes(secret)) throw new WorkspaceError("WORKSPACE_ERROR", "credential leaked into .git/config");
  }
  await rm(path.join(repoDir, ".git", "FETCH_HEAD"), { force: true });
  return { root, repoDir, homeDir, tmpDir, trustedGitConfig: gitConfig };
}

/** Restores repository-controlled git state the agent could have planted
 * (config filters, hooks, info/attributes) before the worker runs git on it. */
async function restoreTrustedGitState(workspace) {
  const gitDir = path.join(workspace.repoDir, ".git");
  const info = await lstat(gitDir).catch(() => null);
  if (!info?.isDirectory()) throw new WorkspaceError("WORKSPACE_TAMPERED", ".git is no longer a directory");
  await writeFile(path.join(gitDir, "config"), workspace.trustedGitConfig);
  await rm(path.join(gitDir, "hooks"), { recursive: true, force: true });
  await rm(path.join(gitDir, "info", "attributes"), { force: true });
}

function parseRawDiff(buffer) {
  // git diff --raw -z: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0"
  const parts = buffer.toString("utf8").split("\0");
  const entries = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const header = parts[index];
    if (!header) break;
    const [oldMode, newMode, oldSha, newSha, status] = header.replace(/^:/, "").split(" ");
    entries.push({ oldMode, newMode, oldSha, newSha, status: status[0], path: parts[index + 1] });
  }
  return entries;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Collects the change set against the base commit, binary-safe. Rejects
 * symlinks, submodules and anything that is not a regular file.
 * @returns {Promise<{files: import("../../lib/research-loop/contracts.ts").ChangedFile[], unifiedDiff: string, totalBytes: number}>}
 */
export async function collectChanges(workspace, baseCommitSha) {
  await restoreTrustedGitState(workspace);
  const env = gitEnv(workspace.homeDir);
  const opts = { cwd: workspace.repoDir, env };
  await runGit(["add", "-A", "--", "."], opts);
  const raw = await runGit(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommitSha], { ...opts, encoding: "buffer" });
  const entries = parseRawDiff(raw);
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const repoPath = normalizeRepoPath(entry.path);
    if (entry.status === "D") {
      files.push({ path: repoPath, action: "delete" });
      continue;
    }
    if (!["A", "M", "T"].includes(entry.status)) throw new WorkspaceError("UNSUPPORTED_CHANGE", `unsupported change status ${entry.status} for ${repoPath}`);
    if (entry.newMode !== "100644" && entry.newMode !== "100755") {
      throw new WorkspaceError("UNSUPPORTED_CHANGE", `only regular files can be changed (${repoPath} has mode ${entry.newMode})`);
    }
    const content = await runGit(["cat-file", "blob", entry.newSha], { ...opts, encoding: "buffer" });
    totalBytes += content.length;
    files.push({
      path: repoPath,
      action: entry.status === "A" ? "add" : "modify",
      contentBase64: content.toString("base64"),
      sha256: sha256(content),
      mode: entry.newMode,
    });
  }
  const unifiedDiff = files.length
    ? await runGit(["diff", "--cached", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommitSha], opts)
    : "";
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, unifiedDiff, totalBytes };
}

/**
 * Plan mode (FB2): every path that differs from the base commit, including
 * untracked and ignored files and index-only changes. Runs on the restored
 * trusted git state, like collectChanges. Empty means the checkout is clean.
 * @returns {Promise<string[]>}
 */
export async function workspaceChanges(workspace) {
  await restoreTrustedGitState(workspace);
  const opts = { cwd: workspace.repoDir, env: gitEnv(workspace.homeDir) };
  const raw = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames"], opts);
  return raw.split("\0").filter(Boolean).map((entry) => entry.slice(3)).sort();
}

/** Plan mode (FB2): throws away every change (tracked, untracked, ignored)
 * so the checkout matches the base commit again. */
export async function discardChanges(workspace, baseCommitSha) {
  await restoreTrustedGitState(workspace);
  const opts = { cwd: workspace.repoDir, env: gitEnv(workspace.homeDir) };
  await runGit(["reset", "-q", "--hard", baseCommitSha], opts);
  await runGit(["clean", "-q", "-f", "-f", "-d", "-x"], opts);
  const left = await workspaceChanges(workspace);
  if (left.length) throw new WorkspaceError("WORKSPACE_TAMPERED", `could not discard plan-mode changes: ${left.slice(0, 20).join(", ")}`);
}

export async function removeWorkspace(root) {
  await rm(root, { recursive: true, force: true });
}
