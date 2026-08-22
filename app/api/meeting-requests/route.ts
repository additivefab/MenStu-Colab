import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser, type AppUser } from "../../../lib/feishu-auth";

const durations = new Set([15, 30, 45, 60]);
const actions = new Set(["confirm", "decline", "cancel"]);
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

class InputError extends Error {}

type MeetingRequestRow = {
  id: number;
  student_id: string;
  student_name: string;
  preferred_date: string;
  preferred_time: string;
  duration_minutes: number;
  topic: string;
  note: string;
  status: "requested" | "confirmed" | "declined" | "cancelled";
  response_note: string;
  requested_by_user_id: number;
  requested_by_name: string;
  handled_by_user_id: number | null;
  handled_by_name: string | null;
  handled_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type ExistingRequest = Pick<
  MeetingRequestRow,
  | "id"
  | "student_id"
  | "requested_by_user_id"
  | "preferred_date"
  | "preferred_time"
  | "status"
  | "version"
>;

function textField(
  value: unknown,
  label: string,
  maxLength: number,
  required = false,
) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new InputError(`${label}格式无效`);
  const cleaned = value.trim();
  if (required && !cleaned) throw new InputError(`请填写${label}`);
  if (cleaned.length > maxLength) {
    throw new InputError(`${label}不能超过 ${maxLength} 个字符`);
  }
  return cleaned;
}

function scheduleTime(preferredDate: unknown, preferredTime: unknown) {
  const date = textField(preferredDate, "希望日期", 10, true);
  const time = textField(preferredTime, "希望时间", 5, true);
  const dateMatch = datePattern.exec(date);
  const timeMatch = timePattern.exec(time);
  if (!dateMatch || !timeMatch) {
    throw new InputError("希望日期或时间格式无效");
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new InputError("希望日期无效");
  }

  // 项目按 Asia/Shanghai 解释学生输入的本地时间；中国时区全年固定为 UTC+08:00。
  const timestamp = Date.parse(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(timestamp)) throw new InputError("希望日期或时间无效");
  return { date, time, timestamp, hour, minute };
}

function requireFutureSchedule(preferredDate: unknown, preferredTime: unknown) {
  const schedule = scheduleTime(preferredDate, preferredTime);
  if (schedule.timestamp <= Date.now()) throw new InputError("预约时间必须晚于当前时间");
  if (schedule.timestamp > Date.now() + 180 * 86_400_000) throw new InputError("预约时间不能超过未来 180 天");
  return schedule;
}

function positiveInteger(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new InputError(`${label}无效`);
  return number;
}

const selectFields = `SELECT
  m.id, m.student_id, s.display_name AS student_name,
  m.preferred_date, m.preferred_time, m.duration_minutes,
  m.topic, m.note, m.status, m.response_note,
  m.requested_by_user_id, requester.display_name AS requested_by_name,
  m.handled_by_user_id, handler.display_name AS handled_by_name, m.handled_at,
  m.version, m.created_at, m.updated_at
  FROM meeting_requests m
  JOIN students s ON s.id = m.student_id
  JOIN app_users requester ON requester.id = m.requested_by_user_id
  LEFT JOIN app_users handler ON handler.id = m.handled_by_user_id`;

const listOrder = `ORDER BY
  CASE m.status WHEN 'requested' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
  m.preferred_date ASC, m.preferred_time ASC, m.created_at DESC`;

async function listRequests(user: AppUser) {
  const d1 = getD1();
  if (user.role === "student") {
    if (!user.studentId) return [];
    const { results } = await d1.prepare(`${selectFields}
      WHERE m.student_id = ? AND m.requested_by_user_id = ?
      ${listOrder}`)
      .bind(user.studentId, user.id)
      .all<MeetingRequestRow>();
    return results;
  }
  if (user.role === "admin") {
    const { results } = await d1.prepare(`${selectFields}
      WHERE EXISTS (
        SELECT 1 FROM mentor_student_assignments assignment
        WHERE assignment.mentor_user_id = ?
          AND assignment.student_id = m.student_id
          AND assignment.active = 1 AND assignment.can_review = 1
      )
      ${listOrder}`)
      .bind(user.id)
      .all<MeetingRequestRow>();
    return results;
  }
  const { results } = await d1.prepare(`${selectFields} ${listOrder}`).all<MeetingRequestRow>();
  return results;
}

