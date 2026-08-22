import { env } from "cloudflare:workers";
import { ensureDatabase, getD1 } from "./database";

const SESSION_COOKIE = "tanyan_session";
const SESSION_DAYS = 14;

export type AppRole = "superadmin" | "admin" | "student" | "pending";

export function isAdminRole(role: AppRole) {
  return role === "superadmin" || role === "admin";
}

export function isReviewerRole(role: AppRole) {
  return role === "superadmin" || role === "admin";
}

export type AppUser = {
  id: number;
  feishuOpenId: string;
  displayName: string;
  avatarUrl: string;
  email: string;
  role: AppRole;
  studentId: string | null;
};

type FeishuUserInfo = {
  open_id?: string;
  union_id?: string;
  user_id?: string;
  name?: string;
  en_name?: string;
  avatar_url?: string;
  avatar_thumb?: string;
  email?: string;
  enterprise_email?: string;
};

type UserRow = {
  id: number;
  feishu_open_id: string;
  display_name: string;
  avatar_url: string;
  email: string;
  role: string;
  student_id: string | null;
};

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

export function getFeishuConfig() {
  const values = runtimeEnv();
  return {
    appId: values.FEISHU_APP_ID?.trim() ?? "",
    appSecret: values.FEISHU_APP_SECRET?.trim() ?? "",
    allowFirstAdmin: values.FEISHU_ALLOW_FIRST_ADMIN === "true",
    superAdminOpenId: values.FEISHU_SUPERADMIN_OPEN_ID?.trim() ?? "",
    adminOpenId: values.FEISHU_ADMIN_OPEN_ID?.trim() ?? "",
    verificationToken: values.FEISHU_VERIFICATION_TOKEN?.trim() ?? "",
    encryptKey: values.FEISHU_ENCRYPT_KEY?.trim() ?? "",
  };
}

export function isFeishuConfigured() {
  const config = getFeishuConfig();
  return Boolean(config.appId && config.appSecret);
}

async function requestJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { code?: number; msg?: string };
  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    throw new Error(payload.msg || `飞书接口请求失败（${response.status}）`);
  }
  return payload;
}

export async function exchangeFeishuCode(code: string) {
  const config = getFeishuConfig();
  if (!config.appId || !config.appSecret) throw new Error("飞书应用凭据尚未配置");

  const appToken = await requestJson<{ app_access_token?: string }>(
    "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    },
  );
  if (!appToken.app_access_token) throw new Error("未获取到飞书应用凭证");

  const userToken = await requestJson<{ data?: { access_token?: string } }>(
    "https://open.feishu.cn/open-apis/authen/v1/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appToken.app_access_token}`,
      },
      body: JSON.stringify({ grant_type: "authorization_code", code }),
    },
  );
  const accessToken = userToken.data?.access_token;
  if (!accessToken) throw new Error("未获取到飞书用户凭证");

  const userInfo = await requestJson<{ data?: FeishuUserInfo }>(
    "https://open.feishu.cn/open-apis/authen/v1/user_info",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!userInfo.data?.open_id) throw new Error("飞书未返回用户 Open ID");
  return userInfo.data;
}

export async function getFeishuTenantToken() {
  const config = getFeishuConfig();
  if (!config.appId || !config.appSecret) throw new Error("飞书应用凭据尚未配置");
  const result = await requestJson<{ tenant_access_token?: string }>(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    },
  );
  if (!result.tenant_access_token) throw new Error("未获取到飞书企业凭证");
  return result.tenant_access_token;
}

