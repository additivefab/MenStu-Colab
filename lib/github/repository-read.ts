// Resolves a branch name or full SHA to a commit SHA that exists in the
// repository, using a token narrowed to that repository's stable ID (so a
// stale or spoofed full name cannot reach another repository). Callers: agent
// attempt start (W3), run creation (W4). Throws GithubNotConfiguredError when
// the App is absent, GithubCommitNotFoundError when the ref/sha does not exist.
import { isCommitSha } from "../research-loop/contracts.ts";
import { encodePathSegments, githubRequest } from "./http.ts";
import { mintRepositoryReadToken } from "./tokens.ts";

export class GithubCommitNotFoundError extends Error {}

const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** Conservative subset of git-check-ref-format for branch names. */
export function isValidBranchName(value: string) {
  return value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9._\-/]+$/.test(value)
    && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".")
    && !value.endsWith(".lock") && !value.includes("..") && !value.includes("//") && !value.includes("@{")
    && !value.split("/").some((part) => part.startsWith("."));
}

export async function resolveCommitSha(input: {
  installationId: number;
  repositoryId: number;
  fullName: string;
  ref: string;
}): Promise<string> {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  const sha = ref.toLowerCase();
  if (!isCommitSha(sha) && !isValidBranchName(ref)) throw new GithubCommitNotFoundError("分支名或提交 SHA 无效");
  const access = await mintRepositoryReadToken(input);
  if (!FULL_NAME.test(access.fullName)) throw new GithubCommitNotFoundError("仓库名称无效");
  const repo = encodePathSegments(access.fullName);
  if (isCommitSha(sha)) {
    const found = await githubRequest<{ sha?: string }>(`/repos/${repo}/git/commits/${sha}`, {
      bearer: access.token, context: "读取提交", allowStatuses: [404, 409, 422],
    });
    if (!found.data || found.data.sha !== sha) throw new GithubCommitNotFoundError("仓库中不存在该提交");
    return sha;
  }
  const found = await githubRequest<{ object?: { type?: string; sha?: string } }>(
    `/repos/${repo}/git/ref/heads/${encodePathSegments(ref)}`,
    { bearer: access.token, context: "读取分支", allowStatuses: [404, 409] },
  );
  const object = found.data?.object;
  if (!object || object.type !== "commit" || !isCommitSha(object.sha)) throw new GithubCommitNotFoundError("仓库中不存在该分支");
  return object.sha;
}
