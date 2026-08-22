import { canViewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { isIsoDate } from "../../../lib/paper-progress";

const guidanceTypes = new Set(["meeting_followup", "paper", "milestone", "blocker", "general"]);
const guidanceStatuses = new Set(["open", "completed"]);

class InputError extends Error {}

function clean(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new InputError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

async function readStudentWorkspace(studentId: string) {
  const d1 = getD1();
  const [notes, meetingSummaries] = await Promise.all([
    d1.prepare(`SELECT n.id, n.student_id, n.source_progress_entry_id, n.guidance_type, n.title,
      n.content, n.next_action, n.due_date, n.status, n.created_at, n.updated_at,
      u.display_name AS mentor_name, p.title AS source_title, p.kind AS source_kind
      FROM student_guidance_notes n
      JOIN app_users u ON u.id = n.mentor_user_id
      LEFT JOIN progress_entries p ON p.id = n.source_progress_entry_id
      WHERE n.student_id = ?
      ORDER BY CASE n.status WHEN 'open' THEN 0 ELSE 1 END, n.created_at DESC, n.id DESC
      LIMIT 200`).bind(studentId).all(),
    d1.prepare(`SELECT l.id AS link_id, i.id AS import_id, l.progress_entry_id,
      p.title, p.summary, p.evidence, p.review_status, p.assessment, p.reviewer_note,
      p.submitted_at, i.detected_reason, i.message_created_at, i.received_at,
      l.created_at AS saved_at,
      (SELECT e.source_type FROM progress_evidence_sources e
        WHERE e.progress_entry_id = p.id AND e.source_import_id = i.id
        ORDER BY e.id LIMIT 1) AS source_type,
      (SELECT e.label FROM progress_evidence_sources e
        WHERE e.progress_entry_id = p.id AND e.source_import_id = i.id
        ORDER BY e.id LIMIT 1) AS source_label,
      (SELECT e.content_sha256 FROM progress_evidence_sources e
        WHERE e.progress_entry_id = p.id AND e.source_import_id = i.id
        ORDER BY e.id LIMIT 1) AS content_sha256
      FROM feishu_meeting_summary_links l
      JOIN feishu_meeting_summary_imports i ON i.id = l.import_id
      JOIN progress_entries p ON p.id = l.progress_entry_id
      WHERE l.student_id = ? AND i.status = 'confirmed'
      ORDER BY i.message_created_at DESC, l.id DESC
      LIMIT 200`).bind(studentId).all(),
  ]);
  return { notes: notes.results, meetingSummaries: meetingSummaries.results };
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const studentId = new URL(request.url).searchParams.get("studentId")?.trim() ?? "";
    if (!studentId) return Response.json({ error: "缺少学生参数" }, { status: 400 });
    if (!(await canViewStudent(auth.user, studentId))) {
      return Response.json({ error: "无权查看该学生的指导与飞书总结" }, { status: 403 });
    }
    return Response.json(await readStudentWorkspace(studentId));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "导师指导读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = await request.json() as Record<string, unknown>;
    const studentId = clean(body.studentId, "学生", 80);
    const guidanceType = clean(body.guidanceType, "指导类型", 40) || "general";
    const title = clean(body.title, "指导主题", 200);
    const content = clean(body.content, "指导内容", 3000);
    const nextAction = clean(body.nextAction, "下一步行动", 800);
    const dueDate = clean(body.dueDate, "完成期限", 10);
    const sourceProgressEntryId = body.sourceProgressEntryId ? Number(body.sourceProgressEntryId) : null;
    if (!studentId || !guidanceTypes.has(guidanceType) || !content) {
      throw new InputError("请完整填写学生、指导类型和指导内容");
    }
    if (dueDate && !isIsoDate(dueDate)) throw new InputError("完成期限不是有效日期");
    if (sourceProgressEntryId !== null && !Number.isInteger(sourceProgressEntryId)) {
      throw new InputError("关联的飞书总结无效");
    }
    // 日常指导与正式审核分权：被分配到该学生的导师可指导，正式进展判断仍走 can_review。
    if (!(await canViewStudent(auth.user, studentId))) {
      return Response.json({ error: "当前账号无权指导该学生" }, { status: 403 });
    }
    const d1 = getD1();
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1")
      .bind(studentId).first();
    if (!student) return Response.json({ error: "学生不存在或已停用" }, { status: 404 });
    if (sourceProgressEntryId !== null) {
      const source = await d1.prepare(`SELECT p.id FROM progress_entries p
        JOIN feishu_meeting_summary_links l ON l.progress_entry_id = p.id
        WHERE p.id = ? AND p.student_id = ? AND l.student_id = ?`)
        .bind(sourceProgressEntryId, studentId, studentId).first();
      if (!source) throw new InputError("关联的飞书总结不属于该学生");
    }
    const row = await d1.prepare(`INSERT INTO student_guidance_notes
      (student_id, mentor_user_id, source_progress_entry_id, guidance_type,
       title, content, next_action, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(studentId, auth.user.id, sourceProgressEntryId, guidanceType, title, content, nextAction, dueDate || null)
      .first<{ id: number }>();
    if (!row?.id) throw new Error("无法保存导师指导");
    return Response.json({ id: row.id, message: "导师指导已保存到学生档案" }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "导师指导保存失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id);
    const status = clean(body.status, "指导状态", 20);
    if (!Number.isInteger(id) || !guidanceStatuses.has(status)) {
      throw new InputError("导师指导状态参数无效");
    }
    const d1 = getD1();
    const note = await d1.prepare("SELECT id, student_id FROM student_guidance_notes WHERE id = ?")
      .bind(id).first<{ id: number; student_id: string }>();
    if (!note) return Response.json({ error: "导师指导不存在" }, { status: 404 });
    if (!(await canViewStudent(auth.user, note.student_id))) {
      return Response.json({ error: "当前账号无权更新该学生的指导" }, { status: 403 });
    }
    await d1.prepare(`UPDATE student_guidance_notes SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(status, id).run();
    return Response.json({ message: status === "completed" ? "指导事项已完成" : "指导事项已重新打开" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "导师指导更新失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}
