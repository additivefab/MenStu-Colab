// Runner configuration: JSON file, validated strictly. The runner token is
// never part of the config; it comes from TANYAN_LAB_RUNNER_TOKEN or the file
// named by `tokenFile`.
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class ConfigError extends Error {}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${label} is required`);
  return value.trim();
}

function requireAbsolute(value, label) {
  const path = requireString(value, label);
  if (!isAbsolute(path)) throw new ConfigError(`${label} must be an absolute path`);
  return path;
}

function positiveNumber(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new ConfigError(`${label} must be a positive number`);
  return value;
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== "object") throw new ConfigError("config must be a JSON object");
  if ("token" in raw || "runnerToken" in raw) throw new ConfigError("put the runner token in tokenFile or TANYAN_LAB_RUNNER_TOKEN, never in the config");

  const platformUrl = new URL(requireString(raw.platformUrl, "platformUrl"));
  if (platformUrl.protocol !== "https:" && !(platformUrl.protocol === "http:" && LOCAL_HOSTS.has(platformUrl.hostname))) {
    throw new ConfigError("platformUrl must use HTTPS (plain HTTP is allowed only for localhost)");
  }

  const schedulerType = raw.scheduler?.type;
  if (schedulerType !== "local" && schedulerType !== "slurm") throw new ConfigError("scheduler.type must be local or slurm");

  const datasets = {};
  if (!Array.isArray(raw.datasets)) throw new ConfigError("datasets must be an array");
  for (const [index, entry] of raw.datasets.entries()) {
    const versionId = requireString(entry?.versionId, `datasets[${index}].versionId`);
    datasets[versionId] = {
      versionId,
      dataPath: requireAbsolute(entry.dataPath, `datasets[${index}].dataPath`),
      manifestPath: requireAbsolute(entry.manifestPath, `datasets[${index}].manifestPath`),
      splitManifestPath: entry.splitManifestPath ? requireAbsolute(entry.splitManifestPath, `datasets[${index}].splitManifestPath`) : null,
      // R02: files on disk but not in the manifest are refused unless "ignore".
      extraFiles: entry.extraFiles ?? "reject",
      // R02: sealed immutable snapshot (stat + seal check instead of a full re-hash).
      snapshot: entry.snapshot ? { sealPath: requireAbsolute(entry.snapshot.sealPath, `datasets[${index}].snapshot.sealPath`) } : null,
    };
    if (!["reject", "ignore"].includes(datasets[versionId].extraFiles)) throw new ConfigError(`datasets[${index}].extraFiles must be "reject" or "ignore"`);
  }

  const apptainer = raw.apptainer ?? {};
  if (apptainer.isolationFlags !== undefined && (!Array.isArray(apptainer.isolationFlags) || apptainer.isolationFlags.some((flag) => typeof flag !== "string"))) {
    throw new ConfigError("apptainer.isolationFlags must be a string array");
  }
  if (apptainer.extraFlags !== undefined && (!Array.isArray(apptainer.extraFlags) || apptainer.extraFlags.some((flag) => typeof flag !== "string"))) {
    throw new ConfigError("apptainer.extraFlags must be a string array");
  }

  let gitReadFallback = null;
  if (raw.gitReadFallback) gitReadFallback = { url: requireString(raw.gitReadFallback.url, "gitReadFallback.url") };

  const limits = raw.limits ?? {};
  return {
    platformUrl: platformUrl.href,
    runnerId: requireString(raw.runnerId, "runnerId"),
    tokenFile: raw.tokenFile ? requireAbsolute(raw.tokenFile, "tokenFile") : null,
    workRoot: requireAbsolute(raw.workRoot, "workRoot"),
    nodePath: raw.nodePath ? requireAbsolute(raw.nodePath, "nodePath") : process.execPath,
    git: typeof raw.git === "string" && raw.git ? raw.git : "git",
    githubBaseUrl: typeof raw.githubBaseUrl === "string" && raw.githubBaseUrl ? raw.githubBaseUrl : "https://github.com",
    nvidiaSmi: raw.nvidiaSmi === null ? null : (typeof raw.nvidiaSmi === "string" ? raw.nvidiaSmi : "nvidia-smi"),
    scheduler: { ...raw.scheduler, type: schedulerType },
    apptainer: {
      binary: typeof apptainer.binary === "string" && apptainer.binary ? apptainer.binary : "apptainer",
      isolationFlags: apptainer.isolationFlags,
      extraFlags: apptainer.extraFlags ?? [],
      cwdFlag: apptainer.cwdFlag,
      applyMemoryLimit: apptainer.applyMemoryLimit === true,
      images: apptainer.images ?? {},
      allowPullByDigest: apptainer.allowPullByDigest === true,
      hostEnv: Array.isArray(apptainer.hostEnv) ? apptainer.hostEnv : ["PATH", "HOME", "USER", "LANG", "APPTAINER_CACHEDIR", "APPTAINER_TMPDIR", "XDG_RUNTIME_DIR"],
      forwardIntoContainer: Array.isArray(apptainer.forwardIntoContainer) ? apptainer.forwardIntoContainer : ["CUDA_VISIBLE_DEVICES"],
    },
    datasets,
    gitReadFallback,
    limits: {
      maxConcurrentRuns: Math.floor(positiveNumber(limits.maxConcurrentRuns, 1, "limits.maxConcurrentRuns")),
      heartbeatSeconds: positiveNumber(limits.heartbeatSeconds, 30, "limits.heartbeatSeconds"),
      pollSeconds: positiveNumber(limits.pollSeconds, 15, "limits.pollSeconds"),
      claimIntervalSeconds: positiveNumber(limits.claimIntervalSeconds, 20, "limits.claimIntervalSeconds"),
      killGraceSeconds: positiveNumber(limits.killGraceSeconds, 30, "limits.killGraceSeconds"),
      maxArtifacts: Math.floor(positiveNumber(limits.maxArtifacts, 500, "limits.maxArtifacts")),
      requestTimeoutSeconds: positiveNumber(limits.requestTimeoutSeconds, 60, "limits.requestTimeoutSeconds"),
    },
  };
}

export async function loadConfig(path) {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}

/** Reads the runner token from the environment or tokenFile; warns on loose permissions. */
export async function loadRunnerToken(config, { env = process.env, logger } = {}) {
  const fromEnv = env.TANYAN_LAB_RUNNER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!config.tokenFile) throw new ConfigError("set TANYAN_LAB_RUNNER_TOKEN or tokenFile");
  const info = await stat(config.tokenFile);
  if ((info.mode & 0o077) !== 0) logger?.warn("tokenFile is readable by group/other; chmod 600 recommended");
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  if (!token) throw new ConfigError("tokenFile is empty");
  return token;
}
