import { aiRecordCondition } from "./ai-record-deletion";
import { canReviewStudent, canViewStudent } from "./authorization";
import type { AppUser } from "./feishu-auth";
import { notifyLoopEvent } from "./loop-notifications";
import { canCodeReviewStudent } from "./review-delegation";
import {
  taskSnapshotSha256, type ResearchTaskSnapshot, type ResearchTaskStatus, type TaskBudget,
} from "./research-loop/contracts";
import {
  buildTaskSnapshot, createResearchTask, parseTaskContent, TaskInputError, type TaskContent,
} from "./research-loop/tasks-core";

// Research tasks (docs/科研闭环_实施规格_v1.md §6.1). Versions are immutable;
// a revision appends a draft version while confirmed_version keeps pointing at
// the previously confirmed one so in-flight agent attempts keep their snapshot.

/** Error with an HTTP status and a Chinese user-facing message. */
export class ResearchLoopHttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const inputError = (message: string) => new ResearchLoopHttpError(400, "INVALID_INPUT", message);
export const conflictError = (message: string, code = "CONFLICT") => new ResearchLoopHttpError(409, code, message);
export const forbiddenError = (message: string) => new ResearchLoopHttpError(403, "FORBIDDEN", message);
export const notFoundError = (message: string) => new ResearchLoopHttpError(404, "NOT_FOUND", message);

export function isConstraintError(error: unknown) {
  return /constraint|UNIQUE/i.test(error instanceof Error ? error.message : String(error));
}

const MUTATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function parseMutationId(value: unknown, label = "mutationId", required = true): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw inputError(`缺少${label}，请刷新页面后重试`);
    return null;
  }
  if (typeof value !== "string" || !MUTATION_ID.test(value)) throw inputError(`${label}格式无效`);
  return value;
}

export function parseEntityId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ENTITY_ID.test(value.trim())) throw inputError(`${label}参数无效`);
  return value.trim();
}

function parseVersionNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw inputError(`${label}参数无效，请刷新后重试`);
  return value;
}

