// Step 4: register the demo's lab side through the superadmin APIs, exactly as
// an operator would: GitHub installation + repository link (answered by the
// double), an agent worker and a compute runner (tokens kept in the gitignored
// .wrangler/demo-loop/secrets.json, mode 0600), credential profiles for the
// synthetic student, an entrypoint, a dataset with its manifest hash, a grant.
// Re-running reuses whatever is still registered and active.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  AGENT_RUNNER_LABEL, COMPUTE_RUNNER_LABEL, DATASET_LABEL, ENTRYPOINT_NAME, FULL_NAME, IMAGE_REF, INSTALLATION_ID, REPO_ID,
  SECRETS_FILE, STATE_DIR, STUDENT_ID,
} from "./constants.mjs";
import { EVALUATION_PROTOCOL_SHA256 } from "./demo-repo.mjs";
import { PlatformError } from "./platform-api.mjs";

export const ENTRYPOINT_ARGV = ["node", "train.mjs"];
export const PARAMS_SCHEMA = {
  epochs: { type: "integer", default: 3, minimum: 1, maximum: 20 },
  seed: { type: "integer", default: 7, minimum: 0, maximum: 1000 },
};
export const EGRESS_POLICY = {
  schema: "tanyan.egress/v1", allowedExtensions: [".json", ".csv", ".log"], maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000,
  allowImages: false, blockDatasetHashMatches: true,
};
// Only codex: it re-points the seed's own profile (cred_synthstudent), which
// `seed-research-loop.mjs --reset` deletes. A new profile row for another
// provider would reference the seed's student user and block that reset.
export const PROVIDERS = ["codex"];

function readSecrets() {
  try { return JSON.parse(readFileSync(SECRETS_FILE, "utf8")); } catch { return {}; }
}
function writeSecrets(secrets) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(SECRETS_FILE, 0o600);
}

export class GithubWiringError extends Error {}

/**
 * Checks that the dev server talks to the double: GitHub App configured and an
 * installation sync that actually reaches the double with a JWT signed by the
 * demo key. Throws GithubWiringError with the restart advice otherwise.
 */
export async function verifyGithubWiring(api, fakeGithub) {
  const state = await api.get("admin", "/api/admin/github");
  if (!state.configured?.app || !state.configured?.webhook) {
    throw new GithubWiringError("开发服务器还没有读取到演示用的 GitHub App 环境变量（.env.local）。请重启 `npm run dev` 后再运行本脚本。");
  }
  const before = fakeGithub.stats.appCalls;
  const rejectedBefore = fakeGithub.stats.jwtRejected;
  try {
    const synced = await api.post("admin", "/api/admin/github", { action: "sync_installations" });
    if (fakeGithub.stats.appCalls === before) throw new Error("the double saw no App call");
    if (!(synced.result?.synced >= 1)) throw new Error("installation sync returned nothing");
  } catch (error) {
    if (fakeGithub.stats.jwtRejected > rejectedBefore) {
      throw new GithubWiringError(`开发服务器在用旧的 App 私钥（${fakeGithub.stats.lastJwtError}）。请重启 \`npm run dev\`。`);
    }
    if (fakeGithub.stats.appCalls === before) {
      throw new GithubWiringError("开发服务器没有访问本地 GitHub 替身：要么还没重启以读取 GITHUB_API_BASE_URL，要么运行的代码还不支持该变量（需要包含 lib/github/http.ts 覆盖的版本）。请更新代码并重启 `npm run dev`。");
    }
    throw error;
  }
  const link = await api.post("admin", "/api/admin/github", { action: "link_repository", studentId: STUDENT_ID });
  if (link.result?.repositoryId !== REPO_ID || link.result?.installationId !== INSTALLATION_ID || link.result?.fullName !== FULL_NAME) {
    throw new Error(`unexpected repository link: ${JSON.stringify(link.result)}`);
  }
  return link.result;
}

