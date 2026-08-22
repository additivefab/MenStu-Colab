import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, getFeishuConfig, requireAppUser } from "../../../lib/feishu-auth";
import { decideRoleChange, type UserRole } from "../../../lib/role-policy";

type ManagedUserRow = {
  id: number;
  display_name: string;
  avatar_url: string;
  email: string;
  role: UserRole;
  student_id: string | null;
  student_name: string | null;
  last_login_at: string;
};

const userRoles = new Set<UserRole>(["superadmin", "admin", "mentor", "student", "pending"]);

export async function GET(request: Request) {
  const auth = await requireAppUser(request, ["superadmin", "admin"]);
  if ("response" in auth) return auth.response;
  await ensureDatabase();
  const d1 = getD1();
  const bootstrapOpenId = getFeishuConfig().superAdminOpenId;
  const [users, assignments, superAdminCount, bootstrapTarget] = await Promise.all([
    d1.prepare(`SELECT
      u.id, u.display_name, u.avatar_url, u.email, u.role, u.student_id,
      u.last_login_at, s.display_name AS student_name
      FROM app_users u LEFT JOIN students s ON s.id = u.student_id
      WHERE u.active = 1
      ORDER BY CASE u.role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 WHEN 'mentor' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,
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
  const bootstrapPending = auth.user.role === "admin" && Number(superAdminCount?.count ?? 0) === 0;
  return Response.json({
    viewer: { id: auth.user.id, role: auth.user.role },
    superadmin_bootstrap_pending: bootstrapPending,
    can_bootstrap_superadmin: bootstrapPending && Boolean(bootstrapOpenId && bootstrapTarget?.id),
    bootstrap_superadmin_user_id: bootstrapPending && bootstrapOpenId ? bootstrapTarget?.id ?? null : null,
    users: users.results.map((user) => ({
      ...user,
      mentor_student_ids: assignments.results
        .filter((item) => item.mentor_user_id === user.id)
        .map((item) => item.student_id),
    })),
  });
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
    const mentorStudentIds = Array.isArray(body.studentIds)
      ? Array.from(new Set(body.studentIds.map((item) => String(item).trim()).filter(Boolean)))
      : [];
    if (!Number.isInteger(userId) || !role || !userRoles.has(role)) {
      return Response.json({ error: "角色参数无效" }, { status: 400 });
    }
    if (mentorStudentIds.length > 100) return Response.json({ error: "导师分配学生数量超出限制" }, { status: 400 });
    if (role === "student" && !studentId) {
      return Response.json({ error: "学生账号必须绑定学生记录" }, { status: 400 });
    }

    await ensureDatabase();
    const d1 = getD1();
    const [existing, superAdminCount] = await Promise.all([
      d1.prepare("SELECT id, feishu_open_id, role, student_id FROM app_users WHERE id = ? AND active = 1")
        .bind(userId).first<{ id: number; feishu_open_id: string; role: UserRole; student_id: string | null }>(),
      d1.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'superadmin' AND active = 1")
        .first<{ count: number }>(),
    ]);
    if (!existing) return Response.json({ error: "用户不存在" }, { status: 404 });

    const activeSuperAdmins = Number(superAdminCount?.count ?? 0);
    const roleDecision = decideRoleChange({
      callerRole: auth.user.role,
      callerUserId: auth.user.id,
      targetUserId: userId,
      targetRole: existing.role,
      nextRole: role,
      activeSuperAdmins,
    });
    if (!roleDecision.allowed) {
      return Response.json({ error: roleDecision.error }, { status: roleDecision.status });
    }
    const bootstrapOpenId = getFeishuConfig().superAdminOpenId;
    if (roleDecision.bootstrapSuperAdmin && (!bootstrapOpenId || existing.feishu_open_id !== bootstrapOpenId)) {
      return Response.json({ error: "首次超级管理员只能授予预先绑定的已核验飞书账号" }, { status: 403 });
    }

    const idsToValidate = role === "student" && studentId ? [studentId] : role === "mentor" ? mentorStudentIds : [];
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
    const auditDetail = role === "mentor"
      ? `保存导师授权：${mentorStudentIds.length} 名学生`
      : roleDecision.bootstrapSuperAdmin ? "首次超级管理员授予" : "保存账号角色";
    const roleChangeRequestId = crypto.randomUUID();
    const updateGuards = [
      "role = ?",
      "EXISTS (SELECT 1 FROM app_users actor WHERE actor.id = ? AND actor.active = 1 AND actor.role = ?)",
    ];
    const updateBindings: Array<string | number | null> = [
      role, nextStudentId, userId, existing.role, auth.user.id, auth.user.role,
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
    const statements = [
      d1.prepare(`UPDATE app_users SET role = ?, student_id = ?
        WHERE id = ? AND active = 1 AND ${updateGuards.join(" AND ")}`)
        .bind(...updateBindings),
      d1.prepare(`INSERT INTO app_user_role_events
        (target_user_id, actor_user_id, request_id, from_role, to_role, detail)
        SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`)
        .bind(userId, auth.user.id, roleChangeRequestId, existing.role, role, auditDetail),
      d1.prepare(`DELETE FROM mentor_student_assignments WHERE mentor_user_id = ?
        AND EXISTS (SELECT 1 FROM app_user_role_events WHERE request_id = ?)`)
        .bind(userId, roleChangeRequestId),
    ];
    if (role === "mentor") {
      statements.push(...mentorStudentIds.map((assignedStudentId) =>
        d1.prepare(`INSERT INTO mentor_student_assignments
          (mentor_user_id, student_id, relationship, can_review, active)
          SELECT ?, ?, 'primary', 1, 1
          WHERE EXISTS (SELECT 1 FROM app_user_role_events WHERE request_id = ?)`)
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
      message: role === "mentor"
        ? `导师角色已更新，当前负责 ${mentorStudentIds.length} 名学生`
        : role === "superadmin" ? "超级管理员权限已授予并写入审计记录" : "账号角色已更新并写入审计记录",
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "更新失败" }, { status: 500 });
  }
}
