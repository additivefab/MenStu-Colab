import { getStudentScope, scopeSql } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { requireAppUser } from "../../../lib/feishu-auth";
import { problemRecordBatches, type ProblemRecordStudent, type ProblemRecordsPayload } from "../../../lib/problem-records";
import { loadProblemRecords } from "../../../lib/problem-records-service";

const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const database = getD1();
    const studentScope = await getStudentScope(auth.user);
    const scopes = studentScope.all ? [studentScope] : problemRecordBatches([...new Set(studentScope.studentIds)])
      .map((studentIds) => ({ all: false, studentIds }));
    const students: ProblemRecordStudent[] = [];
    for (const part of scopes) {
      const scope = scopeSql(part, "s.id");
      const rows = await database.prepare(`SELECT s.id, s.display_name, s.stage FROM students s
        WHERE s.active = 1${scope.clause} ORDER BY s.display_name, s.id`)
        .bind(...scope.bindings).all<{ id: string; display_name: string; stage: string }>();
      students.push(...rows.results.map((row) => ({
        id: row.id, name: row.display_name, stage: row.stage,
        // Match POST /api/student-guidance: assigned mentors may record daily guidance without formal-review authority.
        canRecord: auth.user.studentId !== row.id,
      })));
    }
    students.sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
    const payload: ProblemRecordsPayload = {
      records: await loadProblemRecords(database, students), students, generatedAt: new Date().toISOString(),
    };
    return Response.json(payload, { headers: privateHeaders });
  } catch {
    return Response.json({ error: "问题记录读取失败，请稍后重试" }, { status: 500, headers: privateHeaders });
  }
}
