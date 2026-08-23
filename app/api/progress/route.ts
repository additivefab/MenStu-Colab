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
  conditional = false,
) {
  const d1 = getD1();
  const statements = [];
  if (values.evidence) {
    statements.push(d1.prepare(conditional ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'manual', '提交时填写的核验证据', '', ?, ?, ? WHERE changes() > 0` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      VALUES (?, 'manual', '提交时填写的核验证据', '', ?, ?, ?)`)
      .bind(progressId, await sha256Text(values.evidence), revisionNumber, userId));
  }
  if (values.literatureRef) {
    statements.push(d1.prepare(conditional ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'doi', '论文或 DOI', ?, ?, ?, ? WHERE changes() > 0` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      VALUES (?, 'doi', '论文或 DOI', ?, ?, ?, ?)`)
      .bind(progressId, values.literatureRef, await sha256Text(values.literatureRef), revisionNumber, userId));
  }
  if (values.gitUrl) {
    statements.push(d1.prepare(conditional ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'git', 'Git 仓库或提交', ?, ?, ?, ? WHERE changes() > 0` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      VALUES (?, 'git', 'Git 仓库或提交', ?, ?, ?, ?)`)
      .bind(progressId, values.gitUrl, await sha256Text(values.gitUrl), revisionNumber, userId));
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
        fileName: item.fileName,
        contentType: item.contentType,
        sizeBytes: item.file.size,
        contentSha256,
      };
      staged.push(stagedItem);
      await bucket.put(storageKey, bytes, {
        httpMetadata: { contentType: item.contentType },
        customMetadata: { studentId, progressId: String(progressId), revisionNumber: String(revisionNumber) },
      });
    }
    return staged;
  } catch (error) {
    await Promise.allSettled(staged.map((item) => bucket.delete(item.storageKey)));
    throw error;
  }
}

async function deleteStagedAttachments(staged: StagedAttachment[]) {
  if (!staged.length) return;
  const bucket = getProgressFileBucket();
  await Promise.allSettled(staged.map((item) => bucket.delete(item.storageKey)));
}

