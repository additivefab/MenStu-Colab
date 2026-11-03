// Code checkout of exactly one commit into work/<runId>/src.
//
// With a platform-minted token the credential reaches git only through the
// GIT_CONFIG_COUNT/KEY/VALUE environment of the fetch process: it is never in
// argv (visible in `ps`), never in .git/config, and never written to disk. The
// fetch uses a URL argument instead of a named remote, so nothing about the
// source is persisted in the checkout either.
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { runCommand, pickEnv } from "./process.mjs";

export class CheckoutError extends Error {}

const SHA1 = /^[0-9a-f]{40}$/;
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function gitBaseEnv() {
  return {
    ...pickEnv(["PATH", "HOME", "LANG", "SSH_AUTH_SOCK"]),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
}

/**
 * @param {object} options
 * @param {string} options.srcDir     destination (recreated)
 * @param {string} options.commitSha  executedCommitSha
 * @param {object|null} options.repository  claim.repository (token access) or null
 * @param {{url: string}|null} options.fallback  gitReadFallback from config
 * @param {string} options.githubBaseUrl  e.g. https://github.com
 * @param {string} options.git  git binary
 * @param {object} options.logger
 */
export async function checkoutCommit({ srcDir, commitSha, repository, fallback, githubBaseUrl = "https://github.com", git = "git", logger }) {
  if (!SHA1.test(commitSha)) throw new CheckoutError("executedCommitSha is not a 40-hex commit id");
  await rm(srcDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true, mode: 0o700 });
  const baseEnv = gitBaseEnv();
  const gitRun = async (args, extraEnv = {}) => {
    const result = await runCommand(git, args, { cwd: srcDir, env: { ...baseEnv, ...extraEnv }, timeoutMs: 15 * 60_000 });
    if (result.code !== 0) {
      throw new CheckoutError(`git ${args[0]} failed (${result.code}): ${logger.redact(result.stderr.trim()).slice(0, 400)}`);
    }
    return result.stdout.trim();
  };

  await gitRun(["init", "-q", "."]);
  let url;
  let authEnv = {};
  let token = "";
  if (repository?.token) {
    if (!FULL_NAME.test(repository.fullName ?? "")) throw new CheckoutError("repository.fullName is invalid");
    token = repository.token;
    url = `${githubBaseUrl.replace(/\/+$/, "")}/${repository.fullName}.git`;
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    logger.addSecret(token);
    logger.addSecret(header);
    logger.addSecret(Buffer.from(`x-access-token:${token}`).toString("base64"));
    // Ignore the host's global git config and disable credential helpers so no
    // helper can be asked to "store" anything for this fetch.
    authEnv = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: header,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    };
  } else if (fallback?.url) {
    url = fallback.url;
  } else {
    throw new CheckoutError("no repository access: claim returned repository=null and no gitReadFallback is configured");
  }

  await gitRun(["fetch", "-q", "--depth=1", "--no-tags", url, commitSha], authEnv);
  await gitRun(["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD"]);
  const head = await gitRun(["rev-parse", "HEAD"]);
  if (head !== commitSha) throw new CheckoutError(`checked-out HEAD ${head} does not equal executedCommitSha ${commitSha}`);

  const config = await readFile(join(srcDir, ".git", "config"), "utf8");
  if (/extraheader|authorization/i.test(config) || (token && config.includes(token)) || /:\/\/[^/\s]*@/.test(config)) {
    await rm(srcDir, { recursive: true, force: true });
    throw new CheckoutError("credential material found in .git/config after checkout; checkout removed");
  }
  // FETCH_HEAD records the source URL; drop it so only the commit remains.
  await rm(join(srcDir, ".git", "FETCH_HEAD"), { force: true });
  return { head };
}
