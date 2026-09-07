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
import {
  abortProgressUploadIntents,
  deleteProgressFilesOrQueue,
  recoverOwnedIncompleteProgressSubmission,
  recoverStaleProgressSubmission,
  retryQueuedProgressFileCleanup,
} from "../../../lib/progress-file-cleanup";
import { progressUploadIntentGuardSql } from "../../../lib/progress-saga-sql";
import { isIsoDate, isPaperStage, isPaperType } from "../../../lib/paper-progress";

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
  revisionNumber: number,
  values: { summary: string; evidence: string; literatureRef: string; gitUrl: string },
  operationToken: string | null = null,
) {
  const d1 = getD1();
  const statements = [];
  if (values.evidence) {
    statements.push(d1.prepare(operationToken ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'manual', '提交时填写的核验证据', '', ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM progress_revisions operation_revision
        WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
          AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
      )` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      VALUES (?, 'manual', '提交时填写的核验证据', '', ?, ?, ?)`)
      .bind(progressId, await sha256Text(values.evidence), revisionNumber, userId,
        ...(operationToken ? [progressId, revisionNumber, operationToken] : [])));
  }
  if (values.literatureRef) {
    statements.push(d1.prepare(operationToken ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'doi', '论文或 DOI', ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM progress_revisions operation_revision
        WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
          AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
      )` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      VALUES (?, 'doi', '论文或 DOI', ?, ?, ?, ?)`)
      .bind(progressId, values.literatureRef, await sha256Text(values.literatureRef), revisionNumber, userId,
        ...(operationToken ? [progressId, revisionNumber, operationToken] : [])));
  }
  if (values.gitUrl) {
    statements.push(d1.prepare(operationToken ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'git', 'Git 仓库或提交', ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM progress_revisions operation_revision
        WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
          AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
      )` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      VALUES (?, 'git', 'Git 仓库或提交', ?, ?, ?, ?)`)
      .bind(progressId, values.gitUrl, await sha256Text(values.gitUrl), revisionNumber, userId,
        ...(operationToken ? [progressId, revisionNumber, operationToken] : [])));
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
  if (!studentId || !allowedKinds.has(kind) || !title || !summary || (!evidence && !gitUrl && !hasAttachments)) {
    throw new InputError("请完整填写学生、类型、进展、结论，并提供文字证据、Git 链接或附件");
  }
  if (kind === "文献" && !literatureRef) throw new InputError("文献进展需要填写论文题目或 DOI");
  return { studentId, kind, title, summary, evidence, literatureRef, gitUrl };
}

function cleanDate(value: unknown, label: string, required = false) {
  const text = clean(value, label, 10);
  if (!text && !required) return "";
  if (!isIsoDate(text)) {
    throw new InputError(`${label}格式无效`);
  }
  return text;
}

function paperProgressInput(body: Record<string, unknown>) {
  const rawPaperId = clean(body.paperId, "论文", 20);
  const paperId = rawPaperId ? Number(rawPaperId) : null;
  if (rawPaperId && (!Number.isInteger(paperId) || Number(paperId) < 1)) {
    throw new InputError("论文参数无效");
  }
  const stage = clean(body.paperStage, "论文阶段", 40);
  if (!isPaperStage(stage)) throw new InputError("请选择有效的论文阶段");
  const manuscriptVersion = clean(body.manuscriptVersion, "稿件版本", 80);
  const nextAction = clean(body.nextAction, "下一行动", 1_000);
  const nextActionDueDate = cleanDate(body.nextActionDueDate, "下一行动日期", true);
  const blocker = clean(body.blocker, "阻塞问题", 2_000);
  const submissionIdentifier = clean(body.submissionIdentifier, "稿件编号或 DOI", 300);
  if (!manuscriptVersion || !nextAction) {
    throw new InputError("请填写稿件版本和下一行动");
  }

  const paperTitle = clean(body.paperTitle, "论文题目", 300);
  const paperType = clean(body.paperType, "论文类型", 20);
  const targetVenue = clean(body.targetVenue, "目标期刊或会议", 200);
  const plannedSubmissionDate = cleanDate(body.plannedSubmissionDate, "计划投稿日期", !paperId);
  if (!paperId && (!paperTitle || !isPaperType(paperType))) {
    throw new InputError("新建论文时请填写论文题目、类型和计划投稿日期");
  }
  return {
    paperId: paperId as number | null,
    stage,
    manuscriptVersion,
    nextAction,
    nextActionDueDate,
    blocker,
    submissionIdentifier,
    paperTitle,
    paperType,
    targetVenue,
    plannedSubmissionDate,
  };
}