async function scopedRequest(user: AppUser, id: number) {
  const d1 = getD1();
  const fields = `SELECT id, student_id, requested_by_user_id, preferred_date,
    preferred_time, status, version FROM meeting_requests m`;
  if (user.role === "student") {
    if (!user.studentId) return null;
    return d1.prepare(`${fields}
      WHERE id = ? AND student_id = ? AND requested_by_user_id = ?`)
      .bind(id, user.studentId, user.id)
      .first<ExistingRequest>();
  }
  if (user.role === "admin") {
    return d1.prepare(`${fields}
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM mentor_student_assignments assignment
        WHERE assignment.mentor_user_id = ?
          AND assignment.student_id = m.student_id
          AND assignment.active = 1 AND assignment.can_review = 1
      )`)
      .bind(id, user.id)
      .first<ExistingRequest>();
  }
  return d1.prepare(`${fields} WHERE id = ?`).bind(id).first<ExistingRequest>();
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    return Response.json({ requests: await listRequests(auth.user) });
  } catch (error) {
    console.error("Failed to list meeting requests", error);
    return Response.json({ error: "读取预约失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) {
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    }
    const auth = await requireAppUser(request, ["student"]);
    if ("response" in auth) return auth.response;
    if (!auth.user.studentId) {
      return Response.json({ error: "学生账号尚未绑定学生档案" }, { status: 403 });
    }
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const requestedStudentId = body.studentId ?? body.student_id;
    if (requestedStudentId !== undefined && requestedStudentId !== auth.user.studentId) {
      return Response.json({ error: "学生账号只能为自己预约会议" }, { status: 403 });
    }
    const schedule = requireFutureSchedule(body.preferredDate, body.preferredTime);
    const durationMinutes = Number(body.durationMinutes);
    if (!durations.has(durationMinutes)) {
      throw new InputError("会议时长只能选择 15、30、45 或 60 分钟");
    }
    const topic = textField(body.topic, "会议议题", 200, true);
    const note = textField(body.note, "备注", 2_000);
    const d1 = getD1();
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1")
      .bind(auth.user.studentId)
      .first();
    if (!student) {
      return Response.json({ error: "绑定的学生档案不存在或已停用" }, { status: 409 });
    }
    const [duplicate, activeCount] = await Promise.all([
      d1.prepare(`SELECT id FROM meeting_requests
        WHERE student_id = ? AND preferred_date = ? AND preferred_time = ?
          AND status IN ('requested', 'confirmed') LIMIT 1`)
        .bind(auth.user.studentId, schedule.date, schedule.time).first(),
      d1.prepare(`SELECT COUNT(*) AS count FROM meeting_requests
        WHERE student_id = ? AND status IN ('requested', 'confirmed')`)
        .bind(auth.user.studentId).first<{ count: number }>(),
    ]);
    if (duplicate) return Response.json({ error: "同一时间已有待处理或已确认的预约" }, { status: 409 });
    if (Number(activeCount?.count ?? 0) >= 5) {
      return Response.json({ error: "当前已有 5 条有效预约，请先处理或取消后再提交" }, { status: 409 });
    }
    const created = await d1.prepare(`INSERT INTO meeting_requests
      (student_id, requested_by_user_id, preferred_date, preferred_time,
       duration_minutes, topic, note, status, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', 1)
      RETURNING id, student_id, preferred_date, preferred_time, duration_minutes,
        topic, note, status, response_note, version, created_at, updated_at`)
      .bind(
        auth.user.studentId,
        auth.user.id,
        schedule.date,
        schedule.time,
        durationMinutes,
        topic,
        note,
      )
      .first();
    if (!created) throw new Error("Meeting request insert returned no row");
    return Response.json({ request: created, message: "会议预约已提交" }, { status: 201 });
  } catch (error) {
    if (error instanceof InputError || error instanceof SyntaxError) {
      return Response.json(
        { error: error instanceof InputError ? error.message : "请求内容不是有效 JSON" },
        { status: 400 },
      );
    }
    console.error("Failed to create meeting request", error);
    return Response.json({ error: "提交会议预约失败" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    if (!assertSameOrigin(request)) {
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    }
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const id = positiveInteger(body.id, "预约编号");
    const expectedVersion = positiveInteger(body.expectedVersion, "预约版本");
    const action = textField(body.action, "操作", 20, true);
    if (!actions.has(action)) throw new InputError("预约操作无效");
    const responseNote = textField(body.responseNote, "回复意见", 2_000);
    if (action === "decline" && !responseNote) {
      throw new InputError("拒绝预约时必须填写回复意见");
    }

    const existing = await scopedRequest(auth.user, id);
    if (!existing) {
      return Response.json({ error: "预约不存在或无权访问" }, { status: 404 });
    }
    if (existing.version !== expectedVersion) {
      return Response.json({ error: "预约已被更新，请刷新后重试" }, { status: 409 });
    }

    const isStudent = auth.user.role === "student";
    if (isStudent) {
      if (action !== "cancel") {
        return Response.json({ error: "学生账号只能取消自己的预约" }, { status: 403 });
      }
      if (existing.status !== "requested" && existing.status !== "confirmed") {
        return Response.json({ error: "当前状态的预约不能取消" }, { status: 409 });
      }
    } else {
      if (action !== "confirm" && action !== "decline") {
        return Response.json({ error: "管理员账号只能确认或拒绝预约" }, { status: 403 });
      }
      if (existing.status !== "requested") {
        return Response.json({ error: "只有待处理预约可以确认或拒绝" }, { status: 409 });
      }
      if (action === "confirm") {
        requireFutureSchedule(existing.preferred_date, existing.preferred_time);
      }
    }

    const nextStatus = action === "confirm" ? "confirmed" : action === "decline" ? "declined" : "cancelled";
    const nextNote = action === "cancel" ? (responseNote || "学生取消预约") : responseNote;
    const d1 = getD1();
    const permissionGuard = auth.user.role === "admin"
      ? `AND EXISTS (
          SELECT 1 FROM mentor_student_assignments assignment
          WHERE assignment.mentor_user_id = ?
            AND assignment.student_id = meeting_requests.student_id
            AND assignment.active = 1 AND assignment.can_review = 1
        )`
      : auth.user.role === "student"
        ? "AND student_id = ? AND requested_by_user_id = ?"
        : "";
    const statement = d1.prepare(`UPDATE meeting_requests SET
      status = ?, response_note = ?, handled_by_user_id = ?,
      handled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1
      WHERE id = ? AND version = ? AND status = ? ${permissionGuard}
      RETURNING id, status, response_note, handled_by_user_id, handled_at, updated_at, version`);
    const values: Array<string | number> = [
      nextStatus,
      nextNote,
      auth.user.id,
      id,
      expectedVersion,
      existing.status,
    ];
    if (auth.user.role === "admin") values.push(auth.user.id);
    if (auth.user.role === "student") values.push(auth.user.studentId!, auth.user.id);
    const updated = await statement.bind(...values).first();
    if (!updated) {
      return Response.json({ error: "预约状态或权限已变化，请刷新后重试" }, { status: 409 });
    }
    const message = action === "confirm" ? "预约已确认" : action === "decline" ? "预约已拒绝" : "预约已取消";
    return Response.json({ request: updated, message });
  } catch (error) {
    if (error instanceof InputError || error instanceof SyntaxError) {
      return Response.json(
        { error: error instanceof InputError ? error.message : "请求内容不是有效 JSON" },
        { status: 400 },
      );
    }
    console.error("Failed to update meeting request", error);
    return Response.json({ error: "更新会议预约失败" }, { status: 500 });
  }
}
