import { canViewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { sha256Text, validateHttpsUrl } from "../../../lib/progress-evidence";

const allowedKinds = new Set(["文献", "实验", "算法", "数据", "论文", "复现", "项目", "组会"]);

class InputError extends Error {}

function clean(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new InputError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

async function evidenceStatements(
  progressId: number,
  userId: number,
  values: { summary: string; evidence: string; literatureRef: string; gitUrl: string },
  conditional = false,
) {
  const d1 = getD1();
  const hash = await sha256Text(`${values.summary}\n${values.evidence}\n${values.literatureRef}\n${values.gitUrl}`);
  const statements = [
    d1.prepare(conditional ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, created_by_user_id)
      SELECT ?, 'manual', '提交时填写的核验证据', '', ?, ? WHERE changes() > 0` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, created_by_user_id)
      VALUES (?, 'manual', '提交时填写的核验证据', '', ?, ?)`)
      .bind(progressId, hash, userId),
  ];
  if (values.literatureRef) {
    statements.push(d1.prepare(conditional ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, created_by_user_id)
      SELECT ?, 'doi', '论文或 DOI', ?, ?, ? WHERE changes() > 0` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, created_by_user_id)
      VALUES (?, 'doi', '论文或 DOI', ?, ?, ?)`)
      .bind(progressId, values.literatureRef, await sha256Text(values.literatureRef), userId));
  }
  if (values.gitUrl) {
    statements.push(d1.prepare(conditional ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, created_by_user_id)
      SELECT ?, 'git', 'Git 仓库或提交', ?, ?, ? WHERE changes() > 0` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, created_by_user_id)
      VALUES (?, 'git', 'Git 仓库或提交', ?, ?, ?)`)
      .bind(progressId, values.gitUrl, await sha256Text(values.gitUrl), userId));
  }
  return statements;
}

function progressInput(body: Record<string, unknown>) {
  const studentId = clean(body.studentId, "学生", 80);
  const kind = clean(body.kind, "进展类型", 20);
  const title = clean(body.title, "进展标题", 160);
  const summary = clean(body.summary, "新增结论", 12_000);
  const evidence = clean(body.evidence, "证据", 4_000);
  const literatureRef = clean(body.literatureRef, "论文或 DOI", 1_000);
  const rawGitUrl = clean(body.gitUrl, "Git 链接", 2_048);
  let gitUrl = "";
  try {
    gitUrl = validateHttpsUrl(rawGitUrl, "Git 链接");
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "Git 链接格式无效");
  }
  if (!studentId || !allowedKinds.has(kind) || !title || !summary || !evidence) {
    throw new InputError("请完整填写学生、类型、进展、结论和证据");
  }
  if (kind === "文献" && !literatureRef) throw new InputError("文献进展需要填写论文题目或 DOI");
  return { studentId, kind, title, summary, evidence, literatureRef, gitUrl };
}

export async function POST(request: Request) {
  let createdId: number | null = null;
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    if (auth.user.role === "student" && !auth.user.studentId) {
      return Response.json({ error: "学生账号尚未绑定学生记录" }, { status: 403 });
    }
    const values = progressInput({
      ...body,
      studentId: auth.user.role === "student" ? auth.user.studentId : body.studentId,
    });

    const d1 = getD1();
    if (auth.user.role !== "student" && !(await canViewStudent(auth.user, values.studentId))) {
      return Response.json({ error: "当前账号无权为该学生提交进展" }, { status: 403 });
    }
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1")
      .bind(values.studentId).first();
    if (!student) return Response.json({ error: "学生不存在" }, { status: 404 });

    const row = await d1.prepare(`INSERT INTO progress_entries
      (student_id, kind, title, summary, evidence, literature_ref, git_url, status,
       review_status, submitted_by_user_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'submitted', ?, CURRENT_TIMESTAMP) RETURNING id`)
      .bind(
        values.studentId, values.kind, values.title, values.summary, values.evidence,
        values.literatureRef, values.gitUrl, auth.user.id,
      )
      .first<{ id: number }>();
    createdId = row?.id ?? null;
    if (!createdId) throw new Error("无法建立进展记录");

    await d1.batch([
      ...(await evidenceStatements(createdId, auth.user.id, values)),
      d1.prepare(`INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
        VALUES (?, ?, 'user', 'submit', '', 'submitted', '提交进展与核验证据')`)
        .bind(createdId, auth.user.id),
    ]);
    const id = createdId;
    createdId = null;
    return Response.json({ id, message: "已提交，等待导师确认" }, { status: 201 });
  } catch (error) {
    if (createdId) {
      try { await getD1().prepare("DELETE FROM progress_entries WHERE id = ?").bind(createdId).run(); } catch { /* noop */ }
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "提交失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const id = Number(body.id);
    if (!Number.isInteger(id)) return Response.json({ error: "进展参数无效" }, { status: 400 });

    const d1 = getD1();
    const existing = await d1.prepare(`SELECT id, student_id, kind, title, review_status
      FROM progress_entries WHERE id = ?`).bind(id).first<{
        id: number; student_id: string; kind: string; title: string; review_status: string;
      }>();
    if (!existing) return Response.json({ error: "进展记录不存在" }, { status: 404 });
    if (!(await canViewStudent(auth.user, existing.student_id))) {
      return Response.json({ error: "无权修改该学生的进展" }, { status: 403 });
    }
    if (existing.review_status !== "changes_requested") {
      return Response.json({ error: "只有导师退回补充的证据可以重新提交" }, { status: 409 });
    }

    const values = progressInput({
      ...body,
      studentId: existing.student_id,
      kind: body.kind ?? existing.kind,
      title: body.title ?? existing.title,
    });
    const [result] = await d1.batch([
      d1.prepare(`UPDATE progress_entries SET
        kind = ?, title = ?, summary = ?, evidence = ?, literature_ref = ?, git_url = ?,
        status = 'pending', review_status = 'submitted', assessment = NULL,
        reviewer_note = '', submitted_by_user_id = ?, reviewed_by_user_id = NULL, reviewed_at = NULL,
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND review_status = 'changes_requested'`)
        .bind(values.kind, values.title, values.summary, values.evidence, values.literatureRef, values.gitUrl, auth.user.id, id),
      ...(await evidenceStatements(id, auth.user.id, values, true)),
      d1.prepare(`INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
        SELECT ?, ?, 'user', 'resubmit', 'changes_requested', 'submitted', '补充证据并重新提交'
        WHERE changes() > 0`)
        .bind(id, auth.user.id),
    ]);
    if (!result.meta.changes) return Response.json({ error: "记录状态已变化，请刷新后重试" }, { status: 409 });
    return Response.json({ message: "补充证据已重新提交导师审核" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "重新提交失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}
