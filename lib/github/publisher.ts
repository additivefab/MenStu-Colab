// Trusted publisher (spec §6.2, pack §4): turns a reviewed agent change into a
// branch and a Draft PR using a token narrowed to one repository with
// contents:write + pull_requests:write. The agent never holds a write token.
//
// Safety properties:
//   - paths are re-validated against the attempt's task version before any
//     GitHub write; protected paths require a recorded extra review;
//   - only `refs/heads/tanyan/...` is created, never the default branch, and
//     an existing ref is never moved (no force push);
//   - resumable: blobs/trees are content-addressed and the commit carries fixed
//     author/committer dates, so a retry recomputes the same commit SHA and
//     reuses an existing ref or PR instead of creating a second one.
import {
  DEFAULT_PROTECTED_PATHS, LIMITS, PathPolicyError, evaluatePathPolicy, isCommitSha, sha256Hex,
  type ChangedFile,
} from "../research-loop/contracts.ts";
import { GithubApiError, encodePathSegments, githubJson, githubRequest } from "./http.ts";
import { isValidBranchName } from "./repository-read.ts";
import { mintSingleRepositoryToken } from "./tokens.ts";

export const PLATFORM_ORIGIN_MARKER = "<!-- tanyan:origin=platform -->";
export const COMMIT_AUTHOR = { name: "Tanyan Research Platform", email: "research-platform@tanyan.invalid" } as const;

export function changeObjectKey(attemptId: string) {
  return `agent-attempts/${attemptId}/change.json`;
}

/** The change can never be published as is (paths outside the task scope). */
export class PublishPolicyError extends Error {}
/** Publishing must wait (extra review, missing link, wrong state). */
export class PublishBlockedError extends Error {}
/** GitHub already holds a different branch head; nothing was overwritten. */
export class PublishConflictError extends Error {}

type PublishRow = {
  id: string;
  task_id: string;
  attempt_id: string;
  student_id: string;
  github_repository_id: number;
  base_commit_sha: string;
  branch_name: string;
  head_commit_sha: string | null;
  status: string;
  requires_extra_review: number;
  extra_review_approved_at: string | null;
  created_at: string;
  provider: string;
  model_id: string;
  task_version: number;
  attempt_status: string;
  attempt_repository_id: number;
  attempt_base_sha: string;
  title: string;
  allowed_paths_json: string;
  protected_paths_json: string;
  installation_id: number | null;
  full_name: string | null;
  default_branch: string | null;
  link_status: string | null;
  link_repository_id: number | null;
};

type ParsedFile = { path: string; action: ChangedFile["action"]; mode: "100644" | "100755"; contentBase64: string | null };

export type PublishOutcome = {
  status: "open" | "merged" | "closed";
  headCommitSha: string;
  prNumber: number;
  prUrl: string;
  reusedRef: boolean;
  reusedPullRequest: boolean;
};

function jsonList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function decodeBase64(value: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new PublishPolicyError("文件内容编码无效");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function parseChange(raw: string): Promise<ParsedFile[]> {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new PublishPolicyError("变更内容格式无效"); }
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.maxChangedFiles) {
    throw new PublishPolicyError(`变更文件数量需在 1–${LIMITS.maxChangedFiles} 之间`);
  }
  let total = 0;
  const seen = new Set<string>();
  const parsed: ParsedFile[] = [];
  for (const item of files as Partial<ChangedFile>[]) {
    if (!item || typeof item !== "object") throw new PublishPolicyError("变更文件格式无效");
    const action = item.action;
    if (action !== "add" && action !== "modify" && action !== "delete") throw new PublishPolicyError("变更动作无效");
    if (typeof item.path !== "string" || seen.has(item.path)) throw new PublishPolicyError("变更路径无效或重复");
    seen.add(item.path);
    const mode = item.mode ?? "100644";
    if (mode !== "100644" && mode !== "100755") throw new PublishPolicyError("文件模式无效");
    if (action === "delete") {
      parsed.push({ path: item.path, action, mode, contentBase64: null });
      continue;
    }
    if (typeof item.contentBase64 !== "string") throw new PublishPolicyError("缺少文件内容");
    const bytes = decodeBase64(item.contentBase64);
    if (bytes.length > LIMITS.maxChangedFileBytes) throw new PublishPolicyError(`文件过大：${item.path}`);
    total += bytes.length;
    if (total > LIMITS.maxChangeTotalBytes) throw new PublishPolicyError("变更总量超过上限");
    if (item.sha256 !== undefined && item.sha256 !== await sha256Hex(bytes)) {
      throw new PublishPolicyError(`文件摘要不一致：${item.path}`);
    }
    parsed.push({ path: item.path, action, mode, contentBase64: item.contentBase64 });
  }
  return parsed;
}

