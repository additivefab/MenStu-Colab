import { ensureDatabase, getD1, riskFromDate } from "../../../lib/database";

type StudentRow = {
  id: string;
  display_name: string;
  degree: "博士" | "硕士";
  grade_year: number;
  stage: string;
  cadence_days: number;
  current_focus: string;
  last_substantive_at: string | null;
  latest_title: string | null;
  latest_kind: string | null;
};

export async function GET() {
  try {
    await ensureDatabase();
    const d1 = getD1();
    const { results } = await d1.prepare(`SELECT
      s.id, s.display_name, s.degree, s.grade_year, s.stage, s.cadence_days,
      s.current_focus, s.last_substantive_at,
      (SELECT p.title FROM progress_entries p WHERE p.student_id = s.id AND p.status = 'substantive' ORDER BY p.submitted_at DESC LIMIT 1) AS latest_title,
      (SELECT p.kind FROM progress_entries p WHERE p.student_id = s.id AND p.status = 'substantive' ORDER BY p.submitted_at DESC LIMIT 1) AS latest_kind
      FROM students s WHERE s.active = 1 ORDER BY s.degree, s.display_name`).all<StudentRow>();

    const pending = await d1.prepare(`SELECT p.id, p.student_id, p.kind, p.title, p.summary, p.evidence,
      p.literature_ref, p.git_url, p.submitted_at, s.display_name
      FROM progress_entries p JOIN students s ON s.id = p.student_id
      WHERE p.status = 'pending' ORDER BY p.submitted_at DESC`).all();

    const students = results.map((row) => ({
      id: row.id,
      name: row.display_name,
      degree: row.degree,
      gradeYear: row.grade_year,
      stage: row.stage,
      cadenceDays: row.cadence_days,
      currentFocus: row.current_focus,
      lastSubstantiveAt: row.last_substantive_at,
      latestTitle: row.latest_title ?? "尚无已确认记录",
      latestKind: row.latest_kind ?? "待补充",
      risk: riskFromDate(row.last_substantive_at),
    }));

    const riskCounts = students.reduce<Record<string, number>>((acc, student) => {
      acc[student.risk.level] = (acc[student.risk.level] ?? 0) + 1;
      return acc;
    }, {});

    return Response.json({
      students,
      pending: pending.results,
      metrics: {
        total: students.length,
        doctors: students.filter((student) => student.degree === "博士").length,
        masters: students.filter((student) => student.degree === "硕士").length,
        pending: pending.results.length,
        attention: students.filter((student) => student.risk.level !== "正常").length,
        riskCounts,
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取失败" }, { status: 500 });
  }
}
