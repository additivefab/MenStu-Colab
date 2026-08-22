import { assertSameOrigin, requireAppUser } from "../../../../lib/feishu-auth";
import { ensureDatabase, getD1 } from "../../../../lib/database";

type RosterStudent = {
  id: string;
  name: string;
  degree: "博士" | "硕士";
  gradeYear: number;
};

const confirmedRoster: RosterStudent[] = [
  { id: "student-001", name: "温浩钰", degree: "博士", gradeYear: 2022 },
  { id: "student-002", name: "佘阳", degree: "博士", gradeYear: 2023 },
  { id: "student-003", name: "曹琛", degree: "博士", gradeYear: 2024 },
  { id: "student-004", name: "何逸凡", degree: "博士", gradeYear: 2024 },
  { id: "student-005", name: "Muhammad Jalil Ur Rehman", degree: "博士", gradeYear: 2024 },
  { id: "student-006", name: "Abbasi", degree: "博士", gradeYear: 2024 },
  { id: "student-007", name: "Mahmoud Noureldien", degree: "博士", gradeYear: 2024 },
  { id: "student-008", name: "孙正昊", degree: "博士", gradeYear: 2025 },
  { id: "student-009", name: "吕秋阳", degree: "博士", gradeYear: 2025 },
  { id: "student-010", name: "邵华阳", degree: "博士", gradeYear: 2025 },
  { id: "student-011", name: "骆文杰", degree: "博士", gradeYear: 2025 },
  { id: "student-012", name: "叶睿昕", degree: "博士", gradeYear: 2025 },
  { id: "student-013", name: "蒋锋", degree: "硕士", gradeYear: 2023 },
  { id: "student-014", name: "侯雨禾", degree: "硕士", gradeYear: 2023 },
  { id: "student-015", name: "邱昊", degree: "硕士", gradeYear: 2023 },
  { id: "student-016", name: "冯卓", degree: "硕士", gradeYear: 2024 },
  { id: "student-017", name: "王少康", degree: "硕士", gradeYear: 2024 },
  { id: "student-018", name: "张永基", degree: "硕士", gradeYear: 2024 },
  { id: "student-019", name: "于畅", degree: "硕士", gradeYear: 2024 },
  { id: "student-020", name: "马振宁", degree: "硕士", gradeYear: 2024 },
  { id: "student-021", name: "陈艳", degree: "硕士", gradeYear: 2025 },
  { id: "student-022", name: "张新茹", degree: "硕士", gradeYear: 2025 },
  { id: "student-023", name: "王俊杰", degree: "硕士", gradeYear: 2025 },
  { id: "student-024", name: "桂洋", degree: "硕士", gradeYear: 2025 },
  { id: "student-025", name: "李小博", degree: "硕士", gradeYear: 2025 },
  { id: "student-026", name: "钟昊航", degree: "硕士", gradeYear: 2025 },
];

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
