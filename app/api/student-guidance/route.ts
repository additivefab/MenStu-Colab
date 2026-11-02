import { canReviewStudent, canViewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { isIsoDate } from "../../../lib/paper-progress";

const guidanceTypes = new Set(["meeting_followup", "paper", "milestone", "blocker", "general"]);
const guidanceActions = new Set(["acknowledge", "complete", "reopen"]);
const verificationModes = new Set(["self_report", "mentor_verify"]);

class InputError extends Error {}

function guidanceConflictResponse() {
  return Response.json(
    { error: "指导已在其他页面更新，请刷新后重试；当前填写内容仍保留" },
    { status: 409 },
  );
}

function clean(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new InputError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

async function readGuidanceNotes(studentId: string) {
  const d1 = getD1();
  try {
    return await d1.prepare(`SELECT n.id, n.student_id, n.source_progress_entry_id, rol.research_output_id, n.guidance_type, n.title,
      n.content, n.next_action, n.due_date, n.status, n.created_at, n.updated_at,
      n.acceptance_criteria, n.verification_mode, n.acknowledged_at,
      n.student_reported_at, n.mentor_verified_at, n.completed_at, n.completion_note,
      n.version,
      u.display_name AS mentor_name, completed_by.display_name AS completed_by_name,
      p.title AS source_title, p.kind AS source_kind,
      ro.title AS research_output_title, ro.output_type AS research_output_type
      FROM student_guidance_notes n
      JOIN app_users u ON u.id = n.mentor_user_id
      LEFT JOIN app_users completed_by ON completed_by.id = n.completed_by_user_id
      LEFT JOIN progress_entries p ON p.id = n.source_progress_entry_id AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)
      LEFT JOIN research_output_guidance_links rol ON rol.guidance_note_id = n.id
      LEFT JOIN research_outputs ro ON ro.id = rol.research_output_id
      WHERE n.student_id = ?
      ORDER BY CASE n.status WHEN 'open' THEN 0 ELSE 1 END, n.created_at DESC, n.id DESC
      LIMIT 200`).bind(studentId).all();
  } catch (error) {
    if (!/research_output_guidance_links|research_output_id|no such table|no such column/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return d1.prepare(`SELECT n.id, n.student_id, n.source_progress_entry_id, n.guidance_type, n.title,
      n.content, n.next_action, n.due_date, n.status, n.created_at, n.updated_at,
      n.acceptance_criteria, n.verification_mode, n.acknowledged_at,
      n.student_reported_at, n.mentor_verified_at, n.completed_at, n.completion_note,
      n.version,
      u.display_name AS mentor_name, completed_by.display_name AS completed_by_name,
      p.title AS source_title, p.kind AS source_kind
      FROM student_guidance_notes n
      JOIN app_users u ON u.id = n.mentor_user_id
      LEFT JOIN app_users completed_by ON completed_by.id = n.completed_by_user_id
      LEFT JOIN progress_entries p ON p.id = n.source_progress_entry_id AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)
      WHERE n.student_id = ?
      ORDER BY CASE n.status WHEN 'open' THEN 0 ELSE 1 END, n.created_at DESC, n.id DESC
      LIMIT 200`).bind(studentId).all();
  }
}

async function readStudentWorkspace(studentId: string) {
  const d1 = getD1();
  const [notes, meetingSummaries] = await Promise.all([
    readGuidanceNotes(studentId),
    d1.prepare(`SELECT l.id AS link_id, i.id AS import_id, l.progress_entry_id,
      p.title, p.summary, p.evidence, p.current_revision, p.review_status, p.assessment, p.reviewer_note,
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
      WHERE l.student_id = ? AND i.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)
      ORDER BY i.message_created_at DESC, l.id DESC
      LIMIT 200`).bind(studentId).all(),
  ]);
  const noteIds = notes.results.map((item) => Number((item as { id: number }).id));
  const events = noteIds.length
    ? await d1.prepare(`SELECT e.id, e.guidance_note_id, e.actor_type, e.action, e.note,
        e.created_at, u.display_name AS actor_name
        FROM student_guidance_events e LEFT JOIN app_users u ON u.id = e.actor_user_id
        WHERE e.guidance_note_id IN (${noteIds.map(() => "?").join(",")})
        ORDER BY e.created_at DESC, e.id DESC`).bind(...noteIds).all()
    : { results: [] };
  return {
    notes: notes.results.map((item) => ({
      ...item,
      events: events.results.filter((event) => (
        event as { guidance_note_id: number }
      ).guidance_note_id === (item as { id: number }).id),
    })),
    meetingSummaries: meetingSummaries.results,
  };
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const requestedStudentId = new URL(request.url).searchParams.get("studentId")?.trim() ?? "";
    const studentId = auth.user.role === "student" ? auth.user.studentId ?? "" : requestedStudentId;
    if (!studentId) return Response.json({ error: "缺少学生参数" }, { status: 400 });
    if (auth.user.role === "student" && requestedStudentId && requestedStudentId !== studentId) {
      return Response.json({ error: "学生账号只能读取本人的导师指导" }, { status: 403 });
    }
    if (!(await canViewStudent(auth.user, studentId))) {
      return Response.json({ error: "无权查看该学生的指导与飞书总结" }, { status: 403 });
    }
    return Response.json({ ...await readStudentWorkspace(studentId),
      canManageAiRecords: await canReviewStudent(auth.user, studentId),
    }, {
      headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
    });
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
    const acceptanceCriteria = clean(body.acceptanceCriteria, "验收标准", 1200);
    const verificationMode = clean(body.verificationMode, "验收方式", 30) || "self_report";
    const sourceProgressEntryId = body.sourceProgressEntryId === undefined || body.sourceProgressEntryId === null || body.sourceProgressEntryId === ""
      ? null : Number(body.sourceProgressEntryId);
    const researchOutputId = body.researchOutputId === undefined || body.researchOutputId === null || body.researchOutputId === ""
      ? null : Number(body.researchOutputId);
    if (!studentId || !guidanceTypes.has(guidanceType) || !content) {
      throw new InputError("请完整填写学生、指导类型和指导内容");
    }
    if (!verificationModes.has(verificationMode)) throw new InputError("验收方式无效");
    if (verificationMode === "mentor_verify" && nextAction && !acceptanceCriteria) {
      throw new InputError("需要导师验收时，请填写可判断的验收标准");
    }
    if (dueDate && !isIsoDate(dueDate)) throw new InputError("完成期限不是有效日期");
    if (sourceProgressEntryId !== null && (!Number.isSafeInteger(sourceProgressEntryId) || sourceProgressEntryId < 1)) {
      throw new InputError("关联的进展记录无效");
    }
    if (researchOutputId !== null && (!Number.isSafeInteger(researchOutputId) || researchOutputId < 1)) {
      throw new InputError("关联的科研成果无效");
    }
    // 日常指导与正式审核分权：被分配到该学生的导师可指导，正式进展判断仍走 can_review。
    if (!(await canViewStudent(auth.user, studentId))) {
      return Response.json({ error: "当前账号无权指导该学生" }, { status: 403 });
    }
    if (auth.user.studentId === studentId) {
      return Response.json({ error: "不能以导师身份给本人学生档案下达指导，请切换到学生端操作本人事项" }, { status: 403 });
    }
    const d1 = getD1();
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1")
      .bind(studentId).first();
    if (!student) return Response.json({ error: "学生不存在或已停用" }, { status: 404 });
    if (sourceProgressEntryId !== null) {
      const source = await d1.prepare(`SELECT p.id FROM progress_entries p
        WHERE p.id = ? AND p.student_id = ?
          AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)
          AND (p.review_status = 'accepted' OR EXISTS (
            SELECT 1 FROM feishu_meeting_summary_links l
            WHERE l.progress_entry_id = p.id AND l.student_id = p.student_id
          ))`)
        .bind(sourceProgressEntryId, studentId).first();
      if (!source) throw new InputError("关联的进展记录不属于该学生、已删除或尚未通过审核");
    }
    if (researchOutputId !== null) {
      const output = await d1.prepare(`SELECT id FROM research_outputs WHERE id = ? AND student_id = ?`)
        .bind(researchOutputId, studentId).first();
      if (!output) throw new InputError("关联的科研成果不属于该学生或不存在");
    }
    let createdId: number | null = null;
    try {
      const row = await d1.prepare(`INSERT INTO student_guidance_notes
        (student_id, mentor_user_id, source_progress_entry_id, guidance_type,
         title, content, next_action, due_date, acceptance_criteria, verification_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .bind(
          studentId,
          auth.user.id,
          sourceProgressEntryId,
          guidanceType,
          title,
          content,
          nextAction,
          dueDate || null,
          acceptanceCriteria,
          verificationMode,
        )
        .first<{ id: number }>();
      if (!row?.id) throw new Error("无法保存导师指导");
      createdId = row.id;
      if (researchOutputId !== null) {
        await d1.prepare(`INSERT INTO research_output_guidance_links (guidance_note_id, research_output_id)
          VALUES (?, ?)`).bind(row.id, researchOutputId).run();
      }
      await d1.prepare(`INSERT INTO student_guidance_events
        (guidance_note_id, actor_user_id, actor_type, action, note)
        VALUES (?, ?, 'staff', 'created', ?)`).bind(row.id, auth.user.id, title || content.slice(0, 120)).run();
    } catch (error) {
      if (createdId) {
        await d1.prepare("DELETE FROM research_output_guidance_links WHERE guidance_note_id = ?").bind(createdId).run().catch(() => undefined);
        await d1.prepare("DELETE FROM student_guidance_notes WHERE id = ?").bind(createdId).run().catch(() => undefined);
      }
      throw error;
    }
    return Response.json({ id: createdId, message: "导师指导已保存到学生档案" }, { status: 201 });
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
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id);
    const legacyStatus = clean(body.status, "指导状态", 20);
    const action = clean(
      body.action ?? (legacyStatus === "completed" ? "complete" : legacyStatus === "open" ? "reopen" : ""),
      "指导操作",
      20,
    );
    const completionNote = clean(body.completionNote, "完成说明", 1000);
    const expectedVersion = Number(body.expectedVersion);
    if (!Number.isInteger(id) || !guidanceActions.has(action)) {
      throw new InputError("导师指导状态参数无效");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new InputError("缺少有效的指导版本，请刷新后重试");
    }
    const d1 = getD1();
    const note = await d1.prepare(`SELECT id, student_id, mentor_user_id, status, acknowledged_at,
      verification_mode, student_reported_at, mentor_verified_at, completion_note, version
      FROM student_guidance_notes WHERE id = ?`)
      .bind(id).first<{
        id: number;
        student_id: string;
        mentor_user_id: number;
        status: "open" | "completed";
        acknowledged_at: string | null;
        verification_mode: "self_report" | "mentor_verify";
        student_reported_at: string | null;
        mentor_verified_at: string | null;
        completion_note: string;
        version: number;
      }>();
    if (!note) return Response.json({ error: "导师指导不存在" }, { status: 404 });
    if (!(await canViewStudent(auth.user, note.student_id))) {
      return Response.json({ error: "当前账号无权更新该学生的指导" }, { status: 403 });
    }
    const isStudent = auth.user.role === "student";
    if (isStudent && auth.user.studentId !== note.student_id) {
      return Response.json({ error: "学生账号只能更新本人的导师指导" }, { status: 403 });
    }
    if (!isStudent && auth.user.studentId === note.student_id) {
      return Response.json({ error: "不能以导师身份处理本人学生档案的指导" }, { status: 403 });
    }
    if (isStudent && action === "reopen") {
      return Response.json({ error: "学生不能重新打开已完成的导师指导" }, { status: 403 });
    }
    if (!isStudent && action === "acknowledge") {
      return Response.json({ error: "只有学生本人可以确认收到导师指导" }, { status: 403 });
    }
    if (!isStudent && (action === "complete" || action === "reopen")
      && note.mentor_user_id !== auth.user.id && !(await canReviewStudent(auth.user, note.student_id))) {
      return Response.json({ error: "只有创建这条指导的导师或有审核权的导师可以变更状态" }, { status: 403 });
    }
    if (!isStudent && action === "complete" && note.verification_mode === "mentor_verify") {
      if (!note.student_reported_at) {
        return Response.json({ error: "学生尚未提交完成说明，当前不能进行导师验收" }, { status: 409 });
      }
    }
    const actorType = isStudent ? "student" : "staff";
    if (note.version !== expectedVersion) {
      return guidanceConflictResponse();
    }

    if (action === "acknowledge") {
      const [updated] = await d1.batch([
        d1.prepare(`UPDATE student_guidance_notes SET acknowledged_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP, version = version + 1
          WHERE id = ? AND acknowledged_at IS NULL AND version = ?`).bind(id, expectedVersion),
        d1.prepare(`INSERT INTO student_guidance_events
          (guidance_note_id, actor_user_id, actor_type, action, note)
          SELECT ?, ?, ?, 'acknowledged', '' WHERE changes() > 0`).bind(id, auth.user.id, actorType),
      ]);
      if (!updated.meta.changes) return guidanceConflictResponse();
      return Response.json({
        message: "已向导师确认收到这条指导",
        version: expectedVersion + 1,
      });
    }

    if (action === "complete") {
      if (isStudent && note.verification_mode === "mentor_verify") {
        if (!completionNote) throw new InputError("请填写完成说明，导师将按验收标准确认");
        const [updated] = await d1.batch([
          d1.prepare(`UPDATE student_guidance_notes SET
            acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
            student_reported_at = CURRENT_TIMESTAMP, completion_note = ?,
            updated_at = CURRENT_TIMESTAMP, version = version + 1
            WHERE id = ? AND status = 'open' AND version = ?`)
            .bind(completionNote, id, expectedVersion),
          d1.prepare(`INSERT INTO student_guidance_events
            (guidance_note_id, actor_user_id, actor_type, action, note)
            SELECT ?, ?, 'student', 'completed', ? WHERE changes() > 0`)
            .bind(id, auth.user.id, `学生提交完成说明：${completionNote}`),
        ]);
        if (!updated.meta.changes) return guidanceConflictResponse();
        return Response.json({
          message: "完成说明已提交，等待导师验收",
          awaitingMentorVerification: true,
          version: expectedVersion + 1,
        });
      }
      const [updated] = await d1.batch([
        d1.prepare(`UPDATE student_guidance_notes SET status = 'completed',
          acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
          completed_at = CURRENT_TIMESTAMP, completed_by_user_id = ?,
          completion_note = CASE WHEN ? = '' THEN completion_note ELSE ? END,
          mentor_verified_at = CASE WHEN ? = 'staff' THEN CURRENT_TIMESTAMP ELSE mentor_verified_at END,
          updated_at = CURRENT_TIMESTAMP, version = version + 1
          WHERE id = ? AND status = 'open' AND version = ?
            AND (? = 0 OR student_reported_at IS NOT NULL)`)
          .bind(auth.user.id, completionNote, completionNote, actorType, id, expectedVersion,
            !isStudent && note.verification_mode === "mentor_verify" ? 1 : 0),
        d1.prepare(`INSERT INTO student_guidance_events
          (guidance_note_id, actor_user_id, actor_type, action, note)
          SELECT ?, ?, ?, 'completed', ? WHERE changes() > 0`)
          .bind(id, auth.user.id, actorType, completionNote),
      ]);
      if (!updated.meta.changes) return guidanceConflictResponse();
      return Response.json({
        message: isStudent ? "指导事项已完成，导师可以看到完成记录" : "已完成导师验收",
        version: expectedVersion + 1,
      });
    }

    const [updated] = await d1.batch([
      d1.prepare(`UPDATE student_guidance_notes SET status = 'open', completed_at = NULL,
        completed_by_user_id = NULL, completion_note = '', student_reported_at = NULL,
        mentor_verified_at = NULL, updated_at = CURRENT_TIMESTAMP, version = version + 1
        WHERE id = ? AND (status = 'completed' OR student_reported_at IS NOT NULL)
          AND version = ?`).bind(id, expectedVersion),
      d1.prepare(`INSERT INTO student_guidance_events
        (guidance_note_id, actor_user_id, actor_type, action, note)
        SELECT ?, ?, 'staff', 'reopened', '' WHERE changes() > 0`).bind(id, auth.user.id),
    ]);
    if (!updated.meta.changes) return guidanceConflictResponse();
    return Response.json({
      message: "指导事项已重新打开",
      version: expectedVersion + 1,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "导师指导更新失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}