function parseContent(body: Record<string, unknown>): TaskContent {
  try { return parseTaskContent(body); }
  catch (error) {
    if (error instanceof TaskInputError) throw inputError(error.message);
    throw error;
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type TaskRow = {
  id: string;
  student_id: string;
  source_guidance_note_id: number | null;
  source_run_id: string | null;
  parent_task_id: string | null;
  title: string;
  status: ResearchTaskStatus;
  current_version: number;
  confirmed_version: number | null;
  created_by_user_id: number;
  last_mutation_id: string;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  task_id: string;
  version: number;
  title: string;
  research_question: string;
  hypothesis: string;
  instructions: string;
  acceptance_criteria: string;
  allowed_paths_json: string;
  protected_paths_json: string;
  budget_json: string;
  snapshot_sha256: string;
  author_user_id: number;
  confirmed_by_user_id: number | null;
  confirmed_at: string | null;
  created_at: string;
};

type EventRow = {
  id: number;
  task_id: string;
  version: number;
  action: string;
  actor_type: string;
  actor_user_id: number | null;
  payload_json: string;
  created_at: string;
};

const TASK_COLUMNS = `id, student_id, source_guidance_note_id, source_run_id, parent_task_id, title, status,
  current_version, confirmed_version, created_by_user_id, last_mutation_id, created_at, updated_at`;

/** Progress entry (including an AI meeting summary) a task was quoted from.
 * Read from the task's `created` event payload; no column exists for it. */
export type TaskSourceProgress = {
  entryId: number;
  revision: number;
  /** Empty when the entry is no longer available (e.g. a deleted AI record). */
  title: string;
  kind: string;
  aiSummary: boolean;
  available: boolean;
};

export function taskSummary(row: TaskRow, sourceProgress: TaskSourceProgress | null = null) {
  return {
    id: row.id,
    studentId: row.student_id,
    title: row.title,
    status: row.status,
    currentVersion: Number(row.current_version),
    confirmedVersion: row.confirmed_version === null ? null : Number(row.confirmed_version),
    sourceGuidanceNoteId: row.source_guidance_note_id,
    sourceRunId: row.source_run_id,
    parentTaskId: row.parent_task_id,
    sourceProgress,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function readTaskRow(d1: D1Database, taskId: string) {
  return d1.prepare(`SELECT ${TASK_COLUMNS} FROM research_tasks WHERE id = ?`).bind(taskId).first<TaskRow>();
}

/** Loads a task the user may view. Missing and out-of-scope tasks look the
 * same so a student cannot probe other students' task ids (T01). */
export async function requireVisibleTask(d1: D1Database, user: AppUser, taskId: string) {
  const task = await readTaskRow(d1, taskId);
  if (!task || !(await canViewStudent(user, task.student_id))) throw notFoundError("研究任务不存在或无权查看");
  return task;
}

/** Read-only access to a student's research-loop tasks: viewers of the
 * student, plus delegated peer code reviewers (FB1). Never used for writes. */
export async function canReadStudentTasks(d1: D1Database, user: AppUser, studentId: string) {
  return (await canViewStudent(user, studentId)) || canCodeReviewStudent(d1, user, studentId);
}

/** Like requireVisibleTask but also admits delegated peer reviewers. Reads only. */
export async function requireReadableTask(d1: D1Database, user: AppUser, taskId: string) {
  const task = await readTaskRow(d1, taskId);
  if (!task || !(await canReadStudentTasks(d1, user, task.student_id))) throw notFoundError("研究任务不存在或无权查看");
  return task;
}

/** Owner student (student persona) or a reviewer in scope may confirm/close. */
export async function canDecideTask(user: AppUser, studentId: string) {
  if (user.role === "student" && user.studentId === studentId) return true;
  return canReviewStudent(user, studentId);
}

async function requireActiveStudent(d1: D1Database, studentId: string) {
  const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
  if (!student) throw notFoundError("学生不存在或已停用");
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function contentFromVersion(row: VersionRow): TaskContent {
  return {
    title: row.title,
    researchQuestion: row.research_question,
    hypothesis: row.hypothesis,
    instructions: row.instructions,
    acceptanceCriteria: row.acceptance_criteria,
    allowedPaths: parseJson<string[]>(row.allowed_paths_json, []),
    protectedPaths: parseJson<string[]>(row.protected_paths_json, []),
    budget: parseJson<TaskBudget>(row.budget_json, {}),
  };
}

export class TaskSnapshotMismatchError extends Error {}

/** Rebuilds the canonical snapshot of one task version from its immutable row
 * and verifies it against the stored snapshot hash. */
export async function loadTaskVersionSnapshot(d1: D1Database, taskId: string, version: number): Promise<{
  snapshot: ResearchTaskSnapshot;
  snapshotSha256: string;
}> {
  const [task, row] = await Promise.all([
    readTaskRow(d1, taskId),
    d1.prepare("SELECT * FROM research_task_versions WHERE task_id = ? AND version = ?").bind(taskId, version).first<VersionRow>(),
  ]);
  if (!task || !row) throw new TaskSnapshotMismatchError("任务版本不存在");
  const snapshot = buildTaskSnapshot({ taskId, version, studentId: task.student_id, content: contentFromVersion(row) });
  const snapshotSha256 = await taskSnapshotSha256(snapshot);
  if (snapshotSha256 !== row.snapshot_sha256) throw new TaskSnapshotMismatchError("任务快照哈希不一致");
  return { snapshot, snapshotSha256 };
}

// ---------------------------------------------------------------------------
// Quoted progress entries (design pack 02 §3/§10: 消息可"引用为任务")
// ---------------------------------------------------------------------------

type SourceProgressRow = {
  task_id: string;
  entry_id: number;
  revision: number;
  title: string | null;
  kind: string | null;
  ai_summary: number | null;
  available: number | null;
};

/** Source progress of every quoted task of one student, or of one task. The
 * entry must still belong to the task's student; a deleted record keeps its id
 * but loses its title so the reference never resurrects hidden content. */
async function loadSourceProgress(d1: D1Database, scope: { studentId: string } | { taskId: string }) {
  const where = "studentId" in scope ? "t.student_id = ?" : "t.id = ?";
  const { results } = await d1.prepare(`SELECT q.task_id, q.entry_id, q.revision, p.title, p.kind,
      CASE WHEN p.id IS NULL THEN 0 WHEN ${aiRecordCondition} THEN 1 ELSE 0 END AS ai_summary,
      CASE WHEN p.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)
        THEN 1 ELSE 0 END AS available
    FROM (SELECT e.task_id, t.student_id,
        CAST(json_extract(e.payload_json, '$.sourceProgressEntryId') AS INTEGER) AS entry_id,
        CAST(json_extract(e.payload_json, '$.sourceProgressRevision') AS INTEGER) AS revision
      FROM research_task_events e JOIN research_tasks t ON t.id = e.task_id
      WHERE ${where} AND e.action = 'created' AND json_valid(e.payload_json)
        AND json_extract(e.payload_json, '$.sourceProgressEntryId') IS NOT NULL) q
    LEFT JOIN progress_entries p ON p.id = q.entry_id AND p.student_id = q.student_id`)
    .bind("studentId" in scope ? scope.studentId : scope.taskId).all<SourceProgressRow>();
  const byTask = new Map<string, TaskSourceProgress>();
  for (const row of results) {
    const available = Boolean(row.available);
    byTask.set(row.task_id, {
      entryId: Number(row.entry_id),
      revision: Number(row.revision),
      title: available ? row.title ?? "" : "",
      kind: available ? row.kind ?? "" : "",
      aiSummary: available && Boolean(row.ai_summary),
      available,
    });
  }
  return byTask;
}

function parsePositiveInt(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw inputError(`${label}参数无效`);
  return value;
}

/** Validates a quoted progress entry: same student, not deleted, with a stored
 * current revision (the dashboard's visibility rule; the caller already passed
 * canViewStudent). Missing, foreign and deleted entries look the same. */
async function resolveSourceProgress(d1: D1Database, studentId: string, body: Record<string, unknown>) {
  const hasRevision = body.sourceProgressRevision !== undefined && body.sourceProgressRevision !== null;
  if (body.sourceProgressEntryId === undefined || body.sourceProgressEntryId === null) {
    if (hasRevision) throw inputError("进展版本需与进展记录一起提供");
    return null;
  }
  const entryId = parsePositiveInt(body.sourceProgressEntryId, "进展记录");
  const requested = hasRevision ? parsePositiveInt(body.sourceProgressRevision, "进展版本") : null;
  const entry = await d1.prepare(`SELECT p.id, p.current_revision FROM progress_entries p
    WHERE p.id = ? AND p.student_id = ?
      AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)
      AND EXISTS (SELECT 1 FROM progress_revisions r WHERE r.progress_entry_id = p.id AND r.revision_number = p.current_revision)`)
    .bind(entryId, studentId).first<{ id: number; current_revision: number }>();
  if (!entry) throw notFoundError("进展记录不存在、已删除或不属于该学生");
  if (requested !== null && requested !== Number(entry.current_revision)) {
    const stored = await d1.prepare("SELECT 1 AS ok FROM progress_revisions WHERE progress_entry_id = ? AND revision_number = ?")
      .bind(entryId, requested).first();
    if (!stored) throw notFoundError("引用的进展版本不存在，请刷新后重试");
  }
  return { sourceProgressEntryId: entryId, sourceProgressRevision: requested ?? Number(entry.current_revision) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listResearchTasks(d1: D1Database, studentId: string) {
  const [{ results }, sources] = await Promise.all([
    d1.prepare(`SELECT ${TASK_COLUMNS} FROM research_tasks
      WHERE student_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 200`).bind(studentId).all<TaskRow>(),
    loadSourceProgress(d1, { studentId }),
  ]);
  return results.map((row) => taskSummary(row, sources.get(row.id) ?? null));
}

export async function researchTaskDetail(d1: D1Database, user: AppUser, taskId: string) {
  // Delegated peer reviewers may read; every permission below still derives
  // from canViewStudent / canDecideTask, so they stay false for them.
  const task = await requireReadableTask(d1, user, taskId);
  const [versions, events, attempts, changeRequests, profiles, sources] = await Promise.all([
    d1.prepare("SELECT * FROM research_task_versions WHERE task_id = ? ORDER BY version").bind(taskId).all<VersionRow>(),
    d1.prepare("SELECT * FROM research_task_events WHERE task_id = ? ORDER BY id").bind(taskId).all<EventRow>(),
    d1.prepare(`SELECT id, task_version, provider, model_id, status, base_commit_sha, error_code, error_message,
      requested_by_user_id, created_at, started_at, ended_at, updated_at
      FROM agent_attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`).bind(taskId)
      .all<Record<string, string | number | null>>(),
    d1.prepare(`SELECT id, attempt_id, status, branch_name, requires_extra_review, pr_number, pr_url, head_commit_sha,
      version, created_at, updated_at FROM change_requests WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`)
      .bind(taskId).all<Record<string, string | number | null>>(),
    d1.prepare(`SELECT p.provider FROM agent_credential_profiles p JOIN lab_runners r ON r.id = p.worker_id
      WHERE p.user_id = ? AND p.active = 1 AND r.status = 'active' AND r.kind = 'agent' ORDER BY p.provider`)
      .bind(user.id).all<{ provider: string }>(),
    loadSourceProgress(d1, { taskId }),
  ]);
  const sourceProgress = sources.get(taskId) ?? null;
  const canEdit = await canViewStudent(user, task.student_id);
  const canDecide = await canDecideTask(user, task.student_id);
  const open = task.status === "draft" || task.status === "confirmed";
  return {
    task: taskSummary(task, sourceProgress),
    sourceProgress,
    versions: versions.results.map((row) => ({
      version: Number(row.version),
      title: row.title,
      researchQuestion: row.research_question,
      hypothesis: row.hypothesis,
      instructions: row.instructions,
      acceptanceCriteria: row.acceptance_criteria,
      allowedPaths: parseJson<string[]>(row.allowed_paths_json, []),
      protectedPaths: parseJson<string[]>(row.protected_paths_json, []),
      budget: parseJson<TaskBudget>(row.budget_json, {}),
      snapshotSha256: row.snapshot_sha256,
      authorUserId: row.author_user_id,
      confirmedByUserId: row.confirmed_by_user_id,
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
    })),
    events: events.results.map((row) => ({
      id: row.id,
      version: Number(row.version),
      action: row.action,
      actorType: row.actor_type,
      actorUserId: row.actor_user_id,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at,
    })),
    attempts: attempts.results.map((row) => ({
      id: row.id,
      taskVersion: Number(row.task_version),
      provider: row.provider,
      modelId: row.model_id,
      status: row.status,
      baseCommitSha: row.base_commit_sha,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      requestedByUserId: row.requested_by_user_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      updatedAt: row.updated_at,
    })),
    changeRequests: changeRequests.results.map((row) => ({
      id: row.id,
      attemptId: row.attempt_id,
      status: row.status,
      branchName: row.branch_name,
      requiresExtraReview: Boolean(row.requires_extra_review),
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      headCommitSha: row.head_commit_sha,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    permissions: {
      canRevise: canEdit && open,
      canConfirm: canDecide && task.status === "draft",
      canClose: canDecide && open && task.confirmed_version !== null,
      canCancel: canEdit && open,
      canStartAttempt: canEdit && task.status === "confirmed" && profiles.results.length > 0,
      providers: profiles.results.map((item) => item.provider),
    },
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createTask(d1: D1Database, user: AppUser, body: Record<string, unknown>) {
  const studentId = parseEntityId(body.studentId, "学生");
  const mutationId = parseMutationId(body.mutationId) as string;
  if (!(await canViewStudent(user, studentId))) throw forbiddenError("无权为该学生创建研究任务");
  await requireActiveStudent(d1, studentId);
  let sourceGuidanceNoteId: number | null = null;
  if (body.sourceGuidanceNoteId !== undefined && body.sourceGuidanceNoteId !== null) {
    if (typeof body.sourceGuidanceNoteId !== "number" || !Number.isSafeInteger(body.sourceGuidanceNoteId) || body.sourceGuidanceNoteId < 1) {
      throw inputError("导师意见参数无效");
    }
    // The actor already passed canViewStudent; the note must belong to this student.
    const note = await d1.prepare("SELECT id FROM student_guidance_notes WHERE id = ? AND student_id = ?")
      .bind(body.sourceGuidanceNoteId, studentId).first();
    if (!note) throw notFoundError("导师意见不存在或不属于该学生");
    sourceGuidanceNoteId = body.sourceGuidanceNoteId;
  }
  const sourceProgress = await resolveSourceProgress(d1, studentId, body);
  const content = parseContent(body);
  const existing = await d1.prepare(`SELECT ${TASK_COLUMNS} FROM research_tasks WHERE create_mutation_id = ?`)
    .bind(mutationId).first<TaskRow>();
  if (existing) {
    if (existing.student_id !== studentId || existing.created_by_user_id !== user.id) {
      throw conflictError("该提交标识已被使用，请刷新页面后重试");
    }
    const sources = await loadSourceProgress(d1, { taskId: existing.id });
    return { task: taskSummary(existing, sources.get(existing.id) ?? null), replayed: true };
  }
  try {
    await createResearchTask(d1, {
      studentId, authorUserId: user.id, mutationId, content, sourceGuidanceNoteId,
      ...(sourceProgress ? { eventPayloadExtra: sourceProgress } : {}),
    });
  } catch (error) {
    if (!isConstraintError(error)) throw error;
  }
  const row = await d1.prepare(`SELECT ${TASK_COLUMNS} FROM research_tasks WHERE create_mutation_id = ?`)
    .bind(mutationId).first<TaskRow>();
  if (!row || row.student_id !== studentId || row.created_by_user_id !== user.id) {
    throw conflictError("研究任务创建冲突，请刷新页面后重试");
  }
  await notifyLoopEvent(d1, { kind: "task_draft", taskId: row.id, actorUserId: user.id });
  const sources = sourceProgress ? await loadSourceProgress(d1, { taskId: row.id }) : null;
  return { task: taskSummary(row, sources?.get(row.id) ?? null), replayed: false };
}

function replayOf(task: TaskRow, mutationId: string | null) {
  if (mutationId && task.last_mutation_id === mutationId) return { task: taskSummary(task), replayed: true };
  return null;
}

export async function reviseTask(d1: D1Database, user: AppUser, body: Record<string, unknown>) {
  const taskId = parseEntityId(body.taskId, "任务");
  const expectedVersion = parseVersionNumber(body.expectedVersion, "任务版本");
  const mutationId = parseMutationId(body.mutationId, "mutationId", false);
  const task = await requireVisibleTask(d1, user, taskId);
  const replay = replayOf(task, mutationId);
  if (replay) return replay;
  if (task.status !== "draft" && task.status !== "confirmed") throw conflictError("任务已关闭或取消，不能再修改");
  if (Number(task.current_version) !== expectedVersion) throw conflictError("任务已被其他人更新，请载入最新版本后再修改");
  const content = parseContent(body);
  const version = expectedVersion + 1;
  const snapshot = buildTaskSnapshot({ taskId, version, studentId: task.student_id, content });
  const snapshotSha256 = await taskSnapshotSha256(snapshot);
  const marker = mutationId ?? crypto.randomUUID();
  let results: D1Result<TaskRow>[];
  try {
    results = await d1.batch<TaskRow>([
      d1.prepare(`UPDATE research_tasks SET title = ?, status = 'draft', current_version = ?, last_mutation_id = ?,
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND current_version = ? AND status IN ('draft', 'confirmed')
        RETURNING ${TASK_COLUMNS}`)
        .bind(content.title, version, marker, taskId, expectedVersion),
      d1.prepare(`INSERT INTO research_task_versions
        (task_id, version, title, research_question, hypothesis, instructions, acceptance_criteria,
         allowed_paths_json, protected_paths_json, budget_json, snapshot_sha256, author_user_id)
        SELECT id, current_version, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM research_tasks WHERE id = ? AND last_mutation_id = ?`)
        .bind(content.title, content.researchQuestion, content.hypothesis, content.instructions, content.acceptanceCriteria,
          JSON.stringify(content.allowedPaths), JSON.stringify(content.protectedPaths), JSON.stringify(content.budget),
          snapshotSha256, user.id, taskId, marker),
      d1.prepare(`INSERT INTO research_task_events (task_id, version, action, actor_type, actor_user_id, payload_json)
        SELECT id, current_version, 'revised', 'user', ?, ? FROM research_tasks WHERE id = ? AND last_mutation_id = ?`)
        .bind(user.id, JSON.stringify({
          snapshotSha256, title: content.title, previousTitle: task.title, previousStatus: task.status,
          confirmedVersion: task.confirmed_version, mutationId: marker,
        }), taskId, marker),
    ]);
  } catch (error) {
    if (isConstraintError(error)) throw conflictError("任务已被其他人更新，请载入最新版本后再修改");
    throw error;
  }
  const row = results[0].results[0];
  if (!row) throw conflictError("任务已被其他人更新，请载入最新版本后再修改");
  return { task: taskSummary(row), replayed: false };
}

export async function confirmTask(d1: D1Database, user: AppUser, body: Record<string, unknown>) {
  const taskId = parseEntityId(body.taskId, "任务");
  const version = parseVersionNumber(body.version, "任务版本");
  const mutationId = parseMutationId(body.mutationId, "mutationId", false);
  const task = await requireVisibleTask(d1, user, taskId);
  if (!(await canDecideTask(user, task.student_id))) throw forbiddenError("只有学生本人或有审核权限的导师可以确认任务");
  const replay = replayOf(task, mutationId);
  if (replay) return replay;
  if (task.status === "confirmed" && Number(task.confirmed_version) === version) return { task: taskSummary(task), replayed: true };
  if (task.status !== "draft") throw conflictError("只有草稿状态的任务可以确认");
  if (Number(task.current_version) !== version) throw conflictError("任务已被修改，请审阅最新版本后再确认");
  const versionRow = await d1.prepare("SELECT snapshot_sha256 FROM research_task_versions WHERE task_id = ? AND version = ?")
    .bind(taskId, version).first<{ snapshot_sha256: string }>();
  if (!versionRow) throw conflictError("任务版本不存在，请刷新后重试");
  const marker = mutationId ?? crypto.randomUUID();
  let results: D1Result<TaskRow>[];
  try {
    results = await d1.batch<TaskRow>([
      d1.prepare(`UPDATE research_tasks SET status = 'confirmed', confirmed_version = current_version,
        last_mutation_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND current_version = ? AND status = 'draft'
        RETURNING ${TASK_COLUMNS}`)
        .bind(marker, taskId, version),
      d1.prepare(`UPDATE research_task_versions SET confirmed_by_user_id = ?, confirmed_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND version = ? AND EXISTS (SELECT 1 FROM research_tasks WHERE id = ? AND last_mutation_id = ?)`)
        .bind(user.id, taskId, version, taskId, marker),
      d1.prepare(`INSERT INTO research_task_events (task_id, version, action, actor_type, actor_user_id, payload_json)
        SELECT id, current_version, 'confirmed', 'user', ?, ? FROM research_tasks WHERE id = ? AND last_mutation_id = ?`)
        .bind(user.id, JSON.stringify({
          snapshotSha256: versionRow.snapshot_sha256, title: task.title,
          previousConfirmedVersion: task.confirmed_version, mutationId: marker,
        }), taskId, marker),
    ]);
  } catch (error) {
    if (isConstraintError(error)) throw conflictError("任务已被其他人更新，请刷新后重试");
    throw error;
  }
  const row = results[0].results[0];
  if (!row) throw conflictError("任务已被其他人更新，请刷新后重试");
  return { task: taskSummary(row), replayed: false };
}

/** close: finished (requires a confirmed version); cancel: abandoned. Both stop
 * new agent work: queued attempts are canceled and running ones get
 * cancel_requested in the same batch (the worker sees it on heartbeat). */
export async function endTask(d1: D1Database, user: AppUser, body: Record<string, unknown>, action: "close" | "cancel") {
  const taskId = parseEntityId(body.taskId, "任务");
  const mutationId = parseMutationId(body.mutationId, "mutationId", false);
  const task = await requireVisibleTask(d1, user, taskId);
  if (action === "close" && !(await canDecideTask(user, task.student_id))) {
    throw forbiddenError("只有学生本人或有审核权限的导师可以关闭任务");
  }
  const replay = replayOf(task, mutationId);
  if (replay) return replay;
  const target: ResearchTaskStatus = action === "close" ? "closed" : "canceled";
  if (task.status === target) return { task: taskSummary(task), replayed: true };
  if (task.status !== "draft" && task.status !== "confirmed") throw conflictError("任务已关闭或取消");
  if (action === "close" && task.confirmed_version === null) throw conflictError("任务尚未确认，不能关闭；如不再需要请取消");
  const expected = body.expectedVersion === undefined ? Number(task.current_version) : parseVersionNumber(body.expectedVersion, "任务版本");
  const marker = mutationId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const code = action === "close" ? "TASK_CLOSED" : "TASK_CANCELED";
  const message = action === "close" ? "研究任务已关闭" : "研究任务已取消";
  let results: D1Result<TaskRow>[];
  try {
    results = await d1.batch<TaskRow>([
      d1.prepare(`UPDATE research_tasks SET status = ?, last_mutation_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND current_version = ? AND status IN ('draft', 'confirmed')
        RETURNING ${TASK_COLUMNS}`)
        .bind(target, marker, taskId, expected),
      d1.prepare(`INSERT INTO research_task_events (task_id, version, action, actor_type, actor_user_id, payload_json)
        SELECT id, current_version, ?, 'user', ?, ? FROM research_tasks WHERE id = ? AND last_mutation_id = ?`)
        .bind(target, user.id, JSON.stringify({ previousStatus: task.status, mutationId: marker }), taskId, marker),
      d1.prepare(`UPDATE agent_attempts SET status = 'canceled', error_code = ?, error_message = ?,
        cancel_requested_at = ?, cancel_requested_by_user_id = ?, ended_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND status = 'queued' AND EXISTS (SELECT 1 FROM research_tasks WHERE id = ? AND last_mutation_id = ?)`)
        .bind(code, message, now, user.id, now, taskId, taskId, marker),
      d1.prepare(`UPDATE agent_attempts SET status = 'cancel_requested', error_code = ?, error_message = ?,
        cancel_requested_at = ?, cancel_requested_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND status IN ('running', 'waiting_approval')
          AND EXISTS (SELECT 1 FROM research_tasks WHERE id = ? AND last_mutation_id = ?)`)
        .bind(code, message, now, user.id, taskId, taskId, marker),
    ]);
  } catch (error) {
    if (isConstraintError(error)) throw conflictError("任务已被其他人更新，请刷新后重试");
    throw error;
  }
  const row = results[0].results[0];
  if (!row) throw conflictError("任务已被其他人更新，请刷新后重试");
  return { task: taskSummary(row), replayed: false };
}

// ---------------------------------------------------------------------------
// HTTP helpers shared by the research-loop routes owned by this workstream
// ---------------------------------------------------------------------------

export function privateJson(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function privateResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function researchLoopFailure(error: unknown, fallback: string) {
  if (error instanceof ResearchLoopHttpError) return privateJson({ code: error.code, error: error.message, ...error.extra }, error.status);
  console.error(fallback, error instanceof Error ? error.message : String(error));
  return privateJson({ code: "INTERNAL", error: fallback }, 500);
}

export async function readJsonBody(request: Request, maxBytes = 64_000): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ResearchLoopHttpError(413, "PAYLOAD_TOO_LARGE", "请求内容过大");
  let text: string;
  try { text = await request.text(); } catch { throw inputError("请求内容无效"); }
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ResearchLoopHttpError(413, "PAYLOAD_TOO_LARGE", "请求内容过大");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw inputError("请求内容无效"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw inputError("请求内容无效");
  return body as Record<string, unknown>;
}
