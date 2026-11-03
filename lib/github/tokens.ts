import { env } from "cloudflare:workers";
import type { RepositoryReadAccess } from "../research-loop/contracts.ts";
import { GithubKeyFormatError, createAppJwt, importAppPrivateKey } from "./app-jwt.ts";
import { GithubApiError, githubJson } from "./http.ts";

// GitHub App credentials and installation tokens. Every installation token the
// platform mints is narrowed to exactly one repository (by stable ID) and to
// the minimum permissions of its caller; the App's broader installation
// access is never handed to a lab process or used for another student.
// Docs: POST /app/installations/{installation_id}/access_tokens accepts
// `repository_ids` and `permissions`; tokens expire after one hour.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      GITHUB_APP_ID?: string;
      /** PKCS#8 PEM (PKCS#1 also accepted); `\n`-escaped values are tolerated. */
      GITHUB_APP_PRIVATE_KEY?: string;
      GITHUB_WEBHOOK_SECRET?: string;
      /** Optional App slug; webhook events sent by `<slug>[bot]` are platform echoes. */
      GITHUB_APP_SLUG?: string;
    }
  }
}

export class GithubNotConfiguredError extends Error {}

export type RepositoryTokenPermissions = {
  contents?: "read" | "write";
  pull_requests?: "read" | "write";
  metadata?: "read";
};

export type InstallationToken = {
  token: string;
  expiresAt: string;
  repositories: { id: number; fullName: string; defaultBranch: string | null }[];
};

function configValue(name: "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_WEBHOOK_SECRET" | "GITHUB_APP_SLUG") {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function githubWebhookSecret() {
  return configValue("GITHUB_WEBHOOK_SECRET");
}

export function githubAppSlug() {
  return configValue("GITHUB_APP_SLUG");
}

export function githubAppId() {
  return configValue("GITHUB_APP_ID");
}

export function isGithubAppConfigured() {
  return Boolean(configValue("GITHUB_APP_ID") && configValue("GITHUB_APP_PRIVATE_KEY"));
}

let cachedKey: { pem: string; key: Promise<CryptoKey> } | null = null;

/** Short-lived App JWT (RS256). Throws GithubNotConfiguredError without credentials. */
export async function createGithubAppJwt() {
  const appId = configValue("GITHUB_APP_ID");
  const pem = configValue("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !pem) throw new GithubNotConfiguredError("GitHub App 尚未配置");
  if (!cachedKey || cachedKey.pem !== pem) {
    const key = importAppPrivateKey(pem);
    cachedKey = { pem, key };
    key.catch(() => { if (cachedKey?.key === key) cachedKey = null; });
  }
  let key: CryptoKey;
  try { key = await cachedKey.key; } catch (error) {
    // A malformed key is a configuration problem: callers handle it like a
    // missing App (e.g. lab claims hand out `repository: null`).
    if (error instanceof GithubKeyFormatError) throw new GithubNotConfiguredError(error.message);
    throw error;
  }
  return createAppJwt(appId, key);
}

type AccessTokenResponse = {
  token: string;
  expires_at: string;
  repositories?: { id: number; full_name: string; default_branch?: string }[];
};

function positiveId(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} 无效`);
  return value;
}

/** Mints an installation token narrowed to one repository by stable ID. */
export async function mintSingleRepositoryToken(input: {
  installationId: number;
  repositoryId: number;
  permissions: RepositoryTokenPermissions;
}): Promise<InstallationToken> {
  const installationId = positiveId(input.installationId, "installationId");
  const repositoryId = positiveId(input.repositoryId, "repositoryId");
  const jwt = await createGithubAppJwt();
  const data = await githubJson<AccessTokenResponse>(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    bearer: jwt,
    body: { repository_ids: [repositoryId], permissions: input.permissions },
    context: "签发仓库令牌",
  });
  const repositories = (data.repositories ?? []).map((repository) => ({
    id: Number(repository.id), fullName: String(repository.full_name), defaultBranch: repository.default_branch ?? null,
  }));
  // The narrowed token must cover exactly the requested repository.
  if (typeof data.token !== "string" || !data.token || repositories.length !== 1 || repositories[0].id !== repositoryId) {
    throw new GithubApiError(502, "token scope mismatch", "签发仓库令牌");
  }
  return { token: data.token, expiresAt: String(data.expires_at), repositories };
}

/** Mints an installation token narrowed to repository names (used only by the
 * superadmin link flow, before a stable ID is known). */
export async function mintNamedRepositoryToken(installationId: number, repositoryName: string): Promise<InstallationToken> {
  const jwt = await createGithubAppJwt();
  const data = await githubJson<AccessTokenResponse>(`/app/installations/${positiveId(installationId, "installationId")}/access_tokens`, {
    method: "POST",
    bearer: jwt,
    body: { repositories: [repositoryName], permissions: { metadata: "read" } },
    context: "签发仓库令牌",
  });
  return {
    token: data.token,
    expiresAt: String(data.expires_at),
    repositories: (data.repositories ?? []).map((repository) => ({
      id: Number(repository.id), fullName: String(repository.full_name), defaultBranch: repository.default_branch ?? null,
    })),
  };
}

// Contract (spec §4): single repository, contents:read, ~1 hour. Callers: lab
// claim endpoints (W3, W4). Throws GithubNotConfiguredError when the App
// credentials are absent so callers can hand out `repository: null`.
export async function mintRepositoryReadToken(input: {
  installationId: number;
  repositoryId: number;
  fullName: string;
}): Promise<RepositoryReadAccess> {
  const minted = await mintSingleRepositoryToken({
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    permissions: { contents: "read" },
  });
  return {
    // GitHub's current name wins over a stale stored name (renames keep the ID).
    fullName: minted.repositories[0].fullName || input.fullName,
    repositoryId: input.repositoryId,
    token: minted.token,
    expiresAt: minted.expiresAt,
  };
}