async function ensureRunner(api, registry, secrets, key, kind, label) {
  const stored = secrets[key];
  const known = stored && registry.runners.find((runner) => runner.id === stored.id && runner.kind === kind && runner.status === "active");
  if (known && typeof stored.token === "string" && stored.token) return { id: stored.id, token: stored.token, reused: true };
  const created = await api.post("admin", "/api/admin/lab", { action: "register_runner", label, kind });
  secrets[key] = { id: created.runner.id, token: created.token, kind, note: "LOCAL demo token (synthetic); never reuse elsewhere" };
  writeSecrets(secrets);
  return { id: created.runner.id, token: created.token, reused: false };
}

export async function registerLabSide(api, { dataset, profilesDir }) {
  const secrets = readSecrets();
  let registry = await api.get("admin", "/api/admin/lab");
  const agent = await ensureRunner(api, registry, secrets, "agentWorker", "agent", AGENT_RUNNER_LABEL);
  const compute = await ensureRunner(api, registry, secrets, "computeRunner", "compute", COMPUTE_RUNNER_LABEL);
  registry = await api.get("admin", "/api/admin/lab");

  // Credential profiles: the platform stores only user ↔ provider ↔ worker.
  const session = await api.get("student", "/api/auth/session");
  const studentUserId = Number(session.user?.id);
  if (!Number.isSafeInteger(studentUserId)) throw new Error("could not read the synthetic student's user id");
  let listing = await api.get("admin", "/api/admin/agent-credential-profiles");
  for (const provider of PROVIDERS) {
    const active = listing.profiles.find((profile) => profile.userId === studentUserId && profile.provider === provider && profile.active);
    if (active?.workerId === agent.id) continue;
    if (active) await api.post("admin", "/api/admin/agent-credential-profiles", { action: "deactivate", id: active.id });
    listing = await api.post("admin", "/api/admin/agent-credential-profiles", { action: "create", userId: studentUserId, provider, workerId: agent.id });
  }
  const profiles = listing.profiles.filter((profile) => profile.userId === studentUserId && profile.active && profile.workerId === agent.id);
  // Operator step on the worker host: one private directory per profile. The
  // fake adapter needs no subscription files inside it.
  for (const profile of profiles) {
    mkdirSync(path.join(profilesDir, profile.id), { recursive: true, mode: 0o700 });
    chmodSync(path.join(profilesDir, profile.id), 0o700);
  }

  let entrypoint = registry.entrypoints.find((item) => item.active && item.name === ENTRYPOINT_NAME && item.githubRepositoryId === REPO_ID
    && item.imageRef === IMAGE_REF && item.evaluationProtocolSha256 === EVALUATION_PROTOCOL_SHA256
    && JSON.stringify(item.argv) === JSON.stringify(ENTRYPOINT_ARGV) && JSON.stringify(item.paramsSchema) === JSON.stringify(PARAMS_SCHEMA));
  if (!entrypoint) {
    entrypoint = (await api.post("admin", "/api/admin/lab", {
      action: "register_entrypoint", studentId: STUDENT_ID, name: ENTRYPOINT_NAME, argv: ENTRYPOINT_ARGV, imageRef: IMAGE_REF,
      evaluationProtocolSha256: EVALUATION_PROTOCOL_SHA256, paramsSchema: PARAMS_SCHEMA,
    })).entrypoint;
  }
  let datasetVersion = registry.datasets.find((item) => item.active && item.label === DATASET_LABEL && item.runnerId === compute.id
    && item.manifestSha256 === dataset.manifestSha256 && item.splitManifestSha256 === dataset.splitManifestSha256);
  if (!datasetVersion) {
    datasetVersion = (await api.post("admin", "/api/admin/lab", {
      action: "register_dataset", label: DATASET_LABEL, runnerId: compute.id, manifestSha256: dataset.manifestSha256,
      splitManifestSha256: dataset.splitManifestSha256, egressPolicy: EGRESS_POLICY,
    })).dataset;
  }
  await api.post("admin", "/api/admin/lab", { action: "grant_dataset", datasetVersionId: datasetVersion.id, studentId: STUDENT_ID });
  return { agent, compute, profiles, studentUserId, entrypoint, datasetVersion };
}

export { PlatformError };
