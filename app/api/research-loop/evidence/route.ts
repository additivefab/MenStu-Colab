import { canViewStudent } from "../../../../lib/authorization";
import { getD1 } from "../../../../lib/database";
import { requireAppUser } from "../../../../lib/feishu-auth";
import { EvidenceInputError, parseEvidencePeriod, readEvidenceReport } from "../../../../lib/research-loop-evidence";

// Weekly-meeting evidence list for one student (frontend plan FA4). Viewers in
// scope only; read-only; no scores, counts across students or rankings.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function privateAuthResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateAuthResponse(auth.response);
    const params = new URL(request.url).searchParams;
    const studentId = params.get("studentId") ?? "";
    if (!ID_PATTERN.test(studentId)) return json({ code: "INVALID_INPUT", error: "学生无效" }, 400);
    let period;
    try { period = parseEvidencePeriod(params.get("from"), params.get("to")); }
    catch (error) {
      if (error instanceof EvidenceInputError) return json({ code: "INVALID_INPUT", error: error.message }, 400);
      throw error;
    }
    if (!(await canViewStudent(auth.user, studentId))) return json({ code: "FORBIDDEN", error: "无权查看该学生的科研证据" }, 403);
    const d1 = getD1();
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
    if (!student) return json({ code: "NOT_FOUND", error: "学生不存在或已停用" }, 404);
    return json(await readEvidenceReport(d1, studentId, period));
  } catch (error) {
    console.error("research loop evidence failure", error);
    return json({ code: "INTERNAL", error: "证据清单暂时无法生成，请稍后重试" }, 500);
  }
}