function projectProgressInput(body: Record<string, unknown>) {
  const rawMilestoneId = clean(body.linkedMilestoneId, "培养节点", 20);
  const milestoneId = rawMilestoneId ? Number(rawMilestoneId) : null;
  if (rawMilestoneId && (!Number.isInteger(milestoneId) || Number(milestoneId) < 1)) {
    throw new InputError("培养节点参数无效");
  }
  const nextAction = clean(body.nextAction, "下一行动", 1_000);
  const nextActionDueDate = cleanDate(body.nextActionDueDate, "下一行动日期", true);
  const blocker = clean(body.blocker, "阻塞问题", 2_000);
  const completionRequested = new Set(["1", "true", "on"]).has(String(body.completionRequested ?? "").toLowerCase());
  if (!nextAction) throw new InputError("请填写课题的下一行动");
  if (completionRequested && !milestoneId) {
    throw new InputError("申请完成培养节点时必须先关联节点");
  }
  return {
    milestoneId: milestoneId as number | null,
    nextAction,
    nextActionDueDate,
    blocker,
    completionRequested,
  };
}

type LinkedMilestone = {
  id: number;
  proposal_id: number;
  title: string;
  target_date: string;
  evidence_target: string;
  proposal_version: number;
  status: "pending" | "in_progress" | "completed" | "blocked";
  proposal_status: "draft" | "submitted" | "changes_requested" | "approved";
};

