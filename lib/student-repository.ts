export type RepositoryVisibility = "private" | "public" | "unknown";

export type StudentRepositoryBinding = {
  studentId: string;
  githubUsername: string;
  repositoryUrl: string;
  repositoryFullName: string;
  visibility: RepositoryVisibility;
  version: number;
  updatedAt: string;
};

export type StudentRepositoryState = {
  binding: StudentRepositoryBinding | null;
  currentVersion: number;
};

type RepositoryRow = {
  student_id: string;
  github_username: string;
  repository_url: string;
  repository_full_name: string;
  visibility: RepositoryVisibility;
  active: number;
  version: number;
  updated_at: string;
};

export class RepositoryInputError extends Error {}
export class RepositoryConflictError extends Error {}

const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function normalizeGithubUsername(value: unknown): string {
  if (typeof value !== "string") throw new RepositoryInputError("请填写 GitHub 账号");
  const login = value.trim();
  if (!githubLoginPattern.test(login)) {
    throw new RepositoryInputError("GitHub 账号需为 1–39 位英文字母、数字或单个连字符，不包含 @ 或网址");
  }
  return login;
}

export function normalizeGithubRepositoryUrl(value: unknown) {
  if (typeof value !== "string") throw new RepositoryInputError("请填写 GitHub 仓库地址");
  const raw = value.trim();
  // A full-string allowlist rejects encoded characters, credentials, explicit
  // ports, URL parser normalization, and links to a branch or a single commit.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,104})\/?$/i.exec(raw);
  if (!match || !githubLoginPattern.test(match[1])) {
    throw new RepositoryInputError("请填写 https://github.com/组织或账号/仓库名 格式的仓库首页地址");
  }
  const name = match[2].replace(/\.git$/i, "");
  if (!name || name.length > 100 || name === "." || name === "..") {
    throw new RepositoryInputError("GitHub 仓库名称无效");
  }
  const repositoryFullName = `${match[1]}/${name}`;
  return { repositoryUrl: `https://github.com/${repositoryFullName}`, repositoryFullName };
}

export function parseStudentRepositoryIdentity(body: Record<string, unknown>) {
  if (typeof body.studentId !== "string" || !body.studentId.trim() || body.studentId.trim().length > 80) {
    throw new RepositoryInputError("学生参数无效");
  }
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new RepositoryInputError("仓库版本参数无效，请重新载入设置");
  }
  return { studentId: body.studentId.trim(), expectedVersion: body.expectedVersion };
}

export function parseStudentRepositoryInput(body: Record<string, unknown>) {
  const identity = parseStudentRepositoryIdentity(body);
  const githubUsername = normalizeGithubUsername(body.githubUsername);
  const repository = normalizeGithubRepositoryUrl(body.repositoryUrl);
  if (body.visibility !== "private" && body.visibility !== "public" && body.visibility !== "unknown") {
    throw new RepositoryInputError("请选择仓库可见性；不确定时请选择未知");
  }
  return { ...identity, githubUsername, ...repository, visibility: body.visibility as RepositoryVisibility };
}

function repositoryState(row: RepositoryRow | null | undefined): StudentRepositoryState {
  if (!row) return { binding: null, currentVersion: 0 };
  return {
    currentVersion: Number(row.version),
    binding: row.active ? {
      studentId: row.student_id,
      githubUsername: row.github_username,
      repositoryUrl: row.repository_url,
      repositoryFullName: row.repository_full_name,
      visibility: row.visibility,
      version: Number(row.version),
      updatedAt: row.updated_at,
    } : null,
  };
}

export async function readStudentRepository(d1: D1Database, studentId: string): Promise<StudentRepositoryState> {
  const row = await d1.prepare(`SELECT student_id, github_username, repository_url, repository_full_name,
    visibility, active, version, updated_at FROM student_repository_bindings WHERE student_id = ?`)
    .bind(studentId).first<RepositoryRow>();
  return repositoryState(row);
}

function auditStatement(d1: D1Database, mutationId: string, action: "created" | "updated" | "unlinked", actorUserId: number) {
  return d1.prepare(`INSERT INTO student_repository_events
    (student_id, version, action, actor_user_id, actor_type, snapshot_json)
    SELECT student_id, version, ?, ?, 'user', json_object(
      'githubUsername', github_username, 'repositoryUrl', repository_url,
      'repositoryFullName', repository_full_name, 'visibility', visibility, 'active', active)
    FROM student_repository_bindings WHERE last_mutation_id = ?`)
    .bind(action, actorUserId, mutationId);
}

type RepositoryChange = {
  studentId: string;
  actorUserId: number;
  expectedVersion: number;
  input: {
    githubUsername: string;
    repositoryUrl: string;
    repositoryFullName: string;
    visibility: RepositoryVisibility;
  };
};

export async function changeStudentRepository(d1: D1Database, change: RepositoryChange): Promise<StudentRepositoryState> {
  const { studentId, actorUserId, expectedVersion, input } = change;
  const mutationId = crypto.randomUUID();
  const mutation = expectedVersion === 0
    ? d1.prepare(`INSERT INTO student_repository_bindings
        (student_id, github_username, repository_url, repository_full_name, visibility,
         active, version, last_mutation_id, created_by_user_id, updated_by_user_id)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
        ON CONFLICT(student_id) DO NOTHING
        RETURNING student_id, github_username, repository_url, repository_full_name, visibility, active, version, updated_at`)
      .bind(studentId, input.githubUsername, input.repositoryUrl, input.repositoryFullName,
        input.visibility, mutationId, actorUserId, actorUserId)
    : d1.prepare(`UPDATE student_repository_bindings SET
        github_username = ?, repository_url = ?, repository_full_name = ?, visibility = ?,
        active = 1, version = version + 1, last_mutation_id = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE student_id = ? AND version = ?
        RETURNING student_id, github_username, repository_url, repository_full_name, visibility, active, version, updated_at`)
      .bind(input.githubUsername, input.repositoryUrl, input.repositoryFullName, input.visibility,
        mutationId, actorUserId, studentId, expectedVersion);
  // D1 batch is transactional. The unique mutation id ties the audit to exactly
  // this successful CAS, so a stale update never adds a misleading audit event.
  const result = await d1.batch<RepositoryRow>([
    mutation,
    auditStatement(d1, mutationId, expectedVersion === 0 ? "created" : "updated", actorUserId),
  ]);
  const row = result[0].results[0];
  if (!row) throw new RepositoryConflictError("仓库设置已被更新，请载入最新设置后再保存");
  return repositoryState(row);
}

export async function unlinkStudentRepository(
  d1: D1Database,
  { studentId, actorUserId, expectedVersion }: Omit<RepositoryChange, "input">,
): Promise<StudentRepositoryState> {
  const mutationId = crypto.randomUUID();
  const result = await d1.batch<RepositoryRow>([
    d1.prepare(`UPDATE student_repository_bindings SET
      active = 0, version = version + 1, last_mutation_id = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE student_id = ? AND version = ? AND active = 1
      RETURNING student_id, github_username, repository_url, repository_full_name, visibility, active, version, updated_at`)
      .bind(mutationId, actorUserId, studentId, expectedVersion),
    auditStatement(d1, mutationId, "unlinked", actorUserId),
  ]);
  const row = result[0].results[0];
  if (!row) throw new RepositoryConflictError("仓库设置已被更新，请载入最新设置后再解除绑定");
  return repositoryState(row);
}
