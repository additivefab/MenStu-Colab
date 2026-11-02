import { canViewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { decryptResearchOutputPassword, encryptResearchOutputPassword } from "../../../lib/research-output-credentials";
import { validateHttpsUrl } from "../../../lib/progress-evidence";
import { loadResearchOutputProblemSummaries } from "../../../lib/problem-records-service";

const outputTypes = new Set(["paper", "dataset", "software", "patent", "report", "presentation", "other"]);
const lifecycleStatuses = new Set(["planned", "in_progress", "submitted", "accepted", "published", "archived"]);
const submissionStatuses = new Set([
  "not_submitted", "planned", "submitted", "with_editor", "under_review", "major_revision",
  "minor_revision", "accepted", "rejected", "withdrawn", "published",
]);

class InputError extends Error {}

function clean(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new InputError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function hasValue(body: Record<string, unknown>, ...names: string[]) {
  return names.some((name) => Object.prototype.hasOwnProperty.call(body, name));
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
  const submissionStatus = clean(body.submissionStatus ?? body.submission_status, "投稿状态", 40) || "not_submitted";
  const rawSubmissionUrl = clean(body.submissionUrl ?? body.submission_url, "投稿系统地址", 2048);
  let submissionUrl = "";
  try { submissionUrl = validateHttpsUrl(rawSubmissionUrl, "投稿系统地址"); }
  catch (error) { throw new InputError(error instanceof Error ? error.message : "投稿系统地址无效"); }
  const submissionUsername = clean(body.submissionUsername ?? body.submission_username, "投稿账号", 300);
  const submissionNextAction = clean(body.submissionNextAction ?? body.submission_next_action, "投稿下一步", 2000);
  const submissionNextActionDueDate = clean(
    body.submissionNextActionDueDate ?? body.submission_next_action_due_date,
    "投稿下一步期限",
    40,
  ) || null;
  const submissionPassword = clean(body.submissionPassword ?? body.submission_password, "投稿密码", 2000);
  // An empty password field means "leave the existing password unchanged" on PATCH.
  const submissionPasswordProvided = hasValue(body, "submissionPassword", "submission_password") && Boolean(submissionPassword);
  const patentApplicationNumber = clean(body.patentApplicationNumber ?? body.patent_application_number, "专利申请号", 200);
  const patentApplicationDate = clean(body.patentApplicationDate ?? body.patent_application_date, "专利申请日", 40) || null;
  const patentOffice = clean(body.patentOffice ?? body.patent_office, "专利受理机构", 300);
  const patentReviewStage = clean(body.patentReviewStage ?? body.patent_review_stage, "专利审查节点", 500);
  const linkedMilestoneValue = body.linkedMilestoneId ?? body.linked_milestone_id;
  const linkedMilestoneId = linkedMilestoneValue !== undefined && linkedMilestoneValue !== null
    && String(linkedMilestoneValue).trim() !== "" ? Number(linkedMilestoneValue) : null;
  if (!studentId || !outputTypes.has(outputType) || !title || !lifecycleStatuses.has(lifecycleStatus)) {
    throw new InputError("请完整填写学生、成果类型、名称和当前阶段");
  }
  if (!submissionStatuses.has(submissionStatus)) throw new InputError("投稿状态无效");
  if (linkedMilestoneId !== null && !Number.isInteger(linkedMilestoneId)) {
    throw new InputError("关联培养节点无效");
  }
  return {
    studentId, outputType, title, lifecycleStatus, venue, identifier, url, summary, linkedMilestoneId,
    submissionStatus, submissionUrl, submissionUsername, submissionNextAction, submissionNextActionDueDate,
    submissionPasswordProvided, submissionPassword, patentApplicationNumber, patentApplicationDate, patentOffice, patentReviewStage,
  };
}

function eventSnapshot(values: ReturnType<typeof outputInput>) {
  const { submissionPassword, submissionPasswordProvided, ...safeValues } = values;
  return { ...safeValues, submissionPasswordSet: submissionPasswordProvided && Boolean(submissionPassword) };
}

async function encryptPasswordIfProvided(values: ReturnType<typeof outputInput>) {
  if (!values.submissionPasswordProvided || !values.submissionPassword) return null;
  try {
    return await encryptResearchOutputPassword(values.submissionPassword);
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "投稿密码加密配置无效");
  }
}

type OutputRow = Record<string, unknown> & {
  id: number;
  student_id: string;
  submission_password_ciphertext: string | null;
  submission_password_iv: string | null;
};

function publicOutput(output: OutputRow) {
  const {
    submission_password_ciphertext: ciphertext,
    submission_password_iv: iv,
    ...safeOutput
  } = output;
  return {
    ...safeOutput,
    submission_password_present: Boolean(ciphertext && iv),
  };
}

async function readOutputs(studentId: string) {
  const d1 = getD1();
  const outputs = await d1.prepare(`SELECT ro.id, ro.student_id, ro.output_type, ro.title, ro.lifecycle_status,
    ro.venue, ro.identifier, ro.url, ro.summary, ro.submission_status, ro.submission_url,
    ro.submission_username, ro.submission_password_ciphertext, ro.submission_password_iv,
    ro.submission_next_action, ro.submission_next_action_due_date, ro.linked_milestone_id,
    ro.patent_application_number, ro.patent_application_date, ro.patent_office, ro.patent_review_stage,
    ro.created_by_user_id, ro.created_at, ro.updated_at,
    m.title AS milestone_title, u.display_name AS created_by_name
    FROM research_outputs ro
    LEFT JOIN research_milestones m ON m.id = ro.linked_milestone_id
    JOIN app_users u ON u.id = ro.created_by_user_id
    WHERE ro.student_id = ? ORDER BY ro.updated_at DESC, ro.id DESC`)
    .bind(studentId).all<OutputRow>();
  const ids = outputs.results.map((item) => Number(item.id));
  if (!ids.length) return [];
  const problemSummaries = await loadResearchOutputProblemSummaries(d1, ids);
  const placeholders = ids.map(() => "?").join(",");
  const events = await d1.prepare(`SELECT e.id, e.output_id, e.action, e.detail, e.created_at,
    u.display_name AS actor_name
    FROM research_output_events e JOIN app_users u ON u.id = e.actor_user_id
    WHERE e.output_id IN (${placeholders}) ORDER BY e.created_at DESC, e.id DESC`)
    .bind(...ids).all<{ id: number; output_id: number; action: string; detail: string; created_at: string; actor_name: string }>();
  return outputs.results.map((output) => ({
    ...publicOutput(output),
    ...(problemSummaries.get(Number(output.id)) ?? {
      problem_count: 0,
      problem_status_summary: { open: 0, pending: 0, resolved: 0 },
      latest_follow_up_date: null,
    }),
    events: events.results.filter((event) => event.output_id === Number(output.id)).slice(0, 8),
  }));
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const params = new URL(request.url).searchParams;
    const studentId = params.get("studentId")?.trim() ?? "";
    if (params.get("revealCredentials") === "1") {
      const outputId = Number(params.get("outputId"));
      if (!Number.isSafeInteger(outputId) || outputId <= 0) {
        return Response.json({ error: "缺少有效成果参数" }, { status: 400 });
      }
      const d1 = getD1();
      const output = await d1.prepare(`SELECT id, student_id, submission_password_ciphertext,
        submission_password_iv FROM research_outputs WHERE id = ?`).bind(outputId).first<OutputRow>();
      if (!output) return Response.json({ error: "科研成果不存在" }, { status: 404 });
      if (studentId && studentId !== output.student_id) {
        return Response.json({ error: "无权读取该科研成果凭证" }, { status: 403 });
      }
      if (!(await canViewStudent(auth.user, output.student_id))) {
        return Response.json({ error: "无权读取该科研成果凭证" }, { status: 403 });
      }
      let submissionPassword = "";
      if (output.submission_password_ciphertext || output.submission_password_iv) {
        if (!output.submission_password_ciphertext || !output.submission_password_iv) {
          throw new Error("投稿密码数据不完整，无法解密");
        }
        submissionPassword = await decryptResearchOutputPassword(
          output.submission_password_ciphertext,
          output.submission_password_iv,
        );
      }
      await d1.prepare(`INSERT INTO research_output_events
        (output_id, actor_user_id, action, detail, snapshot_json)
        VALUES (?, ?, 'credential_view', '查看投稿密码', ?)`)
        .bind(outputId, auth.user.id, JSON.stringify({ credential: "submission_password" })).run();
      return Response.json({ outputId, submissionPassword }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
    }
    if (!studentId) return Response.json({ error: "缺少学生参数" }, { status: 400 });
    if (!(await canViewStudent(auth.user, studentId))) {
      return Response.json({ error: "无权查看该学生的科研成果" }, { status: 403 });
    }
    return Response.json({ outputs: await readOutputs(studentId) }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "科研成果读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const values = outputInput(await request.json() as Record<string, unknown>);
    const d1 = getD1();
    if (!(await canViewStudent(auth.user, values.studentId))) {
      return Response.json({ error: "当前账号无权为该学生登记科研成果" }, { status: 403 });
    }
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1")
      .bind(values.studentId).first();
    if (!student) return Response.json({ error: "学生不存在或已停用" }, { status: 404 });
    const credentials = await encryptPasswordIfProvided(values);
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
       submission_status, submission_url, submission_username, submission_password_ciphertext,
       submission_password_iv, submission_next_action, submission_next_action_due_date,
       patent_application_number, patent_application_date, patent_office, patent_review_stage,
       linked_milestone_id, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(
        values.studentId, values.outputType, values.title, values.lifecycleStatus,
        values.venue, values.identifier, values.url, values.summary,
        values.submissionStatus, values.submissionUrl, values.submissionUsername,
        credentials?.ciphertext ?? null, credentials?.iv ?? null,
        values.submissionNextAction, values.submissionNextActionDueDate,
        values.patentApplicationNumber, values.patentApplicationDate, values.patentOffice, values.patentReviewStage,
        values.linkedMilestoneId, auth.user.id,
      ).first<{ id: number }>();
    if (!row?.id) throw new Error("无法建立科研成果记录");
    await d1.prepare(`INSERT INTO research_output_events
      (output_id, actor_user_id, action, detail, snapshot_json)
      VALUES (?, ?, 'create', '登记科研成果', ?)`)
      .bind(row.id, auth.user.id, JSON.stringify(eventSnapshot(values))).run();
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
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "科研成果参数无效" }, { status: 400 });
    const d1 = getD1();
    const existing = await d1.prepare("SELECT id, student_id FROM research_outputs WHERE id = ?")
      .bind(id).first<{ id: number; student_id: string }>();
    if (!existing) return Response.json({ error: "科研成果不存在" }, { status: 404 });
    if (!(await canViewStudent(auth.user, existing.student_id))) {
      return Response.json({ error: "无权修改该学生的科研成果" }, { status: 403 });
    }
    const values = outputInput({ ...body, studentId: existing.student_id });
    const credentials = await encryptPasswordIfProvided(values);
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
    const updates = [
      "output_type = ?", "title = ?", "lifecycle_status = ?", "venue = ?", "identifier = ?",
      "url = ?", "summary = ?", "submission_status = ?", "submission_url = ?",
      "submission_username = ?", "submission_next_action = ?", "submission_next_action_due_date = ?",
      "patent_application_number = ?", "patent_application_date = ?", "patent_office = ?", "patent_review_stage = ?",
    ];
    const bindings: unknown[] = [
      values.outputType, values.title, values.lifecycleStatus, values.venue, values.identifier,
      values.url, values.summary, values.submissionStatus, values.submissionUrl,
      values.submissionUsername, values.submissionNextAction, values.submissionNextActionDueDate,
      values.patentApplicationNumber, values.patentApplicationDate, values.patentOffice, values.patentReviewStage,
    ];
    if (values.submissionPasswordProvided) {
      updates.push("submission_password_ciphertext = ?", "submission_password_iv = ?");
      bindings.push(credentials?.ciphertext ?? null, credentials?.iv ?? null);
    }
    updates.push("linked_milestone_id = ?", "updated_at = CURRENT_TIMESTAMP");
    bindings.push(values.linkedMilestoneId, id);
    await d1.batch([
      d1.prepare(`UPDATE research_outputs SET ${updates.join(", ")} WHERE id = ?`).bind(...bindings),
      d1.prepare(`INSERT INTO research_output_events
        (output_id, actor_user_id, action, detail, snapshot_json)
        VALUES (?, ?, 'update', '更新成果阶段、投稿跟踪或证据', ?)`)
        .bind(id, auth.user.id, JSON.stringify(eventSnapshot(values))),
    ]);
    return Response.json({ message: "科研成果已更新，并保留变更记录" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "科研成果更新失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}
