import { canViewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import {
  AttachmentInputError,
  attachmentStorageKey,
  validateProgressFiles,
} from "../../../lib/progress-attachments";
import { sha256Bytes, sha256Text, validateHttpsUrl } from "../../../lib/progress-evidence";
import { getProgressFileBucket } from "../../../lib/progress-file-storage";

const allowedKinds = new Set(["文献", "实验", "算法", "数据", "论文", "复现", "项目", "组会"]);
const studentSubmissionKinds = new Set(["论文", "项目"]);

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

function progressInput(body: Record<string, unknown>, hasAttachments = false) {
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
  if (!studentId || !allowedKinds.has(kind) || !title || !summary || (!evidence && !hasAttachments)) {
    throw new InputError("请完整填写学生、类型、进展、结论，并提供文字证据或附件");
  }
  if (kind === "文献" && !literatureRef) throw new InputError("文献进展需要填写论文题目或 DOI");
  return { studentId, kind, title, summary, evidence, literatureRef, gitUrl };
}

async function requestInput(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return { body: (await request.json()) as Record<string, unknown>, files: [] as File[] };
  }
  const form = await request.formData();
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") body[key] = value;
  }
  const files = form.getAll("attachments").filter((value): value is File =>
    typeof value !== "string" && value.size > 0,
  );
  return { body, files };
}

async function storeAttachments(progressId: number, studentId: string, userId: number, files: File[]) {
  const validated = validateProgressFiles(files);
  if (!validated.length) return [] as number[];
  const d1 = getD1();
  const bucket = getProgressFileBucket();
  const storedKeys: string[] = [];
  const attachmentIds: number[] = [];
  try {
    for (const item of validated) {
      const bytes = await item.file.arrayBuffer();
      const contentSha256 = await sha256Bytes(bytes);
      const storageKey = attachmentStorageKey(studentId, progressId, item.fileName);
      await bucket.put(storageKey, bytes, {
        httpMetadata: { contentType: item.contentType },
        customMetadata: { studentId, progressId: String(progressId) },
      });
      storedKeys.push(storageKey);
      const row = await d1.prepare(`INSERT INTO progress_attachments
        (progress_entry_id, storage_key, file_name, content_type, size_bytes, content_sha256, uploaded_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .bind(progressId, storageKey, item.fileName, item.contentType, item.file.size, contentSha256, userId)
        .first<{ id: number }>();
      if (!row?.id) throw new Error("无法保存附件信息");
      attachmentIds.push(row.id);
      await d1.prepare(`INSERT INTO progress_evidence_sources
        (progress_entry_id, source_type, label, source_ref, content_sha256, created_by_user_id)
        VALUES (?, 'attachment', ?, ?, ?, ?)`)
        .bind(progressId, `附件：${item.fileName}`, `/api/progress/files?id=${row.id}`, contentSha256, userId)
        .run();
    }
    return attachmentIds;
  } catch (error) {
    await Promise.allSettled(storedKeys.map((key) => bucket.delete(key)));
    for (const attachmentId of attachmentIds) {
      await d1.prepare("DELETE FROM progress_evidence_sources WHERE source_type = 'attachment' AND source_ref = ?")
        .bind(`/api/progress/files?id=${attachmentId}`).run();
      await d1.prepare("DELETE FROM progress_attachments WHERE id = ?").bind(attachmentId).run();
    }
    throw error;
  }
}

async function deleteCreatedProgress(progressId: number) {
  const d1 = getD1();
  const attachments = await d1.prepare("SELECT storage_key FROM progress_attachments WHERE progress_entry_id = ?")
    .bind(progressId).all<{ storage_key: string }>();
  if (attachments.results.length) {
    const bucket = getProgressFileBucket();
    await Promise.allSettled(attachments.results.map((item) => bucket.delete(item.storage_key)));
  }
  await d1.batch([
    d1.prepare("DELETE FROM progress_evidence_sources WHERE progress_entry_id = ?").bind(progressId),
    d1.prepare("DELETE FROM progress_audit_events WHERE progress_entry_id = ?").bind(progressId),
    d1.prepare("DELETE FROM progress_attachments WHERE progress_entry_id = ?").bind(progressId),
    d1.prepare("DELETE FROM progress_entries WHERE id = ?").bind(progressId),
  ]);
}

export async function POST(request: Request) {
  let createdId: number | null = null;
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const { body, files } = await requestInput(request);
    validateProgressFiles(files);
    if (auth.user.role === "student" && !auth.user.studentId) {
      return Response.json({ error: "学生账号尚未绑定学生记录" }, { status: 403 });
    }
    const values = progressInput({
      ...body,
      studentId: auth.user.role === "student" ? auth.user.studentId : body.studentId,
    }, files.length > 0);
    if (auth.user.role === "student" && !studentSubmissionKinds.has(values.kind)) {
      return Response.json({ error: "学生端仅支持提交论文进度或项目进度" }, { status: 400 });
    }

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
    await storeAttachments(createdId, values.studentId, auth.user.id, files);
    const id = createdId;
    createdId = null;
    return Response.json({ id, message: "已提交，等待导师确认" }, { status: 201 });
  } catch (error) {
    if (createdId) {
      try { await deleteCreatedProgress(createdId); } catch { /* noop */ }
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "提交失败" },
      { status: error instanceof InputError || error instanceof AttachmentInputError ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const { body, files } = await requestInput(request);
    validateProgressFiles(files);
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
    }, files.length > 0);
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
    await storeAttachments(id, existing.student_id, auth.user.id, files);
    return Response.json({ message: "补充证据已重新提交导师审核" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "重新提交失败" },
      { status: error instanceof InputError || error instanceof AttachmentInputError ? 400 : 500 },
    );
  }
}
