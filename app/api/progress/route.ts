import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";

const allowedKinds = new Set(["文献", "实验", "算法", "数据", "论文", "复现", "项目"]);

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) {
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    }
    const auth = await requireAppUser(request, ["admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const studentId = String(body.studentId ?? "").trim();
    const kind = String(body.kind ?? "").trim();
    const title = String(body.title ?? "").trim();
    const summary = String(body.summary ?? "").trim();
    const evidence = String(body.evidence ?? "").trim();
    const literatureRef = String(body.literatureRef ?? "").trim();
    const gitUrl = String(body.gitUrl ?? "").trim();

    if (!studentId || !allowedKinds.has(kind) || !title || !summary || !evidence) {
      return Response.json({ error: "请完整填写学生、类型、进展、结论和证据" }, { status: 400 });
    }
    if (kind === "文献" && !literatureRef) {
      return Response.json({ error: "文献进展需要填写论文题目或 DOI" }, { status: 400 });
    }
    if (auth.user.role === "student" && auth.user.studentId !== studentId) {
      return Response.json({ error: "学生账号只能提交自己的进展" }, { status: 403 });
    }

    const d1 = getD1();
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
    if (!student) return Response.json({ error: "学生不存在" }, { status: 404 });

    const row = await d1.prepare(`INSERT INTO progress_entries
      (student_id, kind, title, summary, evidence, literature_ref, git_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id`)
      .bind(studentId, kind, title, summary, evidence, literatureRef, gitUrl)
      .first<{ id: number }>();

    return Response.json({ id: row?.id, message: "已提交，等待导师确认" }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "提交失败" }, { status: 500 });
  }
}
