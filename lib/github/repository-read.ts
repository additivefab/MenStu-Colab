// CONTRACT STUB (workstream W2 replaces the body, keeps the signature).
// Resolves a branch name or full SHA to a commit SHA that exists in the
// repository, using the App installation. Callers: agent attempt start (W3),
// run creation (W4). Throws GithubNotConfiguredError when the App is absent,
// GithubCommitNotFoundError when the ref/sha does not exist in that repository.
import { GithubNotConfiguredError } from "./tokens.ts";

export class GithubCommitNotFoundError extends Error {}

export async function resolveCommitSha(input: {
  installationId: number;
  repositoryId: number;
  fullName: string;
  ref: string;
}): Promise<string> {
  void input;
  throw new GithubNotConfiguredError("GitHub App 尚未配置");
}
