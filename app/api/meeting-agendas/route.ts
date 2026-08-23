import { canViewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";

const statuses = new Set(["draft", "scheduled", "completed", "cancelled"]);
const durations = new Set([5, 10, 15, 20, 30]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

class InputError extends Error {}

function isValidDate(value: string) {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function clean(value: unknown, label: string, maxLength: number, required = false) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new InputError(`请填写${label}`);
  if (text.length > maxLength) throw new InputError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

type AgendaItemInput = {
  studentId?: unknown;
  topic?: unknown;
  reason?: unknown;
  durationMinutes?: unknown;
};

type AgendaRow = {
  id: number;
  mentor_user_id: number;
  mentor_name: string;
  title: string;
  meeting_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type AgendaItemRow = {
  id: number;
  agenda_id: number;
  student_id: string;
  student_name: string;
  topic: string;
  reason: string;
  duration_minutes: number;
  sort_order: number;
  status: string;
  created_at: string;
  updated_at: string;
};

async function readAgendas(userId: number, all: boolean) {
  const d1 = getD1();
  const agendas = all
    ? await d1.prepare(`SELECT a.id, a.mentor_user_id, u.display_name AS mentor_name,
        a.title, a.meeting_date, a.status, a.created_at, a.updated_at
        FROM meeting_agendas a JOIN app_users u ON u.id = a.mentor_user_id
        ORDER BY CASE a.status WHEN 'draft' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
          COALESCE(a.meeting_date, '9999-12-31'), a.updated_at DESC LIMIT 80`).all<AgendaRow>()
    : await d1.prepare(`SELECT a.id, a.mentor_user_id, u.display_name AS mentor_name,
        a.title, a.meeting_date, a.status, a.created_at, a.updated_at
        FROM meeting_agendas a JOIN app_users u ON u.id = a.mentor_user_id
        WHERE a.mentor_user_id = ?
        ORDER BY CASE a.status WHEN 'draft' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
          COALESCE(a.meeting_date, '9999-12-31'), a.updated_at DESC LIMIT 80`)
      .bind(userId).all<AgendaRow>();
  const ids = agendas.results.map((agenda) => Number(agenda.id));
  const items = ids.length
    ? await d1.prepare(`SELECT i.id, i.agenda_id, i.student_id, s.display_name AS student_name,
        i.topic, i.reason, i.duration_minutes, i.sort_order, i.status, i.created_at, i.updated_at
        FROM meeting_agenda_items i JOIN students s ON s.id = i.student_id
        WHERE i.agenda_id IN (${ids.map(() => "?").join(",")})
        ORDER BY i.agenda_id, i.sort_order, i.id`).bind(...ids).all<AgendaItemRow>()
    : { results: [] as AgendaItemRow[] };
  return agendas.results.map((agenda) => ({
    ...agenda,
    items: items.results.filter((item) => Number(item.agenda_id) === Number(agenda.id)),
  }));
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    return Response.json({ agendas: await readAgendas(auth.user.id, auth.user.role === "superadmin") });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "组会议程读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let agendaId: number | null = null;
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = await request.json() as Record<string, unknown>;
    const title = clean(body.title, "议程标题", 160, true);
    const meetingDate = clean(body.meetingDate, "组会日期", 10);
    if (meetingDate && !isValidDate(meetingDate)) throw new InputError("组会日期无效");
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
      throw new InputError("议程需要包含 1 至 20 个讨论项");
    }
    const items = body.items.map((raw, index) => {
      const item = raw as AgendaItemInput;
      const studentId = clean(item.studentId, `第 ${index + 1} 项学生`, 80, true);
      const topic = clean(item.topic, `第 ${index + 1} 项议题`, 300, true);
      const reason = clean(item.reason, `第 ${index + 1} 项原因`, 800);
      const durationMinutes = Number(item.durationMinutes ?? 10);
      if (!durations.has(durationMinutes)) throw new InputError(`第 ${index + 1} 项时长无效`);
      return { studentId, topic, reason, durationMinutes };
    });
    const studentIds = [...new Set(items.map((item) => item.studentId))];
    for (const studentId of studentIds) {
      if (!(await canViewStudent(auth.user, studentId))) {
        return Response.json({ error: "议程包含当前账号无权访问的学生" }, { status: 403 });
      }
    }
    const d1 = getD1();
    const knownStudents = await d1.prepare(`SELECT id FROM students
      WHERE active = 1 AND id IN (${studentIds.map(() => "?").join(",")})`)
      .bind(...studentIds).all<{ id: string }>();
    if (knownStudents.results.length !== studentIds.length) throw new InputError("议程包含不存在或已停用的学生");
    const created = await d1.prepare(`INSERT INTO meeting_agendas
      (mentor_user_id, title, meeting_date, status) VALUES (?, ?, ?, 'draft') RETURNING id`)
      .bind(auth.user.id, title, meetingDate || null).first<{ id: number }>();
    if (!created?.id) throw new Error("无法保存组会议程");
    agendaId = created.id;
    await d1.batch(items.map((item, index) => d1.prepare(`INSERT INTO meeting_agenda_items
      (agenda_id, student_id, topic, reason, duration_minutes, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(created.id, item.studentId, item.topic, item.reason, item.durationMinutes, index)));
    const agendas = await readAgendas(auth.user.id, false);
    return Response.json({ agenda: agendas.find((agenda) => Number(agenda.id) === created.id), message: "组会议程已保存" }, { status: 201 });
  } catch (error) {
    if (agendaId) {
      const d1 = getD1();
      await d1.batch([
        d1.prepare("DELETE FROM meeting_agenda_items WHERE agenda_id = ?").bind(agendaId),
        d1.prepare("DELETE FROM meeting_agendas WHERE id = ?").bind(agendaId),
      ]).catch(() => undefined);
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "组会议程保存失败" },
      { status: error instanceof InputError || error instanceof SyntaxError ? 400 : 500 },
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
    const status = clean(body.status, "议程状态", 20, true);
    const requestedMeetingDate = clean(body.meetingDate, "组会日期", 10);
    const expectedUpdatedAt = clean(body.expectedUpdatedAt, "议程版本", 80, true);
    if (!Number.isInteger(id) || !statuses.has(status)) throw new InputError("议程状态参数无效");
    if (requestedMeetingDate && !isValidDate(requestedMeetingDate)) throw new InputError("组会日期无效");
    const d1 = getD1();
    const existing = auth.user.role === "superadmin"
      ? await d1.prepare("SELECT status, meeting_date FROM meeting_agendas WHERE id = ?").bind(id).first<{ status: string; meeting_date: string | null }>()
      : await d1.prepare("SELECT status, meeting_date FROM meeting_agendas WHERE id = ? AND mentor_user_id = ?")
        .bind(id, auth.user.id).first<{ status: string; meeting_date: string | null }>();
    if (!existing) return Response.json({ error: "议程不存在或当前账号无权修改" }, { status: 404 });
    const allowedTransitions: Record<string, string[]> = {
      draft: ["scheduled", "cancelled"],
      scheduled: ["completed", "cancelled"],
      completed: [],
      cancelled: [],
    };
    if (!allowedTransitions[existing.status]?.includes(status)) {
      return Response.json({ error: "当前状态不能执行该议程操作" }, { status: 409 });
    }
    const meetingDate = requestedMeetingDate || existing.meeting_date;
    if (status === "scheduled" && !meetingDate) throw new InputError("确认排期前请先选择组会日期");
    const ownerGuard = auth.user.role === "superadmin" ? "" : "AND mentor_user_id = ?";
    const statement = d1.prepare(`UPDATE meeting_agendas SET status = ?, meeting_date = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND updated_at = ? AND status = ? ${ownerGuard}
      RETURNING id, status, updated_at`);
    const bindings: Array<string | number | null> = [status, meetingDate, id, expectedUpdatedAt, existing.status];
    if (auth.user.role !== "superadmin") bindings.push(auth.user.id);
    const updated = await statement.bind(...bindings).first();
    if (!updated) return Response.json({ error: "议程已被更新或当前账号无权修改" }, { status: 409 });
    return Response.json({ agenda: updated, message: "议程状态已更新" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "议程更新失败" },
      { status: error instanceof InputError || error instanceof SyntaxError ? 400 : 500 },
    );
  }
}
