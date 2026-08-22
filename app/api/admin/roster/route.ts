import { assertSameOrigin, requireAppUser } from "../../../../lib/feishu-auth";
import { ensureDatabase, getD1 } from "../../../../lib/database";
import { confirmedRoster } from "../../../../lib/confirmed-roster";

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) {
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    }
    const auth = await requireAppUser(request, ["superadmin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const d1 = getD1();
    const trackingStartedAt = new Date().toISOString();
    const statements = [
      d1.prepare("UPDATE students SET active = 0 WHERE id LIKE 'phd-%' OR id LIKE 'master-%'"),
      ...confirmedRoster.map((student) =>
        d1.prepare(`INSERT INTO students
          (id, display_name, degree, grade_year, stage, cadence_days, current_focus, tracking_started_at, active)
          VALUES (?, ?, ?, ?, '待确认', 30, '待补充', ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            display_name = excluded.display_name,
            degree = excluded.degree,
            grade_year = excluded.grade_year,
            active = 1`)
          .bind(student.id, student.name, student.degree, student.gradeYear, trackingStartedAt),
      ),
    ];
    await d1.batch(statements);

    const counts = await d1.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN degree = '博士' THEN 1 ELSE 0 END) AS doctors,
      SUM(CASE WHEN degree = '硕士' THEN 1 ELSE 0 END) AS masters
      FROM students WHERE active = 1`).first<{ total: number; doctors: number; masters: number }>();
    if (counts?.total !== 26 || counts.doctors !== 12 || counts.masters !== 14) {
      throw new Error("名册写入后的数量校验失败");
    }

    return Response.json({
      message: "真实学生名册已导入",
      total: counts.total,
      doctors: counts.doctors,
      masters: counts.masters,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "名册导入失败" }, { status: 500 });
  }
}
