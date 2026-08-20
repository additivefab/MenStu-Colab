import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";

type UserRole = "admin" | "student" | "pending";

export async function GET(request: Request) {
  const auth = await requireAppUser(request, ["admin"]);
  if ("response" in auth) return auth.response;
  await ensureDatabase();
  const { results } = await getD1().prepare(`SELECT
    u.id, u.display_name, u.avatar_url, u.email, u.role, u.student_id,
    u.last_login_at, s.display_name AS student_name
    FROM app_users u LEFT JOIN students s ON s.id = u.student_id
    WHERE u.active = 1 ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, u.display_name`).all();
  return Response.json({ users: results });
}

export async function PATCH(request: Request) {
  try {
    if (!assertSameOrigin(request)) {
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    }
    const auth = await requireAppUser(request, ["admin"]);
    if ("response" in auth) return auth.response;
    const body = (await request.json()) as { userId?: number; role?: UserRole; studentId?: string | null };
    const userId = Number(body.userId);
    const role = body.role;
    const studentId = body.studentId?.trim() || null;
    if (!Number.isInteger(userId) || !role || !["admin", "student", "pending"].includes(role)) {
      return Response.json({ error: "角色参数无效" }, { status: 400 });
    }
    if (userId === auth.user.id && role !== "admin") {
      return Response.json({ error: "不能移除自己的管理员权限" }, { status: 400 });
    }
    if (role === "student" && !studentId) {
      return Response.json({ error: "学生账号必须绑定学生记录" }, { status: 400 });
    }

    await ensureDatabase();
    const d1 = getD1();
    if (studentId) {
      const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
      if (!student) return Response.json({ error: "学生记录不存在" }, { status: 404 });
      const occupied = await d1.prepare("SELECT id FROM app_users WHERE student_id = ? AND id != ?").bind(studentId, userId).first();
      if (occupied) return Response.json({ error: "该学生已绑定其他飞书账号" }, { status: 409 });
    }

    const result = await d1.prepare("UPDATE app_users SET role = ?, student_id = ? WHERE id = ? AND active = 1")
      .bind(role, role === "student" ? studentId : null, userId)
      .run();
    if (!result.meta.changes) return Response.json({ error: "用户不存在" }, { status: 404 });
    return Response.json({ message: "账号角色已更新" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "更新失败" }, { status: 500 });
  }
}