async function validateLinkedMilestone(studentId: string, milestoneId: number | null) {
  if (!milestoneId) return null;
  const milestone = await getD1().prepare(`SELECT m.id, m.proposal_id, m.title, m.target_date,
    m.evidence_target, m.status, rp.status AS proposal_status, rp.current_version AS proposal_version
    FROM research_milestones m
    JOIN research_proposals rp ON rp.id = m.proposal_id
    WHERE m.id = ? AND rp.student_id = ? AND m.archived_at IS NULL`)
    .bind(milestoneId, studentId).first<LinkedMilestone>();
  if (!milestone) throw new InputError("培养节点不存在或不属于当前学生");
  if (milestone.proposal_status !== "approved") throw new InputError("研究方案确认后才能关联培养节点");
  if (milestone.status === "completed") throw new InputError("已完成的培养节点不能继续关联新进展");
  return milestone;
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

type StagedAttachment = {
  storageKey: string;
  progressEntryId: number;
  studentId: string;
  revisionNumber: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  contentSha256: string;
};

async function stageAttachments(progressId: number, studentId: string, revisionNumber: number, files: File[]) {
  const validated = validateProgressFiles(files);
  if (!validated.length) return [] as StagedAttachment[];
  const bucket = getProgressFileBucket();
  const staged: StagedAttachment[] = [];
  try {
    for (const item of validated) {
      const bytes = await item.file.arrayBuffer();
      const contentSha256 = await sha256Bytes(bytes);
      const storageKey = attachmentStorageKey(studentId, progressId, item.fileName);
      const stagedItem = {
        storageKey,
        progressEntryId: progressId,
        studentId,
        revisionNumber,
        fileName: item.fileName,
        contentType: item.contentType,
        sizeBytes: item.file.size,
        contentSha256,
      };
      await getD1().prepare(`INSERT INTO progress_file_cleanup_queue
        (storage_key, progress_entry_id, student_id, revision_number, reason, attempts, last_error, updated_at)
        VALUES (?, ?, ?, ?, 'upload_intent', 0, '', CURRENT_TIMESTAMP)
        ON CONFLICT(storage_key) DO UPDATE SET
          progress_entry_id = excluded.progress_entry_id,
          student_id = excluded.student_id,
          revision_number = excluded.revision_number,
          reason = 'upload_intent', attempts = 0, last_error = '', updated_at = CURRENT_TIMESTAMP`)
        .bind(storageKey, progressId, studentId, revisionNumber).run();
      staged.push(stagedItem);
      await bucket.put(storageKey, bytes, {
        httpMetadata: { contentType: item.contentType },
        customMetadata: { studentId, progressId: String(progressId), revisionNumber: String(revisionNumber) },
      });
    }
    return staged;
  } catch (error) {
    await deleteProgressFilesOrQueue(staged, "upload_staging_failed");
    throw error;
  }
}

async function deleteStagedAttachments(staged: StagedAttachment[], reason = "database_compensation") {
  if (!staged.length) return;
  await deleteProgressFilesOrQueue(staged, reason);
}

function attachmentStatements(
  progressId: number,
  userId: number,
  revisionNumber: number,
  staged: StagedAttachment[],
  operationToken: string | null = null,
) {
  const d1 = getD1();
  return staged.flatMap((item) => [
    d1.prepare(operationToken ? `INSERT INTO progress_attachments
      (progress_entry_id, storage_key, file_name, content_type, size_bytes, content_sha256,
       revision_number, uploaded_by_user_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM progress_revisions operation_revision
        WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
          AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
      )` : `INSERT INTO progress_attachments
      (progress_entry_id, storage_key, file_name, content_type, size_bytes, content_sha256,
       revision_number, uploaded_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        progressId, item.storageKey, item.fileName, item.contentType, item.sizeBytes,
        item.contentSha256, revisionNumber, userId,
        ...(operationToken ? [progressId, revisionNumber, operationToken] : []),
      ),
    d1.prepare(operationToken ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'attachment', ?, '/api/progress/files?id=' || id, ?, ?, ?
      FROM progress_attachments WHERE storage_key = ? AND EXISTS (
        SELECT 1 FROM progress_revisions operation_revision
        WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
          AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
      )` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'attachment', ?, '/api/progress/files?id=' || id, ?, ?, ?
      FROM progress_attachments WHERE storage_key = ?`)
      .bind(
        progressId, `附件：${item.fileName}`, item.contentSha256,
        revisionNumber, userId, item.storageKey,
        ...(operationToken ? [progressId, revisionNumber, operationToken] : []),
      ),
    d1.prepare(operationToken
      ? `DELETE FROM progress_file_cleanup_queue WHERE storage_key = ? AND EXISTS (
          SELECT 1 FROM progress_revisions operation_revision
          WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
            AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
        )`
      : "DELETE FROM progress_file_cleanup_queue WHERE storage_key = ?")
      .bind(item.storageKey, ...(operationToken ? [progressId, revisionNumber, operationToken] : [])),
  ]);
}

function uploadIntentGuard(staged: StagedAttachment[], revisionNumber: number) {
  if (!staged.length) return { clause: "", bindings: [] as Array<string | number> };
  return {
    clause: progressUploadIntentGuardSql(staged.length),
    bindings: [revisionNumber, ...staged.map((item) => item.storageKey), staged.length],
  };
}

function progressSnapshot(
  values: { kind: string; title: string; summary: string; evidence: string; literatureRef: string; gitUrl: string },
  paper: ReturnType<typeof paperProgressInput> | null,
  project: ReturnType<typeof projectProgressInput> | null,
  milestone: LinkedMilestone | null,
  attachments: StagedAttachment[],
  operationToken: string | null = null,
) {
  return JSON.stringify({
    kind: values.kind,
    title: values.title,
    summary: values.summary,
    evidence: values.evidence,
    literatureRef: values.literatureRef,
    gitUrl: values.gitUrl,
    ...(operationToken ? { _operationToken: operationToken } : {}),
    attachments: attachments.map((item) => ({
      fileName: item.fileName,
      contentType: item.contentType,
      sizeBytes: item.sizeBytes,
      contentSha256: item.contentSha256,
    })),
    paper: paper ? {
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      paperType: paper.paperType,
      targetVenue: paper.targetVenue,
      plannedSubmissionDate: paper.plannedSubmissionDate,
      stage: paper.stage,
      manuscriptVersion: paper.manuscriptVersion,
      nextAction: paper.nextAction,
      nextActionDueDate: paper.nextActionDueDate,
      blocker: paper.blocker,
      submissionIdentifier: paper.submissionIdentifier,
    } : null,
    project: project ? {
      milestoneId: project.milestoneId,
      milestoneTitle: milestone?.title ?? "",
      milestoneTargetDate: milestone?.target_date ?? null,
      evidenceTarget: milestone?.evidence_target ?? "",
      proposalVersion: milestone?.proposal_version ?? null,
      nextAction: project.nextAction,
      nextActionDueDate: project.nextActionDueDate,
      blocker: project.blocker,
      completionRequested: project.completionRequested,
    } : null,
  });
}

function idempotencyKey(request: Request) {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(key)) {
    throw new InputError("缺少有效的 Idempotency-Key，请刷新页面后重试");
  }
  return key;
}

async function progressRequestHash(
  values: ReturnType<typeof progressInput>,
  paper: ReturnType<typeof paperProgressInput> | null,
  project: ReturnType<typeof projectProgressInput> | null,
  files: File[],
) {
  const fileFingerprints: Array<{ name: string; type: string; size: number; sha256: string }> = [];
  for (const file of files) {
    fileFingerprints.push({
      name: file.name,
      type: file.type,
      size: file.size,
      sha256: await sha256Bytes(await file.arrayBuffer()),
    });
  }
  return sha256Text(JSON.stringify({ values, paper, project, files: fileFingerprints }));
}

function isIdempotencyConflict(error: unknown) {
  return error instanceof Error && /(?:idx_progress_submitter_idempotency|progress_entries\.submitted_by_user_id, progress_entries\.idempotency_key)/iu.test(error.message);
}

async function findIdempotentProgress(userId: number, key: string) {
  return getD1().prepare(`SELECT p.id, p.request_hash,
    EXISTS (SELECT 1 FROM progress_revisions r
      WHERE r.progress_entry_id = p.id AND r.revision_number = p.current_revision) AS complete,
    CASE WHEN p.submitted_at <= datetime('now', '-30 minutes') THEN 1 ELSE 0 END AS stale
    FROM progress_entries p
    WHERE p.submitted_by_user_id = ? AND p.idempotency_key = ?`)
    .bind(userId, key)
    .first<{ id: number; request_hash: string; complete: number; stale: number }>();
}

async function findCommittedResubmission(progressId: number, revisionNumber: number, operationToken: string) {
  return getD1().prepare(`SELECT 1 AS committed FROM progress_revisions
    WHERE progress_entry_id = ? AND revision_number = ?
      AND json_extract(snapshot_json, '$._operationToken') = ? LIMIT 1`)
    .bind(progressId, revisionNumber, operationToken)
    .first<{ committed: number }>();
}

export async function POST(request: Request) {
  let createdId: number | null = null;
  let stagedAttachments: StagedAttachment[] = [];
  let requestKey = "";
  let requestHash = "";
  let requestUserId: number | null = null;
  let createAttempted = false;
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    await retryQueuedProgressFileCleanup().catch(() => undefined);
    requestKey = idempotencyKey(request);
    requestUserId = auth.user.id;
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
    const structuredPaper = values.kind === "论文" && (
      auth.user.role === "student" || Boolean(String(body.paperStage ?? "").trim())
    );
    const paperValues = structuredPaper ? paperProgressInput(body) : null;
    const structuredProject = values.kind === "项目" && (
      auth.user.role === "student" || Boolean(String(body.nextAction ?? "").trim())
    );
    const projectValues = structuredProject ? projectProgressInput(body) : null;
    requestHash = await progressRequestHash(values, paperValues, projectValues, files);

    const d1 = getD1();
    if (auth.user.role !== "student" && auth.user.studentId === values.studentId) {
      return Response.json({ error: "请切换到本人学生端提交自己的进展" }, { status: 403 });
    }
    if (auth.user.role !== "student" && !(await canViewStudent(auth.user, values.studentId))) {
      return Response.json({ error: "当前账号无权为该学生提交进展" }, { status: 403 });
    }
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1")
      .bind(values.studentId).first();
    if (!student) return Response.json({ error: "学生不存在" }, { status: 404 });
    const linkedMilestone = projectValues
      ? await validateLinkedMilestone(values.studentId, projectValues.milestoneId)
      : null;

    const previous = await findIdempotentProgress(auth.user.id, requestKey);
    if (previous) {
      if (previous.request_hash !== requestHash) {
        return Response.json({ error: "同一提交键不能用于不同内容，请刷新页面后重试" }, { status: 409 });
      }
      if (previous.complete) {
        return Response.json({ id: previous.id, message: "该进展此前已提交，本次未重复创建", replayed: true });
      }
      if (!previous.stale) {
        return Response.json({ error: "相同提交仍在上传处理中，请稍后使用同一表单重试" }, { status: 409 });
      }
      try {
        const recovered = await recoverStaleProgressSubmission({
          progressId: previous.id,
          submittedByUserId: auth.user.id,
          idempotencyKey: requestKey,
        });
        if (!recovered.claimed) {
          const current = await findIdempotentProgress(auth.user.id, requestKey);
          if (current?.request_hash === requestHash && current.complete) {
            return Response.json({ id: current.id, message: "该进展此前已提交，本次未重复创建", replayed: true });
          }
          return Response.json({ error: "相同提交已被其他请求恢复，请稍后使用同一表单重试" }, { status: 409 });
        }
      } catch {
        return Response.json({ error: "上次提交仍在恢复中，请稍后使用同一表单重试" }, { status: 409 });
      }
    }

    if (paperValues?.paperId) {
      const paper = await d1.prepare(`SELECT id FROM student_papers
        WHERE id = ? AND student_id = ? AND status != 'closed'`)
        .bind(paperValues.paperId, values.studentId).first();
      if (!paper) return Response.json({ error: "论文不存在或已关闭" }, { status: 404 });
    }

    createAttempted = true;
    const row = await d1.prepare(`INSERT INTO progress_entries
      (student_id, kind, title, summary, evidence, literature_ref, git_url, status,
       review_status, submitted_by_user_id, idempotency_key, request_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'submitted', ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id`)
      .bind(
        values.studentId, values.kind, values.title, values.summary, values.evidence,
        values.literatureRef, values.gitUrl, auth.user.id, requestKey, requestHash,
      )
      .first<{ id: number }>();
    createdId = row?.id ?? null;
    if (!createdId) throw new Error("无法建立进展记录");

    stagedAttachments = await stageAttachments(createdId, values.studentId, 1, files);
    const snapshot = progressSnapshot(values, paperValues, projectValues, linkedMilestone, stagedAttachments);

    await d1.batch([
      d1.prepare(`INSERT INTO progress_revisions
        (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id, review_status)
        VALUES (?, 1, ?, ?, 'submitted')`)
        .bind(createdId, snapshot, auth.user.id),
      ...(await evidenceStatements(createdId, auth.user.id, 1, values)),
      ...(paperValues?.paperId ? [
        d1.prepare(`INSERT INTO paper_progress_details
          (progress_entry_id, paper_id, stage, manuscript_version, next_action, next_action_due_date, blocker)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            createdId, paperValues.paperId, paperValues.stage, paperValues.manuscriptVersion,
            paperValues.nextAction, paperValues.nextActionDueDate, paperValues.blocker,
          ),
      ] : []),
      ...(paperValues && !paperValues.paperId ? [
        d1.prepare(`INSERT INTO paper_submission_candidates
          (progress_entry_id, title, paper_type, target_venue, planned_submission_date,
           stage, manuscript_version, next_action, next_action_due_date, blocker, submission_identifier)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            createdId, paperValues.paperTitle, paperValues.paperType, paperValues.targetVenue,
            paperValues.plannedSubmissionDate, paperValues.stage, paperValues.manuscriptVersion,
            paperValues.nextAction, paperValues.nextActionDueDate, paperValues.blocker,
            paperValues.submissionIdentifier,
          ),
      ] : []),
      ...(projectValues ? [
        d1.prepare(`INSERT INTO project_progress_details
          (progress_entry_id, milestone_id, milestone_title, milestone_target_date,
           evidence_target, proposal_version, next_action, next_action_due_date, blocker, completion_requested)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            createdId, projectValues.milestoneId, linkedMilestone?.title ?? "",
            linkedMilestone?.target_date ?? null, linkedMilestone?.evidence_target ?? "",
            linkedMilestone?.proposal_version ?? null, projectValues.nextAction,
            projectValues.nextActionDueDate, projectValues.blocker,
            projectValues.completionRequested ? 1 : 0,
          ),
      ] : []),
      ...(linkedMilestone && projectValues ? [
        d1.prepare(`INSERT INTO proposal_audit_events (proposal_id, actor_user_id, action, detail)
          VALUES (?, ?, 'progress_linked', ?)`)
          .bind(
            linkedMilestone.proposal_id,
            auth.user.id,
            `${linkedMilestone.title}：关联课题进展 #${createdId}${projectValues.completionRequested ? "，申请完成节点" : ""}`,
          ),
      ] : []),
      ...attachmentStatements(createdId, auth.user.id, 1, stagedAttachments),
      d1.prepare(`INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
        VALUES (?, ?, 'user', 'submit', '', 'submitted', '提交进展与核验证据')`)
        .bind(createdId, auth.user.id),
    ]);
    const id = createdId;
    createdId = null;
    stagedAttachments = [];
    return Response.json({
      id,
      message: paperValues
        ? "论文进度已提交，等待导师确认"
        : projectValues?.completionRequested
          ? "课题进展已提交；导师确认实质性进展后，培养节点才会完成"
          : projectValues
            ? "课题进展已提交并更新下一行动"
            : "已提交，等待导师确认",
    }, { status: 201 });
  } catch (error) {
    let previous: Awaited<ReturnType<typeof findIdempotentProgress>> = null;
    if (createAttempted && requestUserId && requestKey && requestHash) {
      try {
        previous = await findIdempotentProgress(requestUserId, requestKey);
      } catch {
        return Response.json(
          { error: "提交结果暂时无法确认，请稍后使用同一表单重试" },
          { status: 503 },
        );
      }
      if (previous?.request_hash === requestHash && previous.complete) {
        createdId = null;
        stagedAttachments = [];
        return Response.json({ id: previous.id, message: "该进展此前已提交，本次未重复创建", replayed: true });
      }
    }

    let recoveredOwnedCreate = false;
    if (createdId && requestUserId && requestKey && requestHash) {
      try {
        const recovery = await recoverOwnedIncompleteProgressSubmission({
          progressId: createdId,
          submittedByUserId: requestUserId,
          idempotencyKey: requestKey,
          requestHash,
        });
        if (!recovery.claimed) {
          const current = await findIdempotentProgress(requestUserId, requestKey);
          if (current?.request_hash === requestHash && current.complete) {
            stagedAttachments = [];
            return Response.json({ id: current.id, message: "该进展此前已提交，本次未重复创建", replayed: true });
          }
          stagedAttachments = [];
          return Response.json(
            { error: "提交结果暂时无法确认，请稍后使用同一表单重试；附件不会被清理" },
            { status: 503 },
          );
        }
        recoveredOwnedCreate = true;
        stagedAttachments = [];
      } catch {
        return Response.json(
          { error: "提交结果暂时无法确认，请稍后使用同一表单重试；附件不会被清理" },
          { status: 503 },
        );
      }
    }
    if (previous && previous.request_hash !== requestHash) {
      return Response.json({ error: "同一提交键不能用于不同内容，请刷新页面后重试" }, { status: 409 });
    }
    if (previous && !recoveredOwnedCreate) {
      return Response.json({ error: "相同提交正在处理中，请稍后使用同一表单重试" }, { status: 409 });
    }
    if (isIdempotencyConflict(error)) {
      return Response.json({ error: "相同提交正在处理中，请稍后使用同一表单重试" }, { status: 409 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "提交失败" },
      { status: error instanceof InputError || error instanceof AttachmentInputError ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request) {
  let stagedAttachments: StagedAttachment[] = [];
  let resubmitProgressId: number | null = null;
  let resubmitRevision: number | null = null;
  let resubmitOperationToken = "";
  let resubmitWriteAttempted = false;
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    await retryQueuedProgressFileCleanup().catch(() => undefined);
    const { body, files } = await requestInput(request);
    validateProgressFiles(files);
    const id = Number(body.id);
    if (!Number.isInteger(id)) return Response.json({ error: "进展参数无效" }, { status: 400 });
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      return Response.json({ error: "缺少有效的当前修订版本，请刷新后重试" }, { status: 400 });
    }

    const d1 = getD1();
    const existing = await d1.prepare(`SELECT p.id, p.student_id, p.kind, p.title, p.review_status,
      p.current_revision,
      pd.paper_id, pd.stage AS paper_stage, pd.manuscript_version, pd.next_action,
      pd.next_action_due_date, pd.blocker, sp.submission_identifier,
      candidate.title AS candidate_title, candidate.paper_type AS candidate_paper_type,
      candidate.target_venue AS candidate_target_venue,
      candidate.planned_submission_date AS candidate_planned_submission_date,
      candidate.stage AS candidate_stage,
      candidate.manuscript_version AS candidate_manuscript_version,
      candidate.next_action AS candidate_next_action,
      candidate.next_action_due_date AS candidate_next_action_due_date,
      candidate.blocker AS candidate_blocker,
      candidate.submission_identifier AS candidate_submission_identifier,
      ppd.milestone_id AS project_milestone_id, ppd.next_action AS project_next_action,
      ppd.next_action_due_date AS project_next_action_due_date,
      ppd.blocker AS project_blocker, ppd.completion_requested,
      ppd.milestone_title AS project_milestone_title,
      ppd.milestone_target_date AS project_milestone_target_date,
      ppd.evidence_target AS project_evidence_target,
      ppd.proposal_version AS project_proposal_version
      FROM progress_entries p
      LEFT JOIN paper_progress_details pd ON pd.progress_entry_id = p.id
      LEFT JOIN student_papers sp ON sp.id = pd.paper_id
      LEFT JOIN paper_submission_candidates candidate ON candidate.progress_entry_id = p.id
      LEFT JOIN project_progress_details ppd ON ppd.progress_entry_id = p.id
      WHERE p.id = ? AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)`).bind(id).first<{
        id: number; student_id: string; kind: string; title: string; review_status: string;
        current_revision: number;
        paper_id: number | null; paper_stage: string | null; manuscript_version: string | null;
        next_action: string | null; next_action_due_date: string | null; blocker: string | null;
        submission_identifier: string | null;
        candidate_title: string | null; candidate_paper_type: string | null;
        candidate_target_venue: string | null; candidate_planned_submission_date: string | null;
        candidate_stage: string | null; candidate_manuscript_version: string | null;
        candidate_next_action: string | null; candidate_next_action_due_date: string | null;
        candidate_blocker: string | null; candidate_submission_identifier: string | null;
        project_milestone_id: number | null; project_next_action: string | null;
        project_next_action_due_date: string | null; project_blocker: string | null;
        completion_requested: number | null;
        project_milestone_title: string | null; project_milestone_target_date: string | null;
        project_evidence_target: string | null; project_proposal_version: number | null;
      }>();
    if (!existing) return Response.json({ error: "进展记录不存在" }, { status: 404 });
    if (auth.user.role !== "student" && auth.user.studentId === existing.student_id) {
      return Response.json({ error: "请切换到本人学生端补充自己的进展证据" }, { status: 403 });
    }
    if (!(await canViewStudent(auth.user, existing.student_id))) {
      return Response.json({ error: "无权修改该学生的进展" }, { status: 403 });
    }
    if (existing.review_status !== "changes_requested") {
      return Response.json({ error: "只有导师退回补充的证据可以重新提交" }, { status: 409 });
    }
    if (existing.current_revision !== expectedRevision) {
      return Response.json({ error: "修订版本已变化，请刷新后再提交，当前内容不会被覆盖" }, { status: 409 });
    }

    const values = progressInput({
      ...body,
      studentId: existing.student_id,
      kind: existing.kind,
      title: body.title ?? existing.title,
    }, files.length > 0);
    const paperValues = (existing.paper_id || existing.candidate_title) ? paperProgressInput({
      ...body,
      paperId: existing.paper_id ?? "",
      paperTitle: body.paperTitle ?? existing.candidate_title,
      paperType: body.paperType ?? existing.candidate_paper_type,
      targetVenue: body.targetVenue ?? existing.candidate_target_venue,
      plannedSubmissionDate: body.plannedSubmissionDate ?? existing.candidate_planned_submission_date,
      paperStage: body.paperStage ?? existing.paper_stage ?? existing.candidate_stage,
      manuscriptVersion: body.manuscriptVersion ?? existing.manuscript_version ?? existing.candidate_manuscript_version,
      nextAction: body.nextAction ?? existing.next_action ?? existing.candidate_next_action,
      nextActionDueDate: body.nextActionDueDate ?? existing.next_action_due_date ?? existing.candidate_next_action_due_date,
      blocker: body.blocker ?? existing.blocker ?? existing.candidate_blocker,
      submissionIdentifier: body.submissionIdentifier ?? existing.submission_identifier ?? existing.candidate_submission_identifier,
    }) : null;
    const hasProjectDetails = existing.kind === "项目" && Boolean(
      existing.project_next_action || String(body.nextAction ?? "").trim(),
    );
    const projectValues = hasProjectDetails ? projectProgressInput({
      ...body,
      linkedMilestoneId: body.linkedMilestoneId ?? existing.project_milestone_id,
      nextAction: body.nextAction ?? existing.project_next_action,
      nextActionDueDate: body.nextActionDueDate ?? existing.project_next_action_due_date,
      blocker: body.blocker ?? existing.project_blocker,
      completionRequested: body.completionRequested ?? existing.completion_requested,
    }) : null;
    const linkedMilestone = projectValues
      ? await validateLinkedMilestone(existing.student_id, projectValues.milestoneId)
      : null;
    const nextRevision = existing.current_revision + 1;
    stagedAttachments = await stageAttachments(id, existing.student_id, nextRevision, files);
    const operationToken = crypto.randomUUID();
    resubmitProgressId = id;
    resubmitRevision = nextRevision;
    resubmitOperationToken = operationToken;
    const snapshot = progressSnapshot(values, paperValues, projectValues, linkedMilestone, stagedAttachments, operationToken);
    const intentGuard = uploadIntentGuard(stagedAttachments, nextRevision);
    resubmitWriteAttempted = true;
    const [result] = await d1.batch([
      d1.prepare(`UPDATE progress_entries SET
        title = ?, summary = ?, evidence = ?, literature_ref = ?, git_url = ?,
        status = 'pending', review_status = 'submitted', assessment = NULL,
        reviewer_note = '', submitted_by_user_id = ?, reviewed_by_user_id = NULL, reviewed_at = NULL,
        current_revision = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND review_status = 'changes_requested' AND current_revision = ?${intentGuard.clause}`)
        .bind(
          values.title, values.summary, values.evidence, values.literatureRef, values.gitUrl,
          auth.user.id, nextRevision, id, existing.current_revision,
          ...intentGuard.bindings,
        ),
      d1.prepare(`INSERT INTO progress_revisions
        (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id, review_status)
        SELECT ?, ?, ?, ?, 'submitted' WHERE changes() > 0`)
        .bind(id, nextRevision, snapshot, auth.user.id),
      ...(await evidenceStatements(id, auth.user.id, nextRevision, values, operationToken)),
      ...(paperValues?.paperId ? [
        d1.prepare(`UPDATE paper_progress_details SET stage = ?, manuscript_version = ?,
          next_action = ?, next_action_due_date = ?, blocker = ?
          WHERE progress_entry_id = ? AND EXISTS (
            SELECT 1 FROM progress_revisions operation_revision
            WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
              AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
          )`)
          .bind(
            paperValues.stage, paperValues.manuscriptVersion, paperValues.nextAction,
            paperValues.nextActionDueDate, paperValues.blocker, id,
            id, nextRevision, operationToken,
          ),
      ] : []),
      ...(paperValues && !paperValues.paperId ? [
        d1.prepare(`UPDATE paper_submission_candidates SET
          title = ?, paper_type = ?, target_venue = ?, planned_submission_date = ?,
          stage = ?, manuscript_version = ?, next_action = ?, next_action_due_date = ?,
          blocker = ?, submission_identifier = ?, updated_at = CURRENT_TIMESTAMP
          WHERE progress_entry_id = ? AND EXISTS (
            SELECT 1 FROM progress_revisions operation_revision
            WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
              AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
          )`)
          .bind(
            paperValues.paperTitle, paperValues.paperType, paperValues.targetVenue,
            paperValues.plannedSubmissionDate, paperValues.stage, paperValues.manuscriptVersion,
            paperValues.nextAction, paperValues.nextActionDueDate, paperValues.blocker,
            paperValues.submissionIdentifier, id, id, nextRevision, operationToken,
          ),
      ] : []),
      ...(projectValues ? [
        d1.prepare(`INSERT INTO project_progress_details
          (progress_entry_id, milestone_id, milestone_title, milestone_target_date,
           evidence_target, proposal_version, next_action, next_action_due_date, blocker, completion_requested)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM progress_revisions operation_revision
            WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
              AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
          )
          ON CONFLICT(progress_entry_id) DO UPDATE SET
            milestone_id = excluded.milestone_id,
            milestone_title = excluded.milestone_title,
            milestone_target_date = excluded.milestone_target_date,
            evidence_target = excluded.evidence_target,
            proposal_version = excluded.proposal_version,
            next_action = excluded.next_action,
            next_action_due_date = excluded.next_action_due_date,
            blocker = excluded.blocker,
            completion_requested = excluded.completion_requested`)
          .bind(
            id, projectValues.milestoneId, linkedMilestone?.title ?? existing.project_milestone_title ?? "",
            linkedMilestone?.target_date ?? existing.project_milestone_target_date,
            linkedMilestone?.evidence_target ?? existing.project_evidence_target ?? "",
            linkedMilestone?.proposal_version ?? existing.project_proposal_version,
            projectValues.nextAction,
            projectValues.nextActionDueDate, projectValues.blocker,
            projectValues.completionRequested ? 1 : 0,
            id, nextRevision, operationToken,
          ),
      ] : []),
      ...(linkedMilestone && projectValues ? [
        d1.prepare(`INSERT INTO proposal_audit_events (proposal_id, actor_user_id, action, detail)
          SELECT ?, ?, 'progress_resubmitted', ? WHERE EXISTS (
            SELECT 1 FROM progress_revisions operation_revision
            WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
              AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
          )`)
          .bind(
            linkedMilestone.proposal_id,
            auth.user.id,
            `${linkedMilestone.title}：课题进展 #${id} 已补充${projectValues.completionRequested ? "，继续申请完成节点" : ""}`,
            id,
            nextRevision,
            operationToken,
          ),
      ] : []),
      ...attachmentStatements(id, auth.user.id, nextRevision, stagedAttachments, operationToken),
      d1.prepare(`INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
        SELECT ?, ?, 'user', 'resubmit', 'changes_requested', 'submitted', '补充证据并重新提交'
        WHERE EXISTS (
          SELECT 1 FROM progress_revisions operation_revision
          WHERE operation_revision.progress_entry_id = ? AND operation_revision.revision_number = ?
            AND json_extract(operation_revision.snapshot_json, '$._operationToken') = ?
        )`)
        .bind(id, auth.user.id, id, nextRevision, operationToken),
    ]);
    if (!result.meta.changes) {
      if (stagedAttachments.length) {
        const aborted = await abortProgressUploadIntents({
          progressId: id,
          revisionNumber: nextRevision,
          storageKeys: stagedAttachments.map((item) => item.storageKey),
        });
        if (!aborted.claimed) {
          stagedAttachments = [];
          return Response.json(
            { error: "记录状态已变化且附件处置权暂时无法确认，请刷新记录；附件不会被清理" },
            { status: 503 },
          );
        }
      }
      stagedAttachments = [];
      return Response.json({ error: "记录状态或版本已变化，请刷新后重试" }, { status: 409 });
    }
    stagedAttachments = [];
    return Response.json({ message: `补充证据已作为 V${nextRevision} 重新提交导师审核`, revision: nextRevision });
  } catch (error) {
    if (resubmitWriteAttempted && resubmitProgressId && resubmitRevision && resubmitOperationToken) {
      try {
        const committed = await findCommittedResubmission(
          resubmitProgressId,
          resubmitRevision,
          resubmitOperationToken,
        );
        if (committed) {
          stagedAttachments = [];
          return Response.json({
            message: `补充证据已作为 V${resubmitRevision} 重新提交导师审核`,
            revision: resubmitRevision,
            replayed: true,
          });
        }
      } catch {
        return Response.json(
          { error: "重新提交结果暂时无法确认，请稍后刷新记录；附件不会被清理" },
          { status: 503 },
        );
      }
    }
    if (resubmitWriteAttempted && stagedAttachments.length && resubmitProgressId && resubmitRevision) {
      try {
        const aborted = await abortProgressUploadIntents({
          progressId: resubmitProgressId,
          revisionNumber: resubmitRevision,
          storageKeys: stagedAttachments.map((item) => item.storageKey),
        });
        if (!aborted.claimed) {
          stagedAttachments = [];
          return Response.json(
            { error: "重新提交结果暂时无法确认，请稍后刷新记录；附件不会被清理" },
            { status: 503 },
          );
        }
        stagedAttachments = [];
      } catch {
        return Response.json(
          { error: "重新提交结果暂时无法确认，请稍后刷新记录；附件不会被清理" },
          { status: 503 },
        );
      }
    } else if (resubmitWriteAttempted) {
      // Without an upload-intent row there is no destructive compensation to
      // arbitrate with a late D1 commit. Report the result as unknown instead
      // of claiming that the resubmission failed.
      return Response.json(
        { error: "重新提交结果暂时无法确认，请稍后刷新记录" },
        { status: 503 },
      );
    } else {
      await deleteStagedAttachments(stagedAttachments, "progress_resubmit_failed").catch(() => undefined);
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "重新提交失败" },
      { status: error instanceof InputError || error instanceof AttachmentInputError ? 400 : 500 },
    );
  }
}
