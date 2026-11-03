// Isolated git workspace per attempt: fetch exactly the base commit, keep no
// credentials and no remotes, and turn the agent's working tree into a
// constrained change set (ChangedFile[] + unified diff) against that commit.
//
// R01: the worker never trusts, reads config from, or writes into the
// checkout's .git (the agent can rewrite all of it, including turning entries
// into symlinks or hard links to files outside the workspace). The fetched
// objects, HEAD, index and config live in a separate trusted git directory,
// <attempt>/git, outside the checkout; every worker-side git command runs as
// `git --git-dir=<attempt>/git --work-tree=<attempt>/repo`. Git skips any
// entry named .git in the work tree, so the agent's .git is inert for
// collection. The checkout's .git is still lstat-checked (never followed) and
// any tampering with it refuses collection with WORKSPACE_TAMPERED.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
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

export function runGit(args, { cwd, env, gitDir, workTree, maxBuffer = 64 * 1024 * 1024, encoding = "utf8" } = {}) {
  const location = [...(gitDir ? [`--git-dir=${gitDir}`] : []), ...(workTree ? [`--work-tree=${workTree}`] : [])];
  return new Promise((resolve, reject) => {
    execFile("git", [...SAFE_GIT_FLAGS, ...location, ...args], { cwd, env, maxBuffer, encoding }, (error, stdout, stderr) => {
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

// Settings of the trusted git directory: it is used with an explicit
// --work-tree, never collects garbage behind our back, and never runs hooks.
const TRUSTED_GIT_SETTINGS = [["core.bare", "false"], ["core.hooksPath", "/dev/null"], ["gc.auto", "0"], ["maintenance.auto", "false"]];

/**
 * Creates work/<attemptId>/{repo,home,tmp,git} and fetches exactly
 * baseCommitSha into the trusted git directory `git` (outside the checkout,
 * empty template: no hooks, no info/). The checkout `repo` gets its own .git
 * for the agent to use, reading objects from the trusted store through
 * objects/info/alternates. Returns paths, the trusted config snapshot and the
 * (dev, ino) identities that collection re-verifies.
 */
export async function prepareWorkspace({ work, config, workRoot, redactor }) {
  if (!SHA1.test(work.baseCommitSha ?? "")) throw new WorkspaceError("WORKSPACE_ERROR", "baseCommitSha is not a commit SHA");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(work.attemptId ?? "")) throw new WorkspaceError("WORKSPACE_ERROR", "invalid attemptId");
  const root = path.join(workRoot, work.attemptId);
  const repoDir = path.join(root, "repo");
  const homeDir = path.join(root, "home");
  const tmpDir = path.join(root, "tmp");
  const gitDir = path.join(root, "git");
  await rm(root, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true, mode: 0o700 });
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });

  const source = resolveFetchSource(work, config);
  for (const secret of source.secrets) redactor?.add(secret);
  const baseEnv = gitEnv(homeDir);
  const trusted = { cwd: root, env: baseEnv, gitDir };
  await runGit(["init", "-q", "--bare", "--template=", gitDir], { cwd: root, env: baseEnv });
  for (const [key, value] of TRUSTED_GIT_SETTINGS) await runGit(["config", key, value], trusted);
  try {
    await runGit(["fetch", "-q", "--no-tags", "--depth=1", source.url, work.baseCommitSha], { ...trusted, env: { ...baseEnv, ...source.env } });
  } catch (error) {
    throw new WorkspaceError("WORKSPACE_ERROR", redactor ? redactor.redact(error.message) : "git fetch failed");
  }
  await rm(path.join(gitDir, "FETCH_HEAD"), { force: true });
  await runGit(["update-ref", "--no-deref", "HEAD", work.baseCommitSha], trusted);

  // The agent's checkout: objects come from the trusted store (read-only for
  // git: it never writes into an alternate), nothing is copied or refetched.
  await runGit(["init", "-q", "--initial-branch=tanyan-work", repoDir], { cwd: root, env: baseEnv });
  const dotGit = path.join(repoDir, ".git");
  await writeFile(path.join(dotGit, "objects", "info", "alternates"), `${path.join(gitDir, "objects")}\n`, { flag: "wx" });
  const shallow = await readFile(path.join(gitDir, "shallow")).catch(() => null);
  if (shallow) await writeFile(path.join(dotGit, "shallow"), shallow, { flag: "wx" });
  await runGit(["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", work.baseCommitSha], { cwd: repoDir, env: baseEnv });
  const trustedTree = { cwd: repoDir, env: baseEnv, gitDir, workTree: repoDir };
  await runGit(["read-tree", work.baseCommitSha], trustedTree);
  await runGit(["update-index", "-q", "--refresh"], trustedTree).catch(() => {});

  for (const [label, opts] of [["checkout", { cwd: repoDir, env: baseEnv }], ["trusted git directory", trustedTree]]) {
    const head = (await runGit(["rev-parse", "HEAD"], opts)).trim();
    if (head !== work.baseCommitSha) throw new WorkspaceError("WORKSPACE_ERROR", `${label} HEAD ${head} does not match base ${work.baseCommitSha}`);
    // No remotes (hence no push target), no stored credentials.
    const remotes = (await runGit(["remote"], opts)).trim();
    if (remotes) throw new WorkspaceError("WORKSPACE_ERROR", `${label} unexpectedly has a remote`);
  }
  const trustedGitConfig = await readFile(path.join(gitDir, "config"), "utf8");
  const checkoutGitConfig = await readFile(path.join(dotGit, "config"), "utf8");
  for (const secret of source.secrets) {
    if (trustedGitConfig.includes(secret) || checkoutGitConfig.includes(secret)) throw new WorkspaceError("WORKSPACE_ERROR", "credential leaked into git config");
  }
  const ids = {};
  for (const [name, dir] of [["root", root], ["gitDir", gitDir], ["repoDir", repoDir], ["dotGit", dotGit]]) ids[name] = identityOf(await lstat(dir, { bigint: true }));
  return { root, repoDir, homeDir, tmpDir, gitDir, trustedGitConfig, ids };
}

// --- Tamper checks (R01). Only lstat and O_NOFOLLOW opens: nothing here ever
// follows a link the agent could have planted, and nothing writes.

const tampered = (message) => new WorkspaceError("WORKSPACE_TAMPERED", message);
const identityOf = (info) => ({ dev: info.dev, ino: info.ino });
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

async function lstatOrNull(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw tampered(`cannot inspect ${target}: ${error.code ?? error.message}`);
  }
}