function singleLine(value: string, max: number) {
  const line = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return [...line].length > max ? `${[...line].slice(0, max - 1).join("")}…` : line;
}

function trailerToken(value: string) {
  return value.replace(/[^A-Za-z0-9._\-/]/g, "").slice(0, 100) || "unknown";
}

function sqliteUtcToIso(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : "2026-01-01T00:00:00Z";
}

export function buildCommitMessage(row: Pick<PublishRow, "title" | "task_id" | "attempt_id" | "provider" | "model_id">) {
  return [
    singleLine(row.title, 72) || "探研平台变更",
    "",
    "由探研平台可信发布服务根据已确认的研究任务创建。",
    "",
    `Tanyan-Task: ${row.task_id}`,
    `Tanyan-Attempt: ${row.attempt_id}`,
    `Assisted-by: ${trailerToken(row.provider)}:${trailerToken(row.model_id)}`,
  ].join("\n");
}

function buildPullRequestBody(row: PublishRow, files: ParsedFile[], protectedTouched: string[]) {
  const listed = files.slice(0, 50).map((file) => `- \`${file.path}\`（${file.action}）`);
  if (files.length > listed.length) listed.push(`- 另有 ${files.length - listed.length} 个文件`);
  return [
    PLATFORM_ORIGIN_MARKER,
    "## 探研平台变更请求",
    "",
    `- 任务：\`${row.task_id}\`（版本 ${row.task_version}）`,
    `- 代理尝试：\`${row.attempt_id}\`（${trailerToken(row.provider)}:${trailerToken(row.model_id)}）`,
    `- 基准提交：\`${row.base_commit_sha}\``,
    `- 受保护路径：${protectedTouched.length ? `${protectedTouched.length} 个，已通过额外审查` : "未涉及"}`,
    "",
    "### 修改文件",
    ...listed,
    "",
    "本 PR 为草稿，由可信发布服务创建；请在 GitHub 上完成审阅后再合并。",
  ].join("\n");
}

async function loadRow(d1: D1Database, changeRequestId: string) {
  return d1.prepare(`SELECT cr.id, cr.task_id, cr.attempt_id, cr.student_id, cr.github_repository_id, cr.base_commit_sha,
      cr.branch_name, cr.head_commit_sha, cr.status, cr.requires_extra_review, cr.extra_review_approved_at, cr.created_at,
      a.provider, a.model_id, a.task_version, a.status AS attempt_status,
      a.github_repository_id AS attempt_repository_id, a.base_commit_sha AS attempt_base_sha,
      t.title, v.allowed_paths_json, v.protected_paths_json,
      rl.installation_id, rl.full_name, rl.default_branch, rl.status AS link_status, rl.github_repository_id AS link_repository_id
    FROM change_requests cr
    JOIN agent_attempts a ON a.id = cr.attempt_id
    JOIN research_tasks t ON t.id = cr.task_id
    JOIN research_task_versions v ON v.task_id = a.task_id AND v.version = a.task_version
    LEFT JOIN repository_links rl ON rl.student_id = cr.student_id
    WHERE cr.id = ?`).bind(changeRequestId).first<PublishRow>();
}

async function setStatus(d1: D1Database, id: string, status: string, extra = "") {
  await d1.prepare(`UPDATE change_requests SET status = ?, ${extra} version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'publishing'`).bind(status, id).run();
}

type PullRequest = { number: number; html_url: string; state: string; merged_at: string | null; head: { ref: string; sha: string } };

/**
 * Publishes a change request that the caller has already moved to
 * `publishing` (CAS in the route). On return the row is `open`/`merged`/
 * `closed`; on failure it is `failed`, `rejected` (policy) or back to
 * `pending_review` (newly detected protected paths), and the error is thrown.
 */
