import { confirmedRoster } from "../../../../lib/confirmed-roster";
import { ensureDatabase, getD1 } from "../../../../lib/database";
import { isValidFeishuContact, normalizeFeishuContact, type FeishuContactIdentifier } from "../../../../lib/feishu-contact";
import { resolveFeishuOpenIds } from "../../../../lib/feishu-directory";
import { assertSameOrigin, requireAppUser } from "../../../../lib/feishu-auth";
import {
  areStudentIdentityBindingsExact,
  type ExpectedStudentIdentityBinding,
  type StoredStudentIdentityBinding,
} from "../../../../lib/student-identity-binding";

type ContactInput = {
  studentId?: unknown;
  kind?: unknown;
  value?: unknown;
};

type ExistingUser = {
  id: number;
  feishu_open_id: string;
  role: string;
  student_id: string | null;
  active: number;
};

type PreparedBinding = ExpectedStudentIdentityBinding & {
  contactKind: "email" | "mobile" | "existing_login";
};

function contactKey(contact: FeishuContactIdentifier) {
  return `${contact.kind}:${contact.value}`;
}

function verifiedResponse() {
  return Response.json({
    message: "26 名学生的飞书身份已全部预核验；首次登录将自动进入本人学生页面",
    verified_count: confirmedRoster.length,
  });
}

async function readStoredBindings(d1: ReturnType<typeof getD1>) {
  return d1.prepare(`SELECT student_id, feishu_open_id, active
    FROM student_feishu_identity_bindings ORDER BY student_id`)
    .all<StoredStudentIdentityBinding>();
}

