import { canViewStudent } from "../../../../lib/authorization";
import { getD1 } from "../../../../lib/database";
import { requireAppUser } from "../../../../lib/feishu-auth";
import { isGithubAppConfigured } from "../../../../lib/github/tokens.ts";
import { readResearchLoopReadiness } from "../../../../lib/research-loop-readiness";

// Read-only readiness checklist for a student's research loop (frontend plan
// F6). Booleans and counts only; the viewer's own provider names are the only
// strings returned besides the requested student ID.
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
    const studentId = new URL(request.url).searchParams.get("studentId") ?? "";
    if (!ID_PATTERN.test(studentId)) return json({ code: "INVALID_INPUT", error: "学生无效" }, 400);
    if (!(await canViewStudent(auth.user, studentId))) return json({ code: "FORBIDDEN", error: "无权查看该学生的代码与实验条件" }, 403);
    const d1 = getD1();
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
    if (!student) return json({ code: "NOT_FOUND", error: "学生不存在或已停用" }, 404);
    return json(await readResearchLoopReadiness(d1, {
      studentId,
      viewerUserId: auth.user.id,
      githubAppConfigured: isGithubAppConfigured(),
      viewerCanConfigure: auth.user.role === "superadmin",
    }));
  } catch (error) {
    console.error("research loop readiness failure", error);
    return json({ code: "INTERNAL", error: "闭环条件暂时无法读取，请稍后重试" }, 500);
  }
}
