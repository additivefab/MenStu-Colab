// Credential profiles live only on the worker: <profilesDir>/<profileId>/
//   codex/          CODEX_HOME holding the ChatGPT sign-in cache (auth.json)
//   claude/oauth_token   output of `claude setup-token`, mode 0600
//   claude/config/  CLAUDE_CONFIG_DIR for that profile (no credentials)
// The platform only knows the opaque profile id. One run per profile at a
// time: Codex rotates refresh tokens in auth.json, so concurrent runs on the
// same cache can invalidate each other.

import { lstat, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

const PROFILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function profileDir(profilesDir, profileId) {
  if (!PROFILE_ID.test(profileId ?? "")) throw new ProfileError("PROFILE_INVALID", "invalid credential profile id");
  return path.join(profilesDir, profileId);
}

/** Fails when a credential file is readable by group/other or is a symlink. */
export async function assertPrivateFile(filePath) {
  const info = await lstat(filePath).catch(() => null);
  if (!info) throw new ProfileError("PROFILE_NOT_FOUND", `credential file missing: ${path.basename(filePath)}`);
  if (!info.isFile()) throw new ProfileError("PROFILE_INSECURE", `credential file is not a regular file: ${path.basename(filePath)}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new ProfileError("PROFILE_INSECURE", `credential file ${path.basename(filePath)} must be mode 0600`);
  }
}

export async function assertPrivateDir(dirPath) {
  const info = await lstat(dirPath).catch(() => null);
  if (!info) throw new ProfileError("PROFILE_NOT_FOUND", `credential directory missing: ${path.basename(dirPath)}`);
  if (!info.isDirectory()) throw new ProfileError("PROFILE_INSECURE", `not a directory: ${path.basename(dirPath)}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new ProfileError("PROFILE_INSECURE", `credential directory ${path.basename(dirPath)} must be mode 0700`);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const inProcessChains = new Map();

/**
 * Exclusive per-profile lock: an in-process queue plus an O_EXCL lock file so
 * two worker processes sharing a profilesDir also serialize. A lock file left
 * by a dead process is removed.
 */
export async function acquireProfileLock(profilesDir, profileId, { signal, pollMs = 250 } = {}) {
  const dir = profileDir(profilesDir, profileId);
  await stat(dir).catch(() => {
    throw new ProfileError("PROFILE_NOT_FOUND", `credential profile ${profileId} is not provisioned on this worker`);
  });
  const lockPath = path.join(dir, ".run.lock");

  const previous = inProcessChains.get(lockPath) ?? Promise.resolve();
  let releaseChain;
  const current = new Promise((resolve) => {
    releaseChain = resolve;
  });
  const chained = previous.then(() => current);
  inProcessChains.set(lockPath, chained);
  try {
    await Promise.race([
      previous,
      new Promise((_, reject) => {
        if (signal?.aborted) reject(signal.reason ?? new Error("aborted"));
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      }),
    ]);
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        await handle.close();
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const holder = await readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
        if (holder && !pidAlive(holder.pid)) {
          await rm(lockPath, { force: true });
          continue;
        }
        await delay(pollMs);
      }
    }
  } catch (error) {
    releaseChain();
    if (inProcessChains.get(lockPath) === chained) inProcessChains.delete(lockPath);
    throw error;
  }

  let released = false;
  return async function release() {
    if (released) return;
    released = true;
    await rm(lockPath, { force: true });
    releaseChain();
    if (inProcessChains.get(lockPath) === chained) inProcessChains.delete(lockPath);
  };
}

/** Ensures the per-profile Claude config dir exists (no credentials in it). */
export async function ensureClaudeConfigDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