/** A real directory (not a symlink), optionally the same inode as recorded. */
async function expectDirectory(target, label, expected, { optional = false } = {}) {
  const info = await lstatOrNull(target);
  if (!info) {
    if (optional) return null;
    throw tampered(`${label} is missing`);
  }
  if (info.isSymbolicLink()) throw tampered(`${label} is a symbolic link`);
  if (!info.isDirectory()) throw tampered(`${label} is not a directory`);
  if (expected && (info.dev !== expected.dev || info.ino !== expected.ino)) throw tampered(`${label} was replaced`);
  return info;
}

/** A regular file (not a symlink) with exactly one hard link. */
async function expectRegularFile(target, label, { optional = false } = {}) {
  const info = await lstatOrNull(target);
  if (!info) {
    if (optional) return null;
    throw tampered(`${label} is missing`);
  }
  if (info.isSymbolicLink()) throw tampered(`${label} is a symbolic link`);
  if (!info.isFile()) throw tampered(`${label} is not a regular file`);
  if (info.nlink !== 1n) throw tampered(`${label} has ${info.nlink} hard links`);
  return info;
}

/** Reads a regular, singly-linked file without following a final symlink
 * and without blocking on a FIFO. */
async function readNoFollow(target, label) {
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    throw tampered(`cannot open ${label} without following links: ${error.code ?? error.message}`);
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw tampered(`${label} is not a regular file`);
    if (info.nlink !== 1n) throw tampered(`${label} has ${info.nlink} hard links`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The checkout's .git chain must be untouched in shape: real directories
 * (the same inodes as at checkout) and a regular, singly-linked config. The
 * worker never uses this metadata; a mismatch means the agent tampered with
 * it, and collection refuses rather than guess what else it changed. */
async function verifyCheckoutGit(workspace) {
  const ids = workspace.ids ?? {};
  await expectDirectory(workspace.repoDir, "the checkout", ids.repoDir);
  const dotGit = path.join(workspace.repoDir, ".git");
  await expectDirectory(dotGit, ".git", ids.dotGit);
  await expectRegularFile(path.join(dotGit, "config"), ".git/config");
  await expectDirectory(path.join(dotGit, "hooks"), ".git/hooks", null, { optional: true });
  if (await expectDirectory(path.join(dotGit, "info"), ".git/info", null, { optional: true })) {
    await expectRegularFile(path.join(dotGit, "info", "attributes"), ".git/info/attributes", { optional: true });
  }
}

/** The trusted git directory must be the one created at prepare time, still
 * carry the exact config snapshot, and still have no hooks/ or info/. */
async function verifyTrustedGit(workspace) {
  const ids = workspace.ids ?? {};
  await expectDirectory(workspace.root, "the attempt directory", ids.root);
  await expectDirectory(workspace.gitDir, "the trusted git directory", ids.gitDir);
  for (const name of ["hooks", "info"]) {
    if (await lstatOrNull(path.join(workspace.gitDir, name))) throw tampered(`the trusted git directory gained ${name}/`);
  }
  const config = await readNoFollow(path.join(workspace.gitDir, "config"), "the trusted git config");
  if (!config.equals(Buffer.from(workspace.trustedGitConfig, "utf8"))) throw tampered("the trusted git config was modified");
}

async function verifyWorkspace(workspace) {
  if (!workspace.gitDir || !workspace.trustedGitConfig) throw new WorkspaceError("WORKSPACE_ERROR", "workspace has no trusted git directory");
  await verifyTrustedGit(workspace);
  await verifyCheckoutGit(workspace);
}

/** Runs git against the trusted git directory with the checkout as work tree,
 * re-verifying the whole chain immediately before and after, so a directory
 * swapped in between is detected. `workspace.testHooks.afterVerify` is a test
 * seam to simulate that race. */
async function trustedGit(workspace, args, { encoding } = {}) {
  await verifyWorkspace(workspace);
  await workspace.testHooks?.afterVerify?.(args);
  const output = await runGit(args, { cwd: workspace.repoDir, env: gitEnv(workspace.homeDir), gitDir: workspace.gitDir, workTree: workspace.repoDir, encoding });
  await verifyWorkspace(workspace);
  return output;
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
 * symlinks, submodules and anything that is not a regular file. Runs only
 * against the trusted git directory; refuses with WORKSPACE_TAMPERED when the
 * checkout's .git chain or the trusted directory was tampered with.
 * @returns {Promise<{files: import("../../lib/research-loop/contracts.ts").ChangedFile[], unifiedDiff: string, totalBytes: number}>}
 */
export async function collectChanges(workspace, baseCommitSha) {
  await trustedGit(workspace, ["add", "-A", "--", "."]);
  const raw = await trustedGit(workspace, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommitSha], { encoding: "buffer" });
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
    const content = await trustedGit(workspace, ["cat-file", "blob", entry.newSha], { encoding: "buffer" });
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
    ? await trustedGit(workspace, ["diff", "--cached", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommitSha])
    : "";
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, unifiedDiff, totalBytes };
}

/**
 * Plan mode (FB2): every path that differs from the base commit, including
 * untracked and ignored files, against the trusted index and HEAD (the
 * agent's own .git/index is never consulted). Empty means the checkout is clean.
 * @returns {Promise<string[]>}
 */
export async function workspaceChanges(workspace) {
  const raw = await trustedGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames"]);
  return raw.split("\0").filter(Boolean).map((entry) => entry.slice(3)).sort();
}

/** Plan mode (FB2): throws away every change (tracked, untracked, ignored)
 * so the checkout matches the base commit again. */
export async function discardChanges(workspace, baseCommitSha) {
  await trustedGit(workspace, ["reset", "-q", "--hard", baseCommitSha]);
  await trustedGit(workspace, ["clean", "-q", "-f", "-f", "-d", "-x"]);
  const left = await workspaceChanges(workspace);
  if (left.length) throw new WorkspaceError("WORKSPACE_TAMPERED", `could not discard plan-mode changes: ${left.slice(0, 20).join(", ")}`);
}

export async function removeWorkspace(root) {
  await rm(root, { recursive: true, force: true });
}