export async function publishChangeRequest(d1: D1Database, files: R2Bucket, changeRequestId: string): Promise<PublishOutcome> {
  const row = await loadRow(d1, changeRequestId);
  if (!row) throw new PublishBlockedError("变更请求不存在");
  if (row.status !== "publishing") throw new PublishBlockedError("变更请求不在发布中");
  try {
    return await publish(d1, files, row);
  } catch (error) {
    if (error instanceof PublishPolicyError || error instanceof PathPolicyError) await setStatus(d1, row.id, "rejected");
    else if (!(error instanceof NeedsExtraReview)) await setStatus(d1, row.id, "failed");
    if (error instanceof NeedsExtraReview) throw new PublishBlockedError(error.message);
    if (error instanceof PathPolicyError) throw new PublishPolicyError(error.message);
    throw error;
  }
}

class NeedsExtraReview extends Error {}

async function publish(d1: D1Database, bucket: R2Bucket, row: PublishRow): Promise<PublishOutcome> {
  // 1. Preconditions: the server-resolved repository link is the only source of
  // repository identity; client input never reaches this point.
  if (row.link_status !== "active" || row.installation_id === null || !row.full_name || !row.default_branch) {
    throw new PublishBlockedError("学生仓库尚未通过 GitHub App 验证或已撤销");
  }
  if (Number(row.link_repository_id) !== Number(row.github_repository_id) || Number(row.attempt_repository_id) !== Number(row.github_repository_id)) {
    throw new PublishBlockedError("变更请求与当前绑定的仓库不一致");
  }
  if (row.attempt_status !== "change_ready") throw new PublishBlockedError("代理尝试尚未产出可发布的变更");
  if (!isCommitSha(row.base_commit_sha) || row.base_commit_sha !== row.attempt_base_sha) throw new PublishBlockedError("基准提交无效");
  if (!isValidBranchName(row.branch_name) || !row.branch_name.startsWith("tanyan/") || row.branch_name === row.default_branch) {
    throw new PublishBlockedError("分支名无效");
  }

  // 2. Change content and path policy against the attempt's task version.
  const object = await bucket.get(changeObjectKey(row.attempt_id));
  if (!object) throw new PublishBlockedError("变更内容不存在");
  if (object.size > LIMITS.maxChangeTotalBytes * 2 + LIMITS.maxDiffBytes) throw new PublishPolicyError("变更内容过大");
  const changed = await parseChange(await object.text());
  const protectedPatterns = [...new Set([...jsonList(row.protected_paths_json), ...DEFAULT_PROTECTED_PATHS])];
  const policy = evaluatePathPolicy(changed.map((file) => file.path), jsonList(row.allowed_paths_json), protectedPatterns);
  if (policy.outsideAllowed.length) throw new PublishPolicyError(`修改超出任务允许范围：${policy.outsideAllowed.slice(0, 5).join("、")}`);
  if (policy.protectedTouched.length && !row.requires_extra_review) {
    await d1.prepare(`UPDATE change_requests SET requires_extra_review = 1, status = 'pending_review',
      version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'publishing'`).bind(row.id).run();
    throw new NeedsExtraReview("修改涉及受保护路径，需先由导师完成额外审查");
  }
  if (row.requires_extra_review && !row.extra_review_approved_at) {
    await d1.prepare(`UPDATE change_requests SET status = 'pending_review', version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'publishing'`).bind(row.id).run();
    throw new NeedsExtraReview("修改涉及受保护路径，需先由导师完成额外审查");
  }

  // 3. Single-repository write token (stable ID, minimal permissions).
  const access = await mintSingleRepositoryToken({
    installationId: Number(row.installation_id),
    repositoryId: Number(row.github_repository_id),
    permissions: { contents: "write", pull_requests: "write" },
  });
  const fullName = access.repositories[0].fullName || row.full_name;
  const [owner] = fullName.split("/");
  const repo = `/repos/${encodePathSegments(fullName)}`;
  const bearer = access.token;

  // 4. Base tree → blobs → tree → commit.
  const base = await githubJson<{ sha: string; tree: { sha: string } }>(`${repo}/git/commits/${row.base_commit_sha}`, { bearer, context: "读取基准提交" });
  if (base.sha !== row.base_commit_sha || !isCommitSha(base.tree?.sha)) throw new GithubApiError(502, "base commit mismatch", "读取基准提交");
  const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
  for (const file of [...changed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (file.action === "delete") {
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await githubJson<{ sha: string }>(`${repo}/git/blobs`, {
      method: "POST", bearer, body: { content: file.contentBase64, encoding: "base64" }, context: "上传文件",
    });
    if (!isCommitSha(blob.sha)) throw new GithubApiError(502, "invalid blob sha", "上传文件");
    entries.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
  }
  const tree = await githubJson<{ sha: string }>(`${repo}/git/trees`, {
    method: "POST", bearer, body: { base_tree: base.tree.sha, tree: entries }, context: "创建目录树",
  });
  const signature = { ...COMMIT_AUTHOR, date: sqliteUtcToIso(row.created_at) };
  const commit = await githubJson<{ sha: string }>(`${repo}/git/commits`, {
    method: "POST", bearer,
    body: { message: buildCommitMessage(row), tree: tree.sha, parents: [row.base_commit_sha], author: signature, committer: signature },
    context: "创建提交",
  });
  if (!isCommitSha(commit.sha)) throw new GithubApiError(502, "invalid commit sha", "创建提交");
  const acceptedHeads = new Set([commit.sha, ...(row.head_commit_sha ? [row.head_commit_sha] : [])]);
  await d1.prepare(`UPDATE change_requests SET head_commit_sha = COALESCE(head_commit_sha, ?), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'publishing'`).bind(commit.sha, row.id).run();

  // 5. Branch ref: create once, never move an existing ref.
  const refPath = `${repo}/git/ref/heads/${encodePathSegments(row.branch_name)}`;
  const readRef = async () => (await githubRequest<{ object?: { sha?: string } }>(refPath, { bearer, context: "读取分支", allowStatuses: [404] })).data;
  let existing = await readRef();
  let reusedRef = Boolean(existing);
  if (!existing) {
    const created = await githubRequest<{ object?: { sha?: string } }>(`${repo}/git/refs`, {
      method: "POST", bearer, body: { ref: `refs/heads/${row.branch_name}`, sha: commit.sha },
      context: "创建分支", allowStatuses: [409, 422],
    });
    existing = created.data ?? await readRef();
    reusedRef = !created.data;
  }
  const headSha = existing?.object?.sha ?? "";
  if (!acceptedHeads.has(headSha)) throw new PublishConflictError("GitHub 上已有同名分支且指向其他提交，平台不会覆盖");

  // 6. Draft PR: reuse the PR already opened for this branch, if any.
  const findPullRequest = async () => {
    const list = await githubJson<PullRequest[]>(
      `${repo}/pulls?state=all&per_page=20&head=${encodeURIComponent(`${owner}:${row.branch_name}`)}`,
      { bearer, context: "查询 PR" },
    );
    return list.find((pull) => pull.head?.ref === row.branch_name) ?? null;
  };
  let pull = await findPullRequest();
  const reusedPullRequest = Boolean(pull);
  if (!pull) {
    const created = await githubRequest<PullRequest>(`${repo}/pulls`, {
      method: "POST", bearer,
      body: {
        title: singleLine(`[探研] ${row.title}`, 120), head: row.branch_name, base: row.default_branch,
        body: buildPullRequestBody(row, changed, policy.protectedTouched), draft: true, maintainer_can_modify: false,
      },
      context: "创建 PR", allowStatuses: [422],
    });
    pull = created.data ?? await findPullRequest();
  }
  if (!pull || !Number.isSafeInteger(pull.number)) throw new GithubApiError(502, "pull request missing", "创建 PR");

  const status: PublishOutcome["status"] = pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open";
  const prUrl = typeof pull.html_url === "string" && pull.html_url.startsWith("https://github.com/") ? pull.html_url : "";
  await d1.prepare(`UPDATE change_requests SET status = ?, head_commit_sha = ?, pr_number = ?, pr_url = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'publishing'`)
    .bind(status, headSha, pull.number, prUrl, row.id).run();
  return { status, headCommitSha: headSha, prNumber: pull.number, prUrl, reusedRef, reusedPullRequest };
}
