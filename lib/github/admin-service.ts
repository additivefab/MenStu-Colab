// Superadmin GitHub management (spec §6.2): installation sync and the
// server-side resolution of a student's bound repository to a stable GitHub
// repository ID. Clients only ever send a studentId; the repository identity
// comes from the student's existing binding and GitHub's answer (T03).
import { GithubApiError, encodePathSegments, githubJson, githubRequest } from "./http.ts";
import { GithubCommitNotFoundError, resolveCommitSha } from "./repository-read.ts";
import {
  createGithubAppJwt, isGithubAppConfigured, githubWebhookSecret, mintNamedRepositoryToken,
} from "./tokens.ts";

export class GithubAdminInputError extends Error {}
export class GithubAdminConflictError extends Error {}

type InstallationPayload = {
  id: number;
  app_id?: number;
  account?: { login?: string; type?: string } | null;
  repository_selection?: string;
  suspended_at?: string | null;
};

function installationStatement(d1: D1Database, installation: InstallationPayload) {
  return d1.prepare(`INSERT INTO github_installations
      (installation_id, account_login, account_type, repository_selection, status)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type,
        repository_selection = excluded.repository_selection, status = excluded.status, updated_at = CURRENT_TIMESTAMP`)
    .bind(
      installation.id,
      String(installation.account?.login ?? "").slice(0, 100),
      String(installation.account?.type ?? "").slice(0, 40),
      installation.repository_selection === "all" ? "all" : "selected",
      installation.suspended_at ? "suspended" : "active",
    );
}

export async function readGithubAdminState(d1: D1Database) {
  const installations = await d1.prepare(`SELECT installation_id, account_login, account_type, repository_selection, status, updated_at
    FROM github_installations ORDER BY installation_id`).all<Record<string, unknown>>();
  const students = await d1.prepare(`SELECT s.id AS student_id, s.display_name, b.repository_full_name,
      l.github_repository_id, l.installation_id, l.full_name AS linked_full_name, l.default_branch, l.status AS link_status,
      l.verified_at
    FROM students s
    LEFT JOIN student_repository_bindings b ON b.student_id = s.id AND b.active = 1
    LEFT JOIN repository_links l ON l.student_id = s.id
    WHERE s.active = 1 AND (b.student_id IS NOT NULL OR l.student_id IS NOT NULL)
    ORDER BY s.id`).all<Record<string, unknown>>();
  return {
    configured: { app: isGithubAppConfigured(), webhook: Boolean(githubWebhookSecret()) },
    installations: installations.results.map((row) => ({
      installationId: Number(row.installation_id), accountLogin: row.account_login, accountType: row.account_type,
      repositorySelection: row.repository_selection, status: row.status, updatedAt: row.updated_at,
    })),
    students: students.results.map((row) => ({
      studentId: row.student_id,
      displayName: row.display_name,
      boundFullName: row.repository_full_name ?? null,
      link: row.github_repository_id === null || row.github_repository_id === undefined ? null : {
        repositoryId: Number(row.github_repository_id), installationId: Number(row.installation_id),
        fullName: row.linked_full_name, defaultBranch: row.default_branch, status: row.link_status, verifiedAt: row.verified_at,
      },
    })),
  };
}

export async function syncInstallations(d1: D1Database) {
  const jwt = await createGithubAppJwt();
  const installations: InstallationPayload[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubJson<InstallationPayload[]>(`/app/installations?per_page=100&page=${page}`, { bearer: jwt, context: "同步安装" });
    installations.push(...batch.filter((item) => Number.isSafeInteger(item?.id) && item.id > 0));
    if (batch.length < 100) break;
    if (page === 10) throw new GithubApiError(502, "too many installations", "同步安装");
  }
  const ids = installations.map((item) => item.id);
  const statements = installations.map((item) => installationStatement(d1, item));
  // Installations GitHub no longer reports are gone: mark deleted, revoke links.
  const notIn = ids.length ? `AND installation_id NOT IN (${ids.map(() => "?").join(",")})` : "";
  statements.push(d1.prepare(`UPDATE repository_links SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active' ${notIn}`).bind(...ids));
  statements.push(d1.prepare(`UPDATE github_installations SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
    WHERE status <> 'deleted' ${notIn}`).bind(...ids));
  await d1.batch(statements);
  return { synced: installations.length };
}

type RepositoryPayload = { id: number; full_name: string; default_branch: string; archived?: boolean };