function attachmentStatements(
  progressId: number,
  userId: number,
  revisionNumber: number,
  staged: StagedAttachment[],
  conditional = false,
) {
  const d1 = getD1();
  return staged.flatMap((item) => [
    d1.prepare(conditional ? `INSERT INTO progress_attachments
      (progress_entry_id, storage_key, file_name, content_type, size_bytes, content_sha256,
       revision_number, uploaded_by_user_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0` : `INSERT INTO progress_attachments
      (progress_entry_id, storage_key, file_name, content_type, size_bytes, content_sha256,
       revision_number, uploaded_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        progressId, item.storageKey, item.fileName, item.contentType, item.sizeBytes,
        item.contentSha256, revisionNumber, userId,
      ),
    d1.prepare(conditional ? `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'attachment', ?, '/api/progress/files?id=' || id, ?, ?, ?
      FROM progress_attachments WHERE storage_key = ? AND changes() > 0` : `INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      SELECT ?, 'attachment', ?, '/api/progress/files?id=' || id, ?, ?, ?
      FROM progress_attachments WHERE storage_key = ?`)
      .bind(
        progressId, `附件：${item.fileName}`, item.contentSha256,
        revisionNumber, userId, item.storageKey,
      ),
  ]);
}

function progressSnapshot(
  values: { kind: string; title: string; summary: string; evidence: string; literatureRef: string; gitUrl: string },
  paper: ReturnType<typeof paperProgressInput> | null,
  project: ReturnType<typeof projectProgressInput> | null,
  milestone: LinkedMilestone | null,
  attachments: StagedAttachment[],
) {
  return JSON.stringify({
    kind: values.kind,
    title: values.title,
    summary: values.summary,
    evidence: values.evidence,
    literatureRef: values.literatureRef,
    gitUrl: values.gitUrl,
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
    d1.prepare("DELETE FROM paper_progress_details WHERE progress_entry_id = ?").bind(progressId),
    d1.prepare("DELETE FROM project_progress_details WHERE progress_entry_id = ?").bind(progressId),
    d1.prepare("DELETE FROM progress_revisions WHERE progress_entry_id = ?").bind(progressId),
    d1.prepare("DELETE FROM progress_entries WHERE id = ?").bind(progressId),
  ]);
}

export async function POST(request: Request) {
  let createdId: number | null = null;
  let createdPaperId: number | null = null;
  let stagedAttachments: StagedAttachment[] = [];
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
    const structuredPaper = values.kind === "论文" && (
      auth.user.role === "student" || Boolean(String(body.paperStage ?? "").trim())
    );
    const paperValues = structuredPaper ? paperProgressInput(body) : null;
    const structuredProject = values.kind === "项目" && (
      auth.user.role === "student" || Boolean(String(body.nextAction ?? "").trim())
    );
    const projectValues = structuredProject ? projectProgressInput(body) : null;

    const d1 = getD1();
    if (auth.user.role !== "student" && !(await canViewStudent(auth.user, values.studentId))) {
      return Response.json({ error: "当前账号无权为该学生提交进展" }, { status: 403 });
    }
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1")
      .bind(values.studentId).first();
    if (!student) return Response.json({ error: "学生不存在" }, { status: 404 });
    const linkedMilestone = projectValues
      ? await validateLinkedMilestone(values.studentId, projectValues.milestoneId)
      : null;

    if (paperValues?.paperId) {
      const paper = await d1.prepare(`SELECT id FROM student_papers
        WHERE id = ? AND student_id = ? AND status != 'closed'`)
        .bind(paperValues.paperId, values.studentId).first();
      if (!paper) return Response.json({ error: "论文不存在或已关闭" }, { status: 404 });
    } else if (paperValues) {
      const paper = await d1.prepare(`INSERT INTO student_papers
        (student_id, title, paper_type, target_venue, planned_submission_date,
         current_stage, submission_identifier, status, latest_progress_at, created_by_user_id, updated_at)
        VALUES (?, ?, ?, ?, ?, 'planning', ?, 'active', NULL, ?, CURRENT_TIMESTAMP) RETURNING id`)
        .bind(
          values.studentId, paperValues.paperTitle, paperValues.paperType,
          paperValues.targetVenue, paperValues.plannedSubmissionDate,
          paperValues.submissionIdentifier, auth.user.id,
        ).first<{ id: number }>();
      createdPaperId = paper?.id ?? null;
      if (!createdPaperId) throw new Error("无法建立论文台账");
      paperValues.paperId = createdPaperId;
    }

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
    createdPaperId = null;
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
    await deleteStagedAttachments(stagedAttachments);
    if (createdId) {
      try { await deleteCreatedProgress(createdId); } catch { /* noop */ }
    }
    if (createdPaperId) {
      try { await getD1().prepare("DELETE FROM student_papers WHERE id = ?").bind(createdPaperId).run(); } catch { /* noop */ }
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "提交失败" },
      { status: error instanceof InputError || error instanceof AttachmentInputError ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request) {
  let stagedAttachments: StagedAttachment[] = [];
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
    const existing = await d1.prepare(`SELECT p.id, p.student_id, p.kind, p.title, p.review_status,
      p.current_revision,
      pd.paper_id, pd.stage AS paper_stage, pd.manuscript_version, pd.next_action,
      pd.next_action_due_date, pd.blocker, sp.submission_identifier,
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
      LEFT JOIN project_progress_details ppd ON ppd.progress_entry_id = p.id
      WHERE p.id = ?`).bind(id).first<{
        id: number; student_id: string; kind: string; title: string; review_status: string;
        current_revision: number;
        paper_id: number | null; paper_stage: string | null; manuscript_version: string | null;
        next_action: string | null; next_action_due_date: string | null; blocker: string | null;
        submission_identifier: string | null;
        project_milestone_id: number | null; project_next_action: string | null;
        project_next_action_due_date: string | null; project_blocker: string | null;
        completion_requested: number | null;
        project_milestone_title: string | null; project_milestone_target_date: string | null;
        project_evidence_target: string | null; project_proposal_version: number | null;
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
      kind: existing.kind,
      title: body.title ?? existing.title,
    }, files.length > 0);
    const paperValues = existing.paper_id ? paperProgressInput({
      ...body,
      paperId: existing.paper_id,
      paperStage: body.paperStage ?? existing.paper_stage,
      manuscriptVersion: body.manuscriptVersion ?? existing.manuscript_version,
      nextAction: body.nextAction ?? existing.next_action,
      nextActionDueDate: body.nextActionDueDate ?? existing.next_action_due_date,
      blocker: body.blocker ?? existing.blocker,
      submissionIdentifier: body.submissionIdentifier ?? existing.submission_identifier,
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
    const snapshot = progressSnapshot(values, paperValues, projectValues, linkedMilestone, stagedAttachments);
    const [result] = await d1.batch([
      d1.prepare(`UPDATE progress_entries SET
        title = ?, summary = ?, evidence = ?, literature_ref = ?, git_url = ?,
        status = 'pending', review_status = 'submitted', assessment = NULL,
        reviewer_note = '', submitted_by_user_id = ?, reviewed_by_user_id = NULL, reviewed_at = NULL,
        current_revision = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND review_status = 'changes_requested' AND current_revision = ?`)
        .bind(
          values.title, values.summary, values.evidence, values.literatureRef, values.gitUrl,
          auth.user.id, nextRevision, id, existing.current_revision,
        ),
      d1.prepare(`INSERT INTO progress_revisions
        (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id, review_status)
        SELECT ?, ?, ?, ?, 'submitted' WHERE changes() > 0`)
        .bind(id, nextRevision, snapshot, auth.user.id),
      ...(await evidenceStatements(id, auth.user.id, nextRevision, values, true)),
      ...(paperValues?.paperId ? [
        d1.prepare(`UPDATE paper_progress_details SET stage = ?, manuscript_version = ?,
          next_action = ?, next_action_due_date = ?, blocker = ?
          WHERE progress_entry_id = ? AND changes() > 0`)
          .bind(
            paperValues.stage, paperValues.manuscriptVersion, paperValues.nextAction,
            paperValues.nextActionDueDate, paperValues.blocker, id,
          ),
      ] : []),
      ...(projectValues ? [
        d1.prepare(`INSERT INTO project_progress_details
          (progress_entry_id, milestone_id, milestone_title, milestone_target_date,
           evidence_target, proposal_version, next_action, next_action_due_date, blocker, completion_requested)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0
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
          ),
      ] : []),
      ...(linkedMilestone && projectValues ? [
        d1.prepare(`INSERT INTO proposal_audit_events (proposal_id, actor_user_id, action, detail)
          SELECT ?, ?, 'progress_resubmitted', ? WHERE changes() > 0`)
          .bind(
            linkedMilestone.proposal_id,
            auth.user.id,
            `${linkedMilestone.title}：课题进展 #${id} 已补充${projectValues.completionRequested ? "，继续申请完成节点" : ""}`,
          ),
      ] : []),
      ...attachmentStatements(id, auth.user.id, nextRevision, stagedAttachments, true),
      d1.prepare(`INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
        SELECT ?, ?, 'user', 'resubmit', 'changes_requested', 'submitted', '补充证据并重新提交'
        WHERE changes() > 0`)
        .bind(id, auth.user.id),
    ]);
    if (!result.meta.changes) {
      await deleteStagedAttachments(stagedAttachments);
      stagedAttachments = [];
      return Response.json({ error: "记录状态或版本已变化，请刷新后重试" }, { status: 409 });
    }
    stagedAttachments = [];
    return Response.json({ message: `补充证据已作为 V${nextRevision} 重新提交导师审核`, revision: nextRevision });
  } catch (error) {
    await deleteStagedAttachments(stagedAttachments);
    return Response.json(
      { error: error instanceof Error ? error.message : "重新提交失败" },
      { status: error instanceof InputError || error instanceof AttachmentInputError ? 400 : 500 },
    );
  }
}
