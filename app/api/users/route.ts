import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, getFeishuConfig, requireAppUser } from "../../../lib/feishu-auth";
import { decideRoleChange, type UserRole } from "../../../lib/role-policy";

type ManagedUserRow = {
  id: number;
  display_name: string;
  avatar_url: string;
  role: UserRole;
  student_id: string | null;
  student_name: string | null;
  last_login_at: string;
  local_username: string | null;
  local_active: number;
  local_pending: number;
  local_expires_at: string | null;
};

const userRoles = new Set<UserRole>(["superadmin", "admin", "student", "pending"]);

export async function GET(request: Request) {
  const auth = await requireAppUser(request, ["superadmin", "admin"]);
  if ("response" in auth) return auth.response;
  await ensureDatabase();
  const d1 = getD1();
  const bootstrapOpenId = getFeishuConfig().superAdminOpenId;
  const [users, assignments, superAdminCount, bootstrapTarget] = await Promise.all([
    d1.prepare(`SELECT
      u.id, u.display_name, u.avatar_url,
      CASE WHEN u.role = 'mentor' THEN 'admin' ELSE u.role END AS role,
      u.student_id,
      u.last_login_at, s.display_name AS student_name,
      c.username AS local_username, c.password_hash IS NOT NULL AS local_active,
      (c.activation_hash IS NOT NULL AND datetime(c.activation_expires_at) > CURRENT_TIMESTAMP) AS local_pending,
      c.activation_expires_at AS local_expires_at
      FROM app_users u LEFT JOIN students s ON s.id = u.student_id
      LEFT JOIN local_credentials c ON c.app_user_id = u.id
      WHERE u.active = 1
      ORDER BY CASE u.role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 WHEN 'mentor' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
      u.display_name`)
      .all<ManagedUserRow>(),
    d1.prepare(`SELECT mentor_user_id, student_id FROM mentor_student_assignments
      WHERE active = 1 ORDER BY mentor_user_id, student_id`)
      .all<{ mentor_user_id: number; student_id: string }>(),
    d1.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'superadmin' AND active = 1")
      .first<{ count: number }>(),
    d1.prepare("SELECT id FROM app_users WHERE feishu_open_id = ? AND active = 1")
      .bind(bootstrapOpenId).first<{ id: number }>(),
  ]);
  const activeSuperAdmins = Number(superAdminCount?.count ?? 0);
  const bootstrapPending = auth.user.role === "admin" && activeSuperAdmins === 0;
  if (auth.user.role === "admin" && !bootstrapPending) {
    return Response.json({ error: "只有超级管理员可以管理账号角色" }, { status: 403 });
  }
  const visibleUsers = auth.user.role === "superadmin"
    ? users.results
    : users.results.filter((user) => user.id === auth.user.id);
  return Response.json({
    viewer: { id: auth.user.id, role: auth.user.role },
    superadmin_bootstrap_pending: bootstrapPending,
    can_bootstrap_superadmin: bootstrapPending
      && Boolean(bootstrapOpenId)
      && bootstrapTarget?.id === auth.user.id,
    bootstrap_superadmin_user_id: bootstrapPending
      && bootstrapOpenId
      && bootstrapTarget?.id === auth.user.id
      ? auth.user.id
      : null,
    users: visibleUsers.map((user) => ({
      ...user,
      local_account: user.local_username ? {
        username: user.local_username,
        status: user.local_active ? "active" : user.local_pending ? "pending" : "disabled",
        activationExpiresAt: user.local_expires_at,
      } : null,
      admin_student_ids: assignments.results
        .filter((item) => item.mentor_user_id === user.id)
        .map((item) => item.student_id),
    })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    const body = (await request.json()) as {
      userId?: number;
      role?: UserRole;
      studentId?: string | null;
      studentIds?: unknown;
    };
    const userId = Number(body.userId);
    const role = body.role;
    const studentId = body.studentId?.trim() || null;
    const adminStudentIds = Array.isArray(body.studentIds)
      ? Array.from(new Set(body.studentIds.map((item) => String(item).trim()).filter(Boolean)))
      : [];
    if (!Number.isInteger(userId) || !role || !userRoles.has(role)) {
      return Response.json({ error: "角色参数无效" }, { status: 400 });
    }
    if (role === "student" && !studentId) {
      return Response.json({ error: "学生账号必须绑定学生记录" }, { status: 400 });
    }
    if (adminStudentIds.length > 100) return Response.json({ error: "管理员分配学生数量超出限制" }, { status: 400 });

    await ensureDatabase();
    const d1 = getD1();
    const [existing, superAdminCount] = await Promise.all([
      d1.prepare(`SELECT id, feishu_open_id,
        CASE WHEN role = 'mentor' THEN 'admin' ELSE role END AS role,
        role AS storage_role, student_id
        FROM app_users WHERE id = ? AND active = 1`)
        .bind(userId).first<{
          id: number;
          feishu_open_id: string;
          role: UserRole;
          storage_role: string;
          student_id: string | null;
        }>(),
      d1.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'superadmin' AND active = 1")
        .first<{ count: number }>(),
    ]);
    if (!existing) return Response.json({ error: "用户不存在" }, { status: 404 });

    const activeSuperAdmins = Number(superAdminCount?.count ?? 0);
    const bootstrapOpenId = getFeishuConfig().superAdminOpenId;
    const bootstrapTargetVerified = Boolean(bootstrapOpenId && existing.feishu_open_id === bootstrapOpenId);
    const roleDecision = decideRoleChange({
      callerRole: auth.user.role,
      callerUserId: auth.user.id,
      targetUserId: userId,
      targetRole: existing.role,
      nextRole: role,
      activeSuperAdmins,
      bootstrapTargetVerified,
    });
    if (!roleDecision.allowed) {
      return Response.json({ error: roleDecision.error }, { status: roleDecision.status });
    }
    if (roleDecision.bootstrapSuperAdmin && (!bootstrapOpenId || existing.feishu_open_id !== bootstrapOpenId)) {
      return Response.json({ error: "首次超级管理员只能授予预先绑定的已核验飞书账号" }, { status: 403 });
    }
    if (roleDecision.bootstrapSuperAdmin && request.headers.get("origin") !== new URL(request.url).origin) {
      return Response.json({ error: "首次超级管理员授权必须来自当前系统页面" }, { status: 403 });
    }

    const idsToValidate = role === "student" && studentId ? [studentId] : role === "admin" ? adminStudentIds : [];
    if (idsToValidate.length) {
      const placeholders = idsToValidate.map(() => "?").join(",");
      const valid = await d1.prepare(`SELECT id FROM students WHERE active = 1 AND id IN (${placeholders})`)
        .bind(...idsToValidate).all<{ id: string }>();
      if (valid.results.length !== idsToValidate.length) {
        return Response.json({ error: "分配列表包含不存在或已停用的学生" }, { status: 404 });
      }
    }
    if (role === "student" && studentId) {
      const occupied = await d1.prepare("SELECT id FROM app_users WHERE student_id = ? AND id != ?")
        .bind(studentId, userId).first();
      if (occupied) return Response.json({ error: "该学生已绑定其他飞书账号" }, { status: 409 });
    }

    const nextStudentId = role === "student"
      ? studentId
      : role === "admin" || role === "superadmin" ? existing.student_id : null;
    if (role === existing.role && nextStudentId === existing.student_id && role !== "admin") {
      return Response.json({ message: "账号角色无需更新" });
    }
    const auditDetail = roleDecision.bootstrapSuperAdmin
      ? "首次超级管理员本人初始化"
      : role === "admin" ? `保存管理员（导师）授权：${adminStudentIds.length} 名学生` : "保存账号角色";
    const roleChangeRequestId = crypto.randomUUID();
    const nextStorageRole = role === "admin" ? "mentor" : role;
    const updateGuards = [
      "role = ?",
      `EXISTS (SELECT 1 FROM app_users actor WHERE actor.id = ? AND actor.active = 1
        AND CASE WHEN actor.role = 'mentor' THEN 'admin' ELSE actor.role END = ?)`,
    ];
    const updateBindings: Array<string | number | null> = [
      nextStorageRole, nextStudentId, userId, existing.storage_role, auth.user.id, auth.user.role,
    ];
    if (roleDecision.bootstrapSuperAdmin) {
      updateGuards.push("feishu_open_id = ?");
      updateBindings.push(bootstrapOpenId);
      updateGuards.push("NOT EXISTS (SELECT 1 FROM app_users WHERE role = 'superadmin' AND active = 1)");
    }
    const removingSuperAdmin = existing.role === "superadmin" && role !== "superadmin";
    if (removingSuperAdmin) {
      updateGuards.push("(SELECT COUNT(*) FROM app_users WHERE role = 'superadmin' AND active = 1) > 1");
    }
    const assignmentDelete = role === "admin" && adminStudentIds.length
      ? d1.prepare(`DELETE FROM mentor_student_assignments
          WHERE mentor_user_id = ? AND student_id NOT IN (${adminStudentIds.map(() => "?").join(",")})
          AND EXISTS (SELECT 1 FROM app_user_role_events WHERE request_id = ?)`)
        .bind(userId, ...adminStudentIds, roleChangeRequestId)
      : d1.prepare(`DELETE FROM mentor_student_assignments WHERE mentor_user_id = ?
          AND EXISTS (SELECT 1 FROM app_user_role_events WHERE request_id = ?)`)
        .bind(userId, roleChangeRequestId);
    const statements = [
      d1.prepare(`UPDATE app_users SET role = ?, student_id = ?
        WHERE id = ? AND active = 1 AND ${updateGuards.join(" AND ")}`)
        .bind(...updateBindings),
      d1.prepare(`INSERT INTO app_user_role_events
        (target_user_id, actor_user_id, request_id, from_role, to_role, detail)
        SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`)
        .bind(userId, auth.user.id, roleChangeRequestId, existing.role, role, auditDetail),
      assignmentDelete,
    ];
    if (role === "admin") {
      statements.push(...adminStudentIds.map((assignedStudentId) =>
        d1.prepare(`INSERT INTO mentor_student_assignments
          (mentor_user_id, student_id, relationship, can_review, active)
          SELECT ?, ?, 'primary', 1, 1
          WHERE EXISTS (SELECT 1 FROM app_user_role_events WHERE request_id = ?)
          ON CONFLICT(mentor_user_id, student_id) DO UPDATE SET active = 1`)
          .bind(userId, assignedStudentId, roleChangeRequestId),
      ));
    }
    const [updateResult] = await d1.batch(statements);
    if (!updateResult.meta.changes) {
      const error = roleDecision.bootstrapSuperAdmin
        ? "首次超级管理员已由其他操作完成，或目标账号绑定已变化，请刷新后重试"
        : removingSuperAdmin
          ? "账号状态已变化，或该账号已是最后一名超级管理员，请刷新后重试"
          : "账号或操作者权限状态已变化，请刷新后重试";
      return Response.json({ error }, { status: 409 });
    }
    return Response.json({
      message: role === "superadmin" ? "超级管理员权限已授予并写入审计记录" : "账号角色已更新并写入审计记录",
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "更新失败" }, { status: 500 });
  }
}
