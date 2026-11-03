import type { RepositoryReadAccess } from "../research-loop/contracts.ts";

// CONTRACT STUB (workstream W2 replaces the body, keeps the signature).
// Mints a GitHub App installation token narrowed to one repository with
// contents:read only (1 hour). Callers: lab claim endpoints (W3, W4).
// Throws GithubNotConfiguredError when GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY
// are absent so callers can fail the claim cleanly.
export class GithubNotConfiguredError extends Error {}

export async function mintRepositoryReadToken(input: {
  installationId: number;
  repositoryId: number;
  fullName: string;
}): Promise<RepositoryReadAccess> {
  void input;
  throw new GithubNotConfiguredError("GitHub App 尚未配置");
}