export async function linkRepository(d1: D1Database, studentId: string, actorUserId: number) {
  const binding = await d1.prepare(`SELECT b.repository_full_name FROM student_repository_bindings b
      JOIN students s ON s.id = b.student_id AND s.active = 1
      WHERE b.student_id = ? AND b.active = 1`)
    .bind(studentId).first<{ repository_full_name: string }>();
  if (!binding) throw new GithubAdminInputError("该学生尚未绑定科研仓库");
  const fullName = binding.repository_full_name;
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(fullName)) throw new GithubAdminInputError("绑定的仓库名称无效");
  const [owner, name] = fullName.split("/");

  const jwt = await createGithubAppJwt();
  const found = await githubRequest<InstallationPayload>(`/repos/${encodePathSegments(fullName)}/installation`, {
    bearer: jwt, context: "查询仓库安装", allowStatuses: [404],
  });
  const installation = found.data;
  if (!installation || !Number.isSafeInteger(installation.id)) throw new GithubAdminConflictError("GitHub App 尚未安装到该仓库");
  if (String(installation.account?.login ?? "").toLowerCase() !== owner.toLowerCase()) {
    throw new GithubAdminConflictError("仓库所属账号与安装不一致");
  }
  await installationStatement(d1, installation).run();
  if (installation.suspended_at) throw new GithubAdminConflictError("该 GitHub App 安装已被暂停");

  const token = await mintNamedRepositoryToken(installation.id, name);
  const repository = await githubJson<RepositoryPayload>(`/repos/${encodePathSegments(fullName)}`, { bearer: token.token, context: "读取仓库" });
  if (!Number.isSafeInteger(repository.id) || repository.id <= 0 || typeof repository.default_branch !== "string" || !repository.default_branch) {
    throw new GithubApiError(502, "invalid repository", "读取仓库");
  }
  if (token.repositories.length !== 1 || token.repositories[0].id !== repository.id) {
    throw new GithubApiError(502, "repository scope mismatch", "读取仓库");
  }
  if (String(repository.full_name).toLowerCase() !== fullName.toLowerCase()) {
    throw new GithubAdminConflictError(`GitHub 上的仓库名称为 ${repository.full_name}，请先更新学生绑定`);
  }
  const shared = await d1.prepare(`SELECT student_id FROM repository_links
      WHERE github_repository_id = ? AND status = 'active' AND student_id <> ?`)
    .bind(repository.id, studentId).first();
  if (shared) throw new GithubAdminConflictError("该仓库已关联到其他学生");

  await d1.prepare(`INSERT INTO repository_links
      (student_id, github_repository_id, installation_id, full_name, default_branch, status, verified_by_user_id)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(student_id) DO UPDATE SET github_repository_id = excluded.github_repository_id,
        installation_id = excluded.installation_id, full_name = excluded.full_name,
        default_branch = excluded.default_branch, status = 'active', verified_by_user_id = excluded.verified_by_user_id,
        verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`)
    .bind(studentId, repository.id, installation.id, repository.full_name, repository.default_branch, actorUserId).run();
  return { studentId, repositoryId: repository.id, installationId: installation.id, fullName: repository.full_name, defaultBranch: repository.default_branch };
}

export async function revokeLink(d1: D1Database, studentId: string) {
  const result = await d1.prepare(`UPDATE repository_links SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
    WHERE student_id = ? AND status = 'active'`).bind(studentId).run();
  if (!result.meta.changes) throw new GithubAdminConflictError("该学生没有生效中的仓库关联");
  return { studentId, revoked: true };
}

/** Read-path check for an active link: mints a contents:read token for that one
 * repository and resolves a ref (default branch unless given). The token itself
 * is never returned. */
export async function checkRepositoryAccess(d1: D1Database, studentId: string, ref: unknown) {
  const link = await d1.prepare(`SELECT github_repository_id, installation_id, full_name, default_branch
      FROM repository_links WHERE student_id = ? AND status = 'active'`)
    .bind(studentId).first<{ github_repository_id: number; installation_id: number; full_name: string; default_branch: string }>();
  if (!link) throw new GithubAdminConflictError("该学生没有生效中的仓库关联");
  if (ref !== undefined && (typeof ref !== "string" || !ref.trim() || ref.length > 200)) throw new GithubAdminInputError("分支或提交参数无效");
  const target = typeof ref === "string" ? ref.trim() : link.default_branch;
  try {
    const commitSha = await resolveCommitSha({
      installationId: Number(link.installation_id), repositoryId: Number(link.github_repository_id),
      fullName: link.full_name, ref: target,
    });
    return { studentId, repositoryId: Number(link.github_repository_id), fullName: link.full_name, ref: target, commitSha };
  } catch (error) {
    if (error instanceof GithubCommitNotFoundError) throw new GithubAdminInputError(error.message);
    throw error;
  }
}
