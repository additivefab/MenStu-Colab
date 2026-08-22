import { ensureDatabase, getD1, riskFromDate } from "../../../lib/database";
import { requireAppUser } from "../../../lib/feishu-auth";

type StudentRow = {
  id: string;
  display_name: string;
  degree: "博士" | "硕士";
  grade_year: number;
  stage: string;
  cadence_days: number;
  current_focus: string;
  last_substantive_at: string | null;
  tracking_started_at: string | null;
  latest_title: string | null;
  latest_kind: string | null;
};

type ProgressRow = {
  id: number;
  student_id: string;
  kind: string;
  title: string;
  summary: string;
  evidence: string;
  status: "pending" | "substantive" | "supporting" | "supplement" | "rejected";
  reviewer_note: string;
  submitted_at: string;
  reviewed_at: string | null;
};

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["admin", "student"]);
    if ("response" in auth) return auth.response;
    const viewer = auth.user;
    if (viewer.role === "student" && !viewer.studentId) {
      return Response.json(
        { code: "FEISHU_ACCOUNT_PENDING", error: "飞书账号尚未绑定学生记录" },
        { status: 403 },
      );
    }
    await ensureDatabase();
    const d1 = getD1();
    const studentQuery = d1.prepare(`SELECT
      s.id, s.display_name, s.degree, s.grade_year, s.stage, s.cadence_days,
      s.current_focus, s.last_substantive_at, s.tracking_started_at,
      (SELECT p.title FROM progress_entries p WHERE p.student_id = s.id AND p.status = 'substantive' ORDER BY p.submitted_at DESC LIMIT 1) AS latest_title,
      (SELECT p.kind FROM progress_entries p WHERE p.student_id = s.id AND p.status = 'substantive' ORDER BY p.submitted_at DESC LIMIT 1) AS latest_kind
      FROM students s WHERE s.active = 1 ${viewer.role === "student" ? "AND s.id = ?" : ""}
      ORDER BY CASE s.degree WHEN '博士' THEN 0 ELSE 1 END, s.grade_year, s.display_name`);
    const { results } = viewer.role === "student"
      ? await studentQuery.bind(viewer.studentId).all<StudentRow>()
      : await studentQuery.all<StudentRow>();

    const pending = viewer.role === "admin"
      ? await d1.prepare(`SELECT p.id, p.student_id, p.kind, p.title, p.summary, p.evidence,
        p.literature_ref, p.git_url, p.submitted_at, s.display_name
        FROM progress_entries p JOIN students s ON s.id = p.student_id
        WHERE p.status = 'pending' ORDER BY p.submitted_at DESC`).all()
      : { results: [] };

    const studentIds = results.map((row) => row.id);
    let progressRows: ProgressRow[] = [];
    if (studentIds.length) {
      const placeholders = studentIds.map(() => "?").join(",");
      const progress = await d1.prepare(`SELECT id, student_id, kind, title, summary, evidence,
        status, reviewer_note, submitted_at, reviewed_at FROM progress_entries
        WHERE student_id IN (${placeholders}) ORDER BY submitted_at DESC, id DESC LIMIT 1000`)
        .bind(...studentIds).all<ProgressRow>();
      progressRows = progress.results;
    }

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
      risk: riskFromDate(row.last_substantive_at ?? row.tracking_started_at),
      progress: progressRows.filter((entry) => entry.student_id === row.id),
    }));

    const riskCounts = students.reduce<Record<string, number>>((acc, student) => {
      acc[student.risk.level] = (acc[student.risk.level] ?? 0) + 1;
      return acc;
    }, {});

    return Response.json({
      viewer: {
        name: viewer.displayName,
        avatarUrl: viewer.avatarUrl,
        role: viewer.role,
        studentId: viewer.studentId,
      },
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