export async function GET(request: Request) {
  const auth = await requireAppUser(request, ["superadmin"]);
  if ("response" in auth) return auth.response;
  await ensureDatabase();
  const d1 = getD1();
  const [bindings, existingUsers] = await Promise.all([
    d1.prepare(`SELECT student_id, contact_kind, active
      FROM student_feishu_identity_bindings ORDER BY student_id`)
      .all<{ student_id: string; contact_kind: string; active: number }>(),
    d1.prepare(`SELECT student_id, feishu_open_id, role, active FROM app_users
      WHERE student_id IS NOT NULL ORDER BY student_id`)
      .all<{ student_id: string; feishu_open_id: string; role: string; active: number }>(),
  ]);
  const byStudent = new Map(bindings.results.map((item) => [item.student_id, item]));
  const usersByStudent = new Map(existingUsers.results.map((item) => [item.student_id, item]));
  return Response.json({
    configured_count: bindings.results.filter((item) => item.active === 1).length,
    complete: confirmedRoster.every((student) => byStudent.get(student.id)?.active === 1),
    students: confirmedRoster.map((student) => {
      const binding = byStudent.get(student.id);
      const existingUser = usersByStudent.get(student.id);
      const status = binding
        ? binding.active === 1 ? "verified" : "conflict"
        : !existingUser
          ? "contact_required"
          : existingUser.active === 1 && existingUser.role !== "pending"
            && /^ou_[A-Za-z0-9_-]{8,}$/.test(existingUser.feishu_open_id) ? "existing_login" : "conflict";
      return {
        id: student.id,
        name: student.name,
        verified: binding?.active === 1,
        source: binding?.contact_kind ?? null,
        status,
      };
    }),
  });
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin"]);
    if ("response" in auth) return auth.response;
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 64 * 1024) return Response.json({ error: "身份清单超出大小限制" }, { status: 413 });

    const body = await request.json() as { requestId?: unknown; contacts?: unknown };
    const requestedId = typeof body.requestId === "string" ? body.requestId.trim().toLowerCase() : "";
    const requestId = requestedId || crypto.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
      return Response.json({ error: "请求标识格式无效" }, { status: 400 });
    }
    if (!Array.isArray(body.contacts) || body.contacts.length > confirmedRoster.length) {
      return Response.json({ error: "学生联系方式清单格式无效" }, { status: 400 });
    }
    const rawInputs = body.contacts as ContactInput[];
    const rosterIds = new Set(confirmedRoster.map((student) => student.id));
    const contactsByStudent = new Map<string, FeishuContactIdentifier>();
    const identifierKeys = new Set<string>();
    for (const item of rawInputs) {
      const studentId = typeof item.studentId === "string" ? item.studentId.trim() : "";
      const kind = item.kind === "email" || item.kind === "mobile" ? item.kind : null;
      const rawValue = typeof item.value === "string" ? item.value : "";
      if (!studentId || !rosterIds.has(studentId) || !kind || contactsByStudent.has(studentId)) {
        return Response.json({ error: "学生身份清单包含未知、重复或缺失字段" }, { status: 400 });
      }
      const value = normalizeFeishuContact(kind, rawValue);
      if (!isValidFeishuContact(kind, value)) {
        return Response.json({ error: `${studentId} 的飞书联系邮箱或手机号格式无效` }, { status: 400 });
      }
      const key = contactKey({ kind, value });
      if (identifierKeys.has(key)) return Response.json({ error: "联系方式不能重复对应多名学生" }, { status: 409 });
      identifierKeys.add(key);
      contactsByStudent.set(studentId, { kind, value });
    }

    await ensureDatabase();
    const d1 = getD1();
    const [existingClaims, completedRequest] = await Promise.all([
      d1.prepare("SELECT COUNT(*) AS count FROM student_feishu_identity_bindings")
        .first<{ count: number }>(),
      d1.prepare(`SELECT b.record_count, COUNT(i.student_id) AS bound_count
        FROM student_identity_binding_batches b
        LEFT JOIN student_feishu_identity_bindings i ON i.batch_id = b.id AND i.active = 1
        WHERE b.request_id = ? GROUP BY b.id, b.record_count`)
        .bind(requestId).first<{ record_count: number; bound_count: number }>(),
    ]);
    if (completedRequest?.record_count === confirmedRoster.length
      && completedRequest.bound_count === confirmedRoster.length) {
      return verifiedResponse();
    }
    if (Number(existingClaims?.count ?? 0) > 0) {
      return Response.json({ error: "学生飞书身份已完成预绑定；为防止覆盖，不能重复执行" }, { status: 409 });
    }

    const placeholders = confirmedRoster.map(() => "?").join(",");
    const [studentRows, existingUsers] = await Promise.all([
      d1.prepare(`SELECT id, display_name FROM students WHERE active = 1 AND id IN (${placeholders})`)
        .bind(...confirmedRoster.map((student) => student.id))
        .all<{ id: string; display_name: string }>(),
      d1.prepare(`SELECT id, feishu_open_id, role, student_id, active FROM app_users
        WHERE student_id IN (${placeholders})`)
        .bind(...confirmedRoster.map((student) => student.id))
        .all<ExistingUser>(),
    ]);
    const studentNames = new Map(studentRows.results.map((student) => [student.id, student.display_name]));
    if (confirmedRoster.some((student) => studentNames.get(student.id) !== student.name)) {
      return Response.json({ error: "生产名册与已确认的 26 人清单不一致，已终止绑定" }, { status: 409 });
    }
    const existingByStudent = new Map(existingUsers.results.map((user) => [user.student_id!, user]));
    const contactsToResolve: Array<FeishuContactIdentifier & { studentId: string }> = [];
    const prepared: PreparedBinding[] = [];
    for (const student of confirmedRoster) {
      const existing = existingByStudent.get(student.id);
      if (existing) {
        if (existing.active !== 1 || existing.role === "pending" || !/^ou_[A-Za-z0-9_-]{8,}$/.test(existing.feishu_open_id)) {
          return Response.json({ error: `${student.name} 的现有账号尚未完成身份核验` }, { status: 409 });
        }
        prepared.push({ studentId: student.id, openId: existing.feishu_open_id, contactKind: "existing_login" });
        continue;
      }
      const contact = contactsByStudent.get(student.id);
      if (!contact) return Response.json({ error: `缺少 ${student.name} 的飞书普通联系邮箱或手机号` }, { status: 400 });
      contactsToResolve.push({ ...contact, studentId: student.id });
    }

    const resolved = await resolveFeishuOpenIds(contactsToResolve);
    const resolvedByContact = new Map<string, string>();
    for (const item of resolved) {
      const key = contactKey(item);
      if (resolvedByContact.has(key)) {
        return Response.json({ error: "飞书返回了重复的身份结果，已终止绑定" }, { status: 409 });
      }
      resolvedByContact.set(key, item.openId);
    }
    for (const contact of contactsToResolve) {
      const openId = resolvedByContact.get(contactKey(contact));
      if (!openId || !/^ou_[A-Za-z0-9_-]{8,}$/.test(openId)) {
        return Response.json({ error: "有学生未能通过飞书联系信息核验；本次未写入任何绑定" }, { status: 409 });
      }
      prepared.push({ studentId: contact.studentId, openId, contactKind: contact.kind });
    }
    if (prepared.length !== confirmedRoster.length || new Set(prepared.map((item) => item.openId)).size !== prepared.length) {
      return Response.json({ error: "飞书身份数量或唯一性校验失败；本次未写入任何绑定" }, { status: 409 });
    }

    const openIdPlaceholders = prepared.map(() => "?").join(",");
    const usersByOpenId = await d1.prepare(`SELECT id, feishu_open_id, role, student_id, active FROM app_users
      WHERE feishu_open_id IN (${openIdPlaceholders})`)
      .bind(...prepared.map((item) => item.openId))
      .all<ExistingUser>();
    const desiredStudentByOpenId = new Map(prepared.map((item) => [item.openId, item.studentId]));
    for (const user of usersByOpenId.results) {
      const desiredStudentId = desiredStudentByOpenId.get(user.feishu_open_id)!;
      if (user.active !== 1) {
        return Response.json({ error: "飞书账号存在已停用的历史绑定；需先人工核验" }, { status: 409 });
      }
      if (user.student_id && user.student_id !== desiredStudentId) {
        return Response.json({ error: "飞书账号已绑定其他学生档案；本次未写入任何绑定" }, { status: 409 });
      }
      if (!user.student_id && user.role !== "pending") {
        return Response.json({ error: "检测到未绑定学生档案的高权限账号；需先人工核验" }, { status: 409 });
      }
    }

    const statements = [
      d1.prepare(`INSERT INTO student_identity_binding_batches
        (actor_user_id, request_id, record_count, detail) VALUES (?, ?, ?, ?)`)
        .bind(auth.user.id, requestId, prepared.length, "26 名学生飞书 Open ID 全量预核验绑定"),
      ...prepared.map((item) => d1.prepare(`INSERT INTO student_feishu_identity_bindings
        (student_id, feishu_open_id, batch_id, verified_by_user_id, verification_method, contact_kind, active)
        SELECT ?, ?, id, ?, ?, ?, 1
        FROM student_identity_binding_batches WHERE request_id = ?`)
        .bind(
          item.studentId,
          item.openId,
          auth.user.id,
          item.contactKind === "existing_login" ? "existing_authenticated_login" : "feishu_contact_batch_get_id",
          item.contactKind,
          requestId,
        )),
    ];
    try {
      await d1.batch(statements);
    } catch {
      const reconciled = await readStoredBindings(d1);
      if (areStudentIdentityBindingsExact(reconciled.results, prepared)) return verifiedResponse();
      return Response.json({ error: "学生飞书身份已被并发操作写入不同结果；本次未覆盖现有绑定" }, { status: 409 });
    }

    const verified = await readStoredBindings(d1);
    if (!areStudentIdentityBindingsExact(verified.results, prepared)) {
      return Response.json({ error: "学生身份写入后的完整性校验失败" }, { status: 409 });
    }
    return verifiedResponse();
  } catch {
    return Response.json({ error: "学生飞书身份预绑定失败" }, { status: 500 });
  }
}
