import { canViewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { validateHttpsUrl } from "../../../lib/progress-evidence";

const outputTypes = new Set(["paper", "dataset", "software", "patent", "report", "presentation", "other"]);
const lifecycleStatuses = new Set(["planned", "in_progress", "submitted", "accepted", "published", "archived"]);

class InputError extends Error {}

function clean(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new InputError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function outputInput(body: Record<string, unknown>) {
  const studentId = clean(body.studentId, "学生", 80);
  const outputType = clean(body.outputType, "成果类型", 40);
  const title = clean(body.title, "成果名称", 300);
  const lifecycleStatus = clean(body.lifecycleStatus, "成果阶段", 40) || "planned";
  const venue = clean(body.venue, "期刊、会议或发布位置", 300);
  const identifier = clean(body.identifier, "标识符", 500)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "");
  const summary = clean(body.summary, "成果说明", 4000);
  const rawUrl = clean(body.url, "成果链接", 2048);
  let url = "";
  try { url = validateHttpsUrl(rawUrl, "成果链接"); }
  catch (error) { throw new InputError(error instanceof Error ? error.message : "成果链接无效"); }
  const linkedMilestoneId = body.linkedMilestoneId ? Number(body.linkedMilestoneId) : null;
  if (!studentId || !outputTypes.has(outputType) || !title || !lifecycleStatuses.has(lifecycleStatus)) {
    throw new InputError("请完整填写学生、成果类型、名称和当前阶段");
  }
  if (linkedMilestoneId !== null && !Number.isInteger(linkedMilestoneId)) {
    throw new InputError("关联培养节点无效");
  }
  return { studentId, outputType, title, lifecycleStatus, venue, identifier, url, summary, linkedMilestoneId };
}

async function readOutputs(studentId: string) {
  const d1 = getD1();
  const outputs = await d1.prepare(`SELECT ro.*, m.title AS milestone_title,
    u.display_name AS created_by_name
    FROM research_outputs ro
    LEFT JOIN research_milestones m ON m.id = ro.linked_milestone_id
    JOIN app_users u ON u.id = ro.created_by_user_id
    WHERE ro.student_id = ? ORDER BY ro.updated_at DESC, ro.id DESC`)
    .bind(studentId).all();
  const ids = outputs.results.map((item) => Number((item as { id: number }).id));
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const events = await d1.prepare(`SELECT e.id, e.output_id, e.action, e.detail, e.created_at,
    u.display_name AS actor_name
    FROM research_output_events e JOIN app_users u ON u.id = e.actor_user_id
    WHERE e.output_id IN (${placeholders}) ORDER BY e.created_at DESC, e.id DESC`)
    .bind(...ids).all<{ id: number; output_id: number; action: string; detail: string; created_at: string; actor_name: string }>();
  return outputs.results.map((output) => ({
    ...output,
    events: events.results.filter((event) => event.output_id === Number((output as { id: number }).id)).slice(0, 8),
  }));
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "mentor"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const studentId = new URL(request.url).searchParams.get("studentId")?.trim() ?? "";
    if (!studentId) return Response.json({ error: "缺少学生参数" }, { status: 400 });
    if (!(await canViewStudent(auth.user, studentId))) {
      return Response.json({ error: "无权查看该学生的科研成果" }, { status: 403 });
    }
    return Response.json({ outputs: await readOutputs(studentId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "科研成果读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const values = outputInput(await request.json() as Record<string, unknown>);
    if (auth.user.role === "student" && auth.user.studentId !== values.studentId) {
      return Response.json({ error: "学生只能登记自己的科研成果" }, { status: 403 });
    }
    const d1 = getD1();
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1")
      .bind(values.studentId).first();
    if (!student) return Response.json({ error: "学生不存在或已停用" }, { status: 404 });
    if (values.linkedMilestoneId) {
      const milestone = await d1.prepare(`SELECT m.id FROM research_milestones m
        JOIN research_proposals rp ON rp.id = m.proposal_id
        WHERE m.id = ? AND rp.student_id = ?`).bind(values.linkedMilestoneId, values.studentId).first();
      if (!milestone) return Response.json({ error: "培养节点不属于该学生" }, { status: 400 });
    }
    if (values.identifier) {
      const duplicate = await d1.prepare(`SELECT id FROM research_outputs
        WHERE student_id = ? AND lower(identifier) = lower(?)`).bind(values.studentId, values.identifier).first();
      if (duplicate) return Response.json({ error: "该标识符已经登记" }, { status: 409 });
    }
    const row = await d1.prepare(`INSERT INTO research_outputs
      (student_id, output_type, title, lifecycle_status, venue, identifier, url, summary,
       linked_milestone_id, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(
        values.studentId, values.outputType, values.title, values.lifecycleStatus,
        values.venue, values.identifier, values.url, values.summary,
        values.linkedMilestoneId, auth.user.id,
      ).first<{ id: number }>();
    if (!row?.id) throw new Error("无法建立科研成果记录");
    await d1.prepare(`INSERT INTO research_output_events
      (output_id, actor_user_id, action, detail, snapshot_json)
      VALUES (?, ?, 'create', '登记科研成果', ?)`)
      .bind(row.id, auth.user.id, JSON.stringify(values)).run();
    return Response.json({ id: row.id, message: "科研成果已登记，并保留创建记录" }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "科研成果保存失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id);
    if (!Number.isInteger(id)) return Response.json({ error: "科研成果参数无效" }, { status: 400 });
    const d1 = getD1();
    const existing = await d1.prepare("SELECT id, student_id FROM research_outputs WHERE id = ?")
      .bind(id).first<{ id: number; student_id: string }>();
    if (!existing) return Response.json({ error: "科研成果不存在" }, { status: 404 });
    if (!(await canViewStudent(auth.user, existing.student_id))) {
      return Response.json({ error: "无权修改该学生的科研成果" }, { status: 403 });
    }
    const values = outputInput({ ...body, studentId: existing.student_id });
    if (values.linkedMilestoneId) {
      const milestone = await d1.prepare(`SELECT m.id FROM research_milestones m
        JOIN research_proposals rp ON rp.id = m.proposal_id
        WHERE m.id = ? AND rp.student_id = ?`).bind(values.linkedMilestoneId, existing.student_id).first();
      if (!milestone) return Response.json({ error: "培养节点不属于该学生" }, { status: 400 });
    }
    if (values.identifier) {
      const duplicate = await d1.prepare(`SELECT id FROM research_outputs
        WHERE student_id = ? AND lower(identifier) = lower(?) AND id != ?`)
        .bind(existing.student_id, values.identifier, id).first();
      if (duplicate) return Response.json({ error: "该标识符已经登记" }, { status: 409 });
    }
    await d1.batch([
      d1.prepare(`UPDATE research_outputs SET output_type = ?, title = ?, lifecycle_status = ?,
        venue = ?, identifier = ?, url = ?, summary = ?, linked_milestone_id = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(
          values.outputType, values.title, values.lifecycleStatus, values.venue,
          values.identifier, values.url, values.summary, values.linkedMilestoneId, id,
        ),
      d1.prepare(`INSERT INTO research_output_events
        (output_id, actor_user_id, action, detail, snapshot_json)
        VALUES (?, ?, 'update', '更新成果阶段或证据', ?)`)
        .bind(id, auth.user.id, JSON.stringify(values)),
    ]);
    return Response.json({ message: "科研成果已更新，并保留变更记录" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "科研成果更新失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}