export async function sendFeishuCard(openId: string, card: Record<string, unknown>) {
  const token = await getFeishuTenantToken();
  return requestJson<{ data?: { message_id?: string } }>(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    },
  );
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashToken(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mapUser(row: UserRow): AppUser {
  const role: AppRole = row.role === "mentor"
    ? "admin"
    : ["superadmin", "admin", "student", "pending"].includes(row.role)
      ? row.role as AppRole
      : "pending";
  return {
    id: row.id,
    feishuOpenId: row.feishu_open_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    email: row.email,
    role,
    studentId: row.student_id,
  };
}

async function autoBindVerifiedStudent(row: UserRow) {
  if (row.role !== "pending" || row.student_id) return row;
  const d1 = getD1();
  const binding = await d1.prepare(`SELECT b.student_id, b.verified_by_user_id
    FROM student_feishu_identity_bindings b
    INNER JOIN students s ON s.id = b.student_id
    WHERE b.feishu_open_id = ? AND b.active = 1 AND s.active = 1`)
    .bind(row.feishu_open_id)
    .first<{ student_id: string; verified_by_user_id: number }>();
  if (!binding) return row;

  const requestId = crypto.randomUUID();
  await d1.batch([
    d1.prepare(`UPDATE OR IGNORE app_users
      SET role = 'student', student_id = ?, last_login_at = CURRENT_TIMESTAMP
      WHERE id = ? AND role = 'pending' AND student_id IS NULL
        AND EXISTS (SELECT 1 FROM students WHERE id = ? AND active = 1)
        AND EXISTS (
          SELECT 1 FROM student_feishu_identity_bindings
          WHERE student_id = ? AND feishu_open_id = ? AND active = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM app_users
          WHERE student_id = ? AND id <> ?
        )`)
      .bind(
        binding.student_id,
        row.id,
        binding.student_id,
        binding.student_id,
        row.feishu_open_id,
        binding.student_id,
        row.id,
      ),
    d1.prepare(`INSERT INTO app_user_role_events
      (target_user_id, actor_user_id, request_id, from_role, to_role, detail)
      SELECT ?, ?, ?, 'pending', 'student', ? WHERE changes() > 0`)
      .bind(
        row.id,
        binding.verified_by_user_id,
        requestId,
        `已核验飞书 Open ID 预绑定，首次登录自动绑定 ${binding.student_id}`,
      ),
  ]);

  return await d1.prepare(`SELECT id, feishu_open_id, display_name, avatar_url, email, role, student_id
    FROM app_users WHERE id = ?`).bind(row.id).first<UserRow>() ?? row;
}

export async function createFeishuSession(info: FeishuUserInfo) {
  await ensureDatabase();
  const d1 = getD1();
  const openId = info.open_id!;
  const config = getFeishuConfig();
  let row = await d1.prepare(`SELECT id, feishu_open_id, display_name, avatar_url, email, role, student_id
    FROM app_users WHERE feishu_open_id = ?`).bind(openId).first<UserRow>();

  if (!row) {
    const adminCount = await d1.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role IN ('superadmin', 'admin', 'mentor') AND active = 1").first<{ count: number }>();
    const isConfiguredAdmin = Boolean(config.adminOpenId && config.adminOpenId === openId);
    const isFirstAdmin = config.allowFirstAdmin && (adminCount?.count ?? 0) === 0;
    const initialRole: AppRole = isConfiguredAdmin || isFirstAdmin ? "admin" : "pending";
    row = await d1.prepare(`INSERT INTO app_users
      (feishu_open_id, feishu_union_id, feishu_user_id, display_name, avatar_url, email, role)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feishu_open_id) DO UPDATE SET
        feishu_union_id = excluded.feishu_union_id,
        feishu_user_id = excluded.feishu_user_id,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        email = excluded.email,
        last_login_at = CURRENT_TIMESTAMP
      RETURNING id, feishu_open_id, display_name, avatar_url, email, role, student_id`)
      .bind(
        openId,
        info.union_id ?? "",
        info.user_id ?? "",
        info.name ?? info.en_name ?? "飞书用户",
        info.avatar_url ?? info.avatar_thumb ?? "",
        info.enterprise_email ?? info.email ?? "",
        "pending",
      )
      .first<UserRow>();
    if (row && initialRole === "admin") {
      const requestId = crypto.randomUUID();
      const firstAdminGuard = isConfiguredAdmin
        ? ""
        : `AND NOT EXISTS (
            SELECT 1 FROM app_users
            WHERE role IN ('superadmin', 'admin', 'mentor') AND active = 1
          )`;
      await d1.batch([
        d1.prepare(`UPDATE app_users SET role = 'mentor'
          WHERE id = ? AND role = 'pending' AND student_id IS NULL
          ${firstAdminGuard}`).bind(row.id),
        d1.prepare(`INSERT INTO app_user_role_events
          (target_user_id, actor_user_id, request_id, from_role, to_role, detail)
          SELECT ?, ?, ?, 'pending', 'admin', ? WHERE changes() > 0`)
          .bind(
            row.id,
            row.id,
            requestId,
            isConfiguredAdmin ? "预绑定 Open ID 初始化管理员" : "受限可用范围内初始化首位管理员",
          ),
      ]);
      row = await d1.prepare(`SELECT id, feishu_open_id, display_name, avatar_url, email, role, student_id
        FROM app_users WHERE id = ?`).bind(row.id).first<UserRow>();
    }
  } else {
      const configuredRole = ["superadmin", "admin", "mentor", "student", "pending"].includes(row.role)
        ? row.role
        : "pending";
    row = await d1.prepare(`UPDATE app_users SET
      feishu_union_id = ?, feishu_user_id = ?, display_name = ?, avatar_url = ?, email = ?,
      role = ?, last_login_at = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING id, feishu_open_id, display_name, avatar_url, email, role, student_id`)
      .bind(
        info.union_id ?? "",
        info.user_id ?? "",
        info.name ?? info.en_name ?? row.display_name,
        info.avatar_url ?? info.avatar_thumb ?? row.avatar_url,
        info.enterprise_email ?? info.email ?? row.email,
        configuredRole,
        row.id,
      )
      .first<UserRow>();
  }
  if (!row) throw new Error("无法建立飞书用户记录");
  row = await autoBindVerifiedStudent(row);

  const token = randomToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await d1.batch([
    d1.prepare("DELETE FROM app_sessions WHERE datetime(expires_at) <= CURRENT_TIMESTAMP"),
    d1.prepare("INSERT INTO app_sessions (token_hash, app_user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, row.id, expiresAt),
  ]);

  return { user: mapUser(row), token, expiresAt };
}

function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

export function sessionCookie(token: string, expiresAt: string) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function getAppUser(request: Request) {
  if (!isFeishuConfigured()) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  await ensureDatabase();
  const tokenHash = await hashToken(token);
  const row = await getD1().prepare(`SELECT u.id, u.feishu_open_id, u.display_name, u.avatar_url, u.email, u.role, u.student_id
    FROM app_sessions s JOIN app_users u ON u.id = s.app_user_id
    WHERE s.token_hash = ? AND datetime(s.expires_at) > CURRENT_TIMESTAMP AND u.active = 1`)
    .bind(tokenHash)
    .first<UserRow>();
  return row ? mapUser(row) : null;
}

export async function deleteSession(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  await ensureDatabase();
  await getD1().prepare("DELETE FROM app_sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
}

export function authError(status: 401 | 403 | 503, code: string, error: string) {
  return Response.json({ code, error }, { status });
}

export async function requireAppUser(request: Request, roles?: AppRole[]) {
  if (!isFeishuConfigured()) {
    return { response: authError(503, "FEISHU_NOT_CONFIGURED", "飞书企业自建应用尚未配置") } as const;
  }
  const user = await getAppUser(request);
  if (!user) return { response: authError(401, "FEISHU_AUTH_REQUIRED", "请从飞书工作台打开并完成登录") } as const;
  if (user.role === "pending") {
    return { response: authError(403, "FEISHU_ACCOUNT_PENDING", "账号已验证，等待超级管理员授权") } as const;
  }
  if (roles && !roles.includes(user.role)) {
    return { response: authError(403, "FORBIDDEN", "当前账号没有此操作权限") } as const;
  }
  return { user } as const;
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
