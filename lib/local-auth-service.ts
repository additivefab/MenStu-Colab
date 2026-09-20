import { digest, hashPassword, normalizeUsername, passwordError, secretToken, verifyPassword } from "./local-password.ts";
import { studentLoginName } from "./student-login-names.ts";

export class LocalAuthError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const studentGuard = `EXISTS (SELECT 1 FROM app_users u JOIN students s ON s.id = u.student_id
  WHERE u.id = local_credentials.app_user_id AND u.student_id = local_credentials.student_id
    AND u.role = 'student' AND u.active = 1 AND s.active = 1)`;
const adminGuard = `EXISTS (SELECT 1 FROM app_users actor WHERE actor.id = ? AND actor.active = 1 AND actor.role = 'superadmin')`;

// All limits are durable and atomic across Workers; only hashed keys are stored.
export async function takeAuthAttempt(d1: D1Database, namespace: string, value: string, limit: number, now = Date.now()) {
  const key = digest(`${namespace}:${value}`);
  const cutoff = now - 15 * 60 * 1000;
  const [result] = await d1.batch([
    d1.prepare(`INSERT INTO local_auth_attempts (key, attempts, window_start) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
        window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
      RETURNING attempts`).bind(key, now, cutoff, cutoff),
    d1.prepare("DELETE FROM local_auth_attempts WHERE window_start <= ?").bind(now - 86400000),
  ]);
  if (Number((result.results[0] as { attempts: number }).attempts) > limit) {
    throw new LocalAuthError("尝试次数过多，请在 15 分钟后重试", 429);
  }
}

export async function issueLocalActivation(d1: D1Database, actorId: number, userId: number, studentId: string) {
  const username = studentLoginName(studentId);
  const token = secretToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const requestId = crypto.randomUUID();
  const [update] = await d1.batch([
    d1.prepare(`INSERT INTO local_credentials
        (app_user_id, student_id, username, activation_hash, activation_expires_at)
      SELECT u.id, u.student_id, ?, ?, ? FROM app_users u JOIN students s ON s.id = u.student_id
      WHERE u.id = ? AND u.student_id = ? AND u.active = 1 AND s.active = 1 AND u.role = 'student' AND ${adminGuard}
      ON CONFLICT(app_user_id) DO UPDATE SET
        username = CASE WHEN local_credentials.username = local_credentials.student_id
          THEN excluded.username ELSE local_credentials.username END,
        activation_hash = excluded.activation_hash, activation_expires_at = excluded.activation_expires_at,
        password_hash = NULL, version = local_credentials.version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE local_credentials.student_id = excluded.student_id RETURNING username`)
      .bind(username, digest(token), expiresAt, userId, studentId, actorId),
    d1.prepare(`INSERT INTO local_auth_events (app_user_id, actor_user_id, action, request_id)
      SELECT ?, ?, 'issue', ? WHERE changes() > 0`).bind(userId, actorId, requestId),
    d1.prepare(`DELETE FROM app_sessions WHERE app_user_id = ?
      AND EXISTS (SELECT 1 FROM local_auth_events WHERE request_id = ?)`).bind(userId, requestId),
  ]);
  if (!update.meta.changes) throw new LocalAuthError("账号权限或学生绑定已变化，请刷新后核对原账号", 409);
  return { token, expiresAt, username: (update.results[0] as { username: string }).username };
}

export async function disableLocalLogin(d1: D1Database, actorId: number, userId: number, studentId: string) {
  const requestId = crypto.randomUUID();
  const [update] = await d1.batch([
    d1.prepare(`UPDATE local_credentials SET password_hash = NULL, activation_hash = NULL,
      activation_expires_at = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE app_user_id = ? AND student_id = ? AND ${adminGuard}`)
      .bind(userId, studentId, actorId),
    d1.prepare(`INSERT INTO local_auth_events (app_user_id, actor_user_id, action, request_id)
      SELECT ?, ?, 'disable', ? WHERE changes() > 0`).bind(userId, actorId, requestId),
    d1.prepare(`DELETE FROM app_sessions WHERE app_user_id = ?
      AND EXISTS (SELECT 1 FROM local_auth_events WHERE request_id = ?)`).bind(userId, requestId),
  ]);
  if (!update.meta.changes) throw new LocalAuthError("独立登录未开通或账号状态已变化", 409);
}

export async function activateLocalLogin(d1: D1Database, token: unknown, password: unknown) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new LocalAuthError("设置链接无效或已过期", 400);
  const error = passwordError(password);
  if (error) throw new LocalAuthError(error);
  const tokenHash = digest(token);
  const row = await d1.prepare(`SELECT app_user_id, version, username FROM local_credentials
    WHERE activation_hash = ? AND datetime(activation_expires_at) > CURRENT_TIMESTAMP AND ${studentGuard}`)
    .bind(tokenHash).first<{ app_user_id: number; version: number; username: string }>();
  if (!row) throw new LocalAuthError("设置链接无效或已过期，请联系管理员重新生成", 400);
  const encoded = await hashPassword(password as string);
  const requestId = crypto.randomUUID();
  const [update] = await d1.batch([
    d1.prepare(`UPDATE local_credentials SET password_hash = ?, activation_hash = NULL,
      activation_expires_at = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE app_user_id = ? AND version = ? AND activation_hash = ?
        AND datetime(activation_expires_at) > CURRENT_TIMESTAMP AND ${studentGuard}`)
      .bind(encoded, row.app_user_id, row.version, tokenHash),
    d1.prepare(`INSERT INTO local_auth_events (app_user_id, actor_user_id, action, request_id)
      SELECT ?, ?, 'activate', ? WHERE changes() > 0`).bind(row.app_user_id, row.app_user_id, requestId),
    d1.prepare(`DELETE FROM app_sessions WHERE app_user_id = ?
      AND EXISTS (SELECT 1 FROM local_auth_events WHERE request_id = ?)`).bind(row.app_user_id, requestId),
    d1.prepare(`DELETE FROM local_auth_attempts WHERE key = ?
      AND EXISTS (SELECT 1 FROM local_auth_events WHERE request_id = ?)`).bind(digest(`username:${row.username}`), requestId),
  ]);
  if (!update.meta.changes) throw new LocalAuthError("设置链接已失效，请联系管理员重新生成", 409);
  return { username: row.username };
}

