import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";

type UserRole = "admin" | "mentor" | "student" | "pending";

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

export async function GET(request: Request) {
  const auth = await requireAppUser(request, ["admin"]);
  if ("response" in auth) return auth.response;
  await ensureDatabase();
  const d1 = getD1();
  const [users, assignments] = await Promise.all([
    d1.prepare(`SELECT
      u.id, u.display_name, u.avatar_url, u.email, u.role, u.student_id,
      u.last_login_at, s.display_name AS student_name
      FROM app_users u LEFT JOIN students s ON s.id = u.student_id
      WHERE u.active = 1
      ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'mentor' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, u.display_name`)
      .all<ManagedUserRow>(),
    d1.prepare(`SELECT mentor_user_id, student_id FROM mentor_student_assignments
      WHERE active = 1 ORDER BY mentor_user_id, student_id`)
      .all<{ mentor_user_id: number; student_id: string }>(),
  ]);
  return Response.json({
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
    const auth = await requireAppUser(request, ["admin"]);
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
    if (!Number.isInteger(userId) || !role || !["admin", "mentor", "student", "pending"].includes(role)) {
      return Response.json({ error: "角色参数无效" }, { status: 400 });
    }
    if (mentorStudentIds.length > 100) return Response.json({ error: "导师分配学生数量超出限制" }, { status: 400 });
    if (userId === auth.user.id && role !== "admin") {
      return Response.json({ error: "不能移除自己的管理员权限" }, { status: 400 });
    }
    if (role === "student" && !studentId) {
      return Response.json({ error: "学生账号必须绑定学生记录" }, { status: 400 });
    }

    await ensureDatabase();
    const d1 = getD1();
    const existing = await d1.prepare("SELECT id, role, student_id FROM app_users WHERE id = ? AND active = 1")
      .bind(userId).first<{ id: number; role: UserRole; student_id: string | null }>();
    if (!existing) return Response.json({ error: "用户不存在" }, { status: 404 });

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
      : role === "admin" ? existing.student_id : null;
    const statements = [
      d1.prepare("UPDATE app_users SET role = ?, student_id = ? WHERE id = ? AND active = 1")
        .bind(role, nextStudentId, userId),
      d1.prepare("DELETE FROM mentor_student_assignments WHERE mentor_user_id = ?").bind(userId),
    ];
    if (role === "mentor") {
      statements.push(...mentorStudentIds.map((assignedStudentId) =>
        d1.prepare(`INSERT INTO mentor_student_assignments
          (mentor_user_id, student_id, relationship, can_review, active)
          VALUES (?, ?, 'primary', 1, 1)`)
          .bind(userId, assignedStudentId),
      ));
    }
    await d1.batch(statements);
    return Response.json({
      message: role === "mentor"
        ? `导师角色已更新，当前负责 ${mentorStudentIds.length} 名学生`
        : "账号角色已更新",
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "更新失败" }, { status: 500 });
  }
}