export async function loginLocally(d1: D1Database, usernameInput: unknown, password: unknown) {
  const username = normalizeUsername(usernameInput);
  if (!/^[a-z0-9_-]{1,64}$/.test(username) || passwordError(password)) {
    throw new LocalAuthError("账号或密码错误", 401);
  }
  await takeAuthAttempt(d1, "username", username, 10);
  const row = await d1.prepare(`SELECT app_user_id, student_id, password_hash, version
    FROM local_credentials WHERE username = ? AND ${studentGuard}`)
    .bind(username).first<{ app_user_id: number; student_id: string; password_hash: string | null; version: number }>();
  const valid = await verifyPassword(password as string, row?.password_hash ?? null);
  if (!row || !valid) throw new LocalAuthError("账号或密码错误", 401);
  const token = secretToken();
  const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
  const [insert] = await d1.batch([
    // Re-check after scrypt: a concurrent reset, disable or rebind invalidates this login.
    d1.prepare(`INSERT INTO app_sessions
        (token_hash, app_user_id, expires_at, auth_method, local_credential_version, local_student_id)
      SELECT ?, app_user_id, ?, 'local', version, student_id FROM local_credentials
      WHERE app_user_id = ? AND version = ? AND password_hash = ? AND ${studentGuard}`)
      .bind(digest(token), expiresAt, row.app_user_id, row.version, row.password_hash),
    d1.prepare(`UPDATE app_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ? AND changes() > 0`).bind(row.app_user_id),
    d1.prepare(`DELETE FROM local_auth_attempts WHERE key = ?
      AND EXISTS (SELECT 1 FROM app_sessions WHERE token_hash = ?)`).bind(digest(`username:${username}`), digest(token)),
    d1.prepare("DELETE FROM app_sessions WHERE datetime(expires_at) <= CURRENT_TIMESTAMP"),
  ]);
  if (!insert.meta.changes) throw new LocalAuthError("账号状态已变化，请重新登录", 401);
  return { token, expiresAt };
}

export async function localAccountForStudent(d1: D1Database, userId: number) {
  return d1.prepare(`SELECT username, password_hash IS NOT NULL AS enabled FROM local_credentials
    WHERE app_user_id = ? AND ${studentGuard}`).bind(userId).first<{ username: string; enabled: number }>();
}

export async function changeLocalPassword(d1: D1Database, userId: number, sessionHash: string, currentPassword: unknown, newPassword: unknown) {
  await takeAuthAttempt(d1, "password-change", String(userId), 10);
  if (passwordError(currentPassword)) throw new LocalAuthError("原密码不正确", 400);
  const error = passwordError(newPassword);
  if (error) throw new LocalAuthError(error);
  const row = await d1.prepare(`SELECT password_hash, version FROM local_credentials
    WHERE app_user_id = ? AND ${studentGuard}`).bind(userId)
    .first<{ password_hash: string | null; version: number }>();
  const valid = await verifyPassword(currentPassword as string, row?.password_hash ?? null);
  if (!row || !valid) throw new LocalAuthError("原密码不正确或独立登录尚未开通", 400);
  if (currentPassword === newPassword) throw new LocalAuthError("新密码不能与原密码相同");
  const encoded = await hashPassword(newPassword as string);
  const requestId = crypto.randomUUID();
  const [update] = await d1.batch([
    d1.prepare(`UPDATE local_credentials SET password_hash = ?, version = version + 1,
      activation_hash = NULL, activation_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE app_user_id = ? AND version = ? AND password_hash = ? AND ${studentGuard}
        AND EXISTS (SELECT 1 FROM app_sessions s WHERE s.token_hash = ?
          AND s.app_user_id = local_credentials.app_user_id AND datetime(s.expires_at) > CURRENT_TIMESTAMP
          AND (s.auth_method = 'feishu' OR (s.auth_method = 'local'
            AND s.local_credential_version = local_credentials.version
            AND s.local_student_id = local_credentials.student_id)))`)
      .bind(encoded, userId, row.version, row.password_hash, sessionHash),
    d1.prepare(`INSERT INTO local_auth_events (app_user_id, actor_user_id, action, request_id)
      SELECT ?, ?, 'change_password', ? WHERE changes() > 0`).bind(userId, userId, requestId),
    d1.prepare(`DELETE FROM app_sessions WHERE app_user_id = ?
      AND EXISTS (SELECT 1 FROM local_auth_events WHERE request_id = ?)`).bind(userId, requestId),
  ]);
  if (!update.meta.changes) throw new LocalAuthError("账号或登录状态已变化，请重新登录", 409);
}

export const localSessionGuardSql = `(s.auth_method = 'feishu' OR (
  s.auth_method = 'local' AND u.role = 'student' AND c.password_hash IS NOT NULL
  AND c.version = s.local_credential_version AND c.student_id = u.student_id
  AND s.local_student_id = u.student_id
  AND EXISTS (SELECT 1 FROM students student WHERE student.id = u.student_id AND student.active = 1)
))`;
