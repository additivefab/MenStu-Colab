// Run reads, artifact access and result review (docs/科研闭环_实施规格_v1.md §6.3).
import { canReviewStudent, canViewStudent } from "./authorization";
import type { AppUser } from "./feishu-auth";
import { HYPOTHESIS_OUTCOMES, REVIEW_STATES, TERMINAL_RUN_STATUSES, type HypothesisOutcome, type ReviewState } from "./research-loop/contracts.ts";
import { createResearchTask, parseTaskContent, TaskInputError } from "./research-loop/tasks-core.ts";
import {
  RunServiceError, contentTypeFor, datasetView, entrypointView, getRunArtifactBucket, idempotencyKey, loadRun, loadSpec,
  type RunRow,
} from "./run-registry-service";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new RunServiceError(400, `${label}无效`, "INVALID_INPUT");
  return value;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

type SummaryRow = RunRow & {
  executed_commit_sha: string; entrypoint_id: string; dataset_version_id: string; change_request_id: string | null;
  technical_validity: string | null; review_state: string | null;
};

const SUMMARY_SQL = `SELECT r.*, s.executed_commit_sha, s.entrypoint_id, s.dataset_version_id, s.change_request_id,
    res.technical_validity, rev.state AS review_state
  FROM runs r
  JOIN run_specs s ON s.sha256 = r.run_spec_sha256
  LEFT JOIN run_results res ON res.run_id = r.id
  LEFT JOIN result_reviews rev ON rev.run_id = r.id`;

function runSummary(row: SummaryRow) {
  return {
    id: row.id, attempt: row.attempt, status: row.status, taskId: row.task_id, studentId: row.student_id,
    runSpecSha256: row.run_spec_sha256, approvalId: row.approval_id, submitTag: row.submit_tag, runnerId: row.runner_id,
    leaseEpoch: row.lease_epoch, schedulerJobId: row.scheduler_job_id, exitCode: row.exit_code, failureReason: row.failure_reason,
    cancelRequestedAt: row.cancel_requested_at, createdByUserId: row.created_by_user_id, createdAt: row.created_at,
    queuedAt: row.queued_at, startedAt: row.started_at, endedAt: row.ended_at, updatedAt: row.updated_at,
    executedCommitSha: row.executed_commit_sha, entrypointId: row.entrypoint_id, datasetVersionId: row.dataset_version_id,
    changeRequestId: row.change_request_id, technicalValidity: row.technical_validity, reviewState: row.review_state,
  };
}

async function viewableStudent(actor: AppUser, studentId: string) {
  if (!(await canViewStudent(actor, studentId))) throw new RunServiceError(403, "无权查看该学生的运行", "FORBIDDEN");
}

export async function listRuns(d1: D1Database, actor: AppUser, query: { taskId?: string | null; studentId?: string | null }) {
  if (query.taskId) {
    const taskId = identifier(query.taskId, "研究任务");
    const task = await d1.prepare("SELECT student_id FROM research_tasks WHERE id = ?").bind(taskId).first<{ student_id: string }>();
    if (!task) throw new RunServiceError(404, "研究任务不存在", "NOT_FOUND");
    await viewableStudent(actor, task.student_id);
    const { results } = await d1.prepare(`${SUMMARY_SQL} WHERE r.task_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 200`)
      .bind(taskId).all<SummaryRow>();
    return { runs: results.map(runSummary) };
  }
  const studentId = identifier(query.studentId, "学生");
  await viewableStudent(actor, studentId);
  const [runs, entrypoints, datasets] = await Promise.all([
    d1.prepare(`${SUMMARY_SQL} WHERE r.student_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 200`).bind(studentId).all<SummaryRow>(),
    d1.prepare(`SELECT e.*, l.student_id FROM registered_entrypoints e
      JOIN repository_links l ON l.github_repository_id = e.github_repository_id AND l.status = 'active'
      WHERE l.student_id = ? AND e.active = 1 ORDER BY e.name, e.id`).bind(studentId).all<Record<string, unknown>>(),
    d1.prepare(`SELECT d.* FROM dataset_versions d JOIN dataset_grants g ON g.dataset_version_id = d.id
      WHERE g.student_id = ? AND g.revoked_at IS NULL AND d.active = 1 ORDER BY d.label, d.id`).bind(studentId).all<Record<string, unknown>>(),
  ]);
  return {
    runs: runs.results.map(runSummary),
    // Options for the create form: what this student may run on.
    options: { entrypoints: entrypoints.results.map(entrypointView), datasets: datasets.results.map(datasetView) },
  };
}

export async function readRunDetail(d1: D1Database, actor: AppUser, runIdValue: unknown) {
  const runId = identifier(runIdValue, "运行");
  const row = await d1.prepare(`${SUMMARY_SQL} WHERE r.id = ?`).bind(runId).first<SummaryRow>();
  if (!row) throw new RunServiceError(404, "运行不存在", "NOT_FOUND");
  await viewableStudent(actor, row.student_id);
  const { spec, createdByUserId } = await loadSpec(d1, row.run_spec_sha256);
  const [approvals, events, artifacts, result, review, comments] = await Promise.all([
    d1.prepare(`SELECT a.*, u.display_name AS approver_name, (SELECT r2.id FROM runs r2 WHERE r2.approval_id = a.id) AS run_id
      FROM run_approvals a LEFT JOIN app_users u ON u.id = a.approved_by_user_id
      WHERE a.run_spec_sha256 = ? ORDER BY a.approved_at, a.id`).bind(row.run_spec_sha256).all<Record<string, unknown>>(),
    d1.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence").bind(runId).all<Record<string, unknown>>(),
    d1.prepare("SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY relative_path").bind(runId).all<Record<string, unknown>>(),
    d1.prepare("SELECT * FROM run_results WHERE run_id = ?").bind(runId).first<Record<string, unknown>>(),
    d1.prepare("SELECT * FROM result_reviews WHERE run_id = ?").bind(runId).first<Record<string, unknown>>(),
    d1.prepare(`SELECT c.*, u.display_name AS author_name FROM result_comments c LEFT JOIN app_users u ON u.id = c.author_user_id
      WHERE c.run_id = ? AND c.deleted_at IS NULL ORDER BY c.id`).bind(runId).all<Record<string, unknown>>(),
  ]);
  const canReview = await canReviewStudent(actor, row.student_id);
  const terminal = TERMINAL_RUN_STATUSES.includes(row.status);
  const selfCreated = actor.id === createdByUserId || actor.id === row.created_by_user_id;
  return {
    run: runSummary(row),
    spec,
    specCreatedByUserId: createdByUserId,
    approvals: approvals.results.map((item) => ({
      id: item.id, runId: item.run_id ?? null, approvedByUserId: item.approved_by_user_id, approverName: item.approver_name ?? "",
      note: item.note, approvedAt: item.approved_at, revokedAt: item.revoked_at, revokedByUserId: item.revoked_by_user_id,
      current: item.id === row.approval_id,
    })),
    events: events.results.map((item) => ({
      sequence: item.sequence, fromStatus: item.from_status, toStatus: item.to_status, actorType: item.actor_type,
      actorId: item.actor_id, payload: parseJson(item.payload_json as string, {}), createdAt: item.created_at,
    })),
    artifacts: artifacts.results.map((item) => ({
      id: item.id, relativePath: item.relative_path, sha256: item.sha256, sizeBytes: item.size_bytes, kind: item.kind,
      egressDecision: item.egress_decision, egressReason: item.egress_reason,
      downloadable: item.egress_decision === "published" && Boolean(item.r2_key), createdAt: item.created_at,
    })),
    result: result ? {
      manifestSha256: result.manifest_sha256, manifest: parseJson(result.manifest_json as string, null),
      metrics: parseJson(result.metrics_json as string | null, null), metricsSourceArtifactId: result.metrics_source_artifact_id,
      technicalValidity: result.technical_validity, validityNotes: result.validity_notes, createdAt: result.created_at,
    } : null,
    review: review ? {
      state: review.state, hypothesisOutcome: review.hypothesis_outcome, reviewerUserId: review.reviewer_user_id,
      note: review.note, followupTaskId: review.followup_task_id, version: review.version, updatedAt: review.updated_at,
    } : null,
    comments: comments.results.map((item) => ({
      id: item.id, authorUserId: item.author_user_id, authorName: item.author_name ?? "", parentCommentId: item.parent_comment_id,
      body: item.body, createdAt: item.created_at,
    })),
    permissions: {
      canApprove: canReview && row.status === "awaiting_approval" && !selfCreated,
      canRevokeApproval: canReview && Boolean(row.approval_id) && !terminal,
      canCancel: !terminal && row.status !== "cancel_requested",
      canRerun: terminal,
      canReview: canReview && Boolean(review),
      canComment: true,
    },
  };
}

/** Streams a published artifact after the student-scope check (T01). Held and
 * rejected artifacts never leave the lab, so they 404 for everyone. */
export async function readArtifact(d1: D1Database, actor: AppUser, artifactIdValue: unknown) {
  const artifactId = identifier(artifactIdValue, "产物");
  const row = await d1.prepare(`SELECT a.relative_path, a.sha256, a.size_bytes, a.egress_decision, a.r2_key, r.student_id
    FROM run_artifacts a JOIN runs r ON r.id = a.run_id WHERE a.id = ?`).bind(artifactId)
    .first<{ relative_path: string; sha256: string; size_bytes: number; egress_decision: string; r2_key: string | null; student_id: string }>();
  if (!row) throw new RunServiceError(404, "产物不存在", "NOT_FOUND");
  if (!(await canViewStudent(actor, row.student_id))) throw new RunServiceError(403, "无权访问该产物", "FORBIDDEN");
  if (row.egress_decision !== "published" || !row.r2_key) throw new RunServiceError(404, "该产物未外发，只保留在实验室", "NOT_PUBLISHED");
  const object = await getRunArtifactBucket().get(row.r2_key);
  if (!object) throw new RunServiceError(404, "产物文件不存在", "NOT_FOUND");
  const fileName = row.relative_path.split("/").pop() || "artifact";
  const fallback = fileName.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "artifact";
  return new Response(object.body, {
    headers: {
      "Content-Type": contentTypeFor(row.relative_path),
      "Content-Length": String(row.size_bytes),
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-File-SHA256": row.sha256,
    },
  });
}

async function runForActor(d1: D1Database, actor: AppUser, runIdValue: unknown) {
  const run = await loadRun(d1, identifier(runIdValue, "运行"));
  if (!run) throw new RunServiceError(404, "运行不存在", "NOT_FOUND");
  await viewableStudent(actor, run.student_id);
  return run;
}

export async function applyRunResultAction(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  switch (body.action) {
    case "review": return reviewResult(d1, actor, body);
    case "comment": return commentOnRun(d1, actor, body);
    case "followup": return createFollowup(d1, actor, body);
    default: throw new RunServiceError(400, "未知操作", "INVALID_INPUT");
  }
}

async function reviewResult(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const run = await runForActor(d1, actor, body.runId);
  if (!(await canReviewStudent(actor, run.student_id))) throw new RunServiceError(403, "只有可审核该学生的导师或超级管理员可以评审结果", "FORBIDDEN");
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    throw new RunServiceError(400, "版本号无效", "INVALID_INPUT");
  }
  const state = body.state as ReviewState;
  if (!REVIEW_STATES.includes(state) || state === "pending") throw new RunServiceError(400, "评审结论无效", "INVALID_INPUT");
  const hypothesisOutcome = (body.hypothesisOutcome ?? "not_assessed") as HypothesisOutcome;
  if (!HYPOTHESIS_OUTCOMES.includes(hypothesisOutcome)) throw new RunServiceError(400, "假设结论无效", "INVALID_INPUT");
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") throw new RunServiceError(400, "评审说明格式无效", "INVALID_INPUT");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if ([...note].length > 4000) throw new RunServiceError(400, "评审说明不能超过 4000 个字符", "INVALID_INPUT");
  const result = await d1.prepare("SELECT technical_validity FROM run_results WHERE run_id = ?").bind(run.id).first<{ technical_validity: string }>();
  const review = await d1.prepare("SELECT version FROM result_reviews WHERE run_id = ?").bind(run.id).first<{ version: number }>();
  if (!result || !review) throw new RunServiceError(409, "运行尚无可评审的结果", "NO_RESULT");
  // A technically unverified run can never be accepted as research evidence (T19/T20/T21).
  if (state === "accepted" && result.technical_validity !== "valid") {
    throw new RunServiceError(409, "技术有效性未通过（指标缺失、无效或协议不一致），不能验收", "NOT_TECHNICALLY_VALID");
  }
  const updated = await d1.prepare(`UPDATE result_reviews SET state = ?, hypothesis_outcome = ?, note = ?, reviewer_user_id = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE run_id = ? AND version = ?`)
    .bind(state, hypothesisOutcome, note, actor.id, run.id, body.expectedVersion).run();
  if (!updated.meta.changes) throw new RunServiceError(409, "评审已被他人更新，请刷新后重试", "STALE_VERSION");
  return { runId: run.id, state, hypothesisOutcome, version: body.expectedVersion + 1 };
}

async function commentOnRun(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const run = await runForActor(d1, actor, body.runId);
  const requestId = idempotencyKey(body.requestId, "请求编号");
  if (typeof body.body !== "string" || !body.body.trim()) throw new RunServiceError(400, "请填写评论内容", "INVALID_INPUT");
  const text = body.body.trim();
  if ([...text].length > 4000) throw new RunServiceError(400, "评论不能超过 4000 个字符", "INVALID_INPUT");
  let parentId: number | null = null;
  if (body.parentCommentId !== undefined && body.parentCommentId !== null) {
    if (typeof body.parentCommentId !== "number" || !Number.isSafeInteger(body.parentCommentId)) throw new RunServiceError(400, "回复对象无效", "INVALID_INPUT");
    const parent = await d1.prepare("SELECT run_id FROM result_comments WHERE id = ? AND deleted_at IS NULL").bind(body.parentCommentId).first<{ run_id: string }>();
    if (!parent || parent.run_id !== run.id) throw new RunServiceError(400, "回复对象不属于该运行", "INVALID_INPUT");
    parentId = body.parentCommentId;
  }
  await d1.prepare(`INSERT INTO result_comments (run_id, author_user_id, parent_comment_id, body, request_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (request_id) DO NOTHING`).bind(run.id, actor.id, parentId, text, requestId).run();
  const stored = await d1.prepare("SELECT * FROM result_comments WHERE request_id = ?").bind(requestId).first<Record<string, unknown>>();
  if (!stored || stored.run_id !== run.id || stored.author_user_id !== actor.id) throw new RunServiceError(409, "请求编号已被使用", "IDEMPOTENCY_CONFLICT");
  return {
    comment: { id: stored.id, authorUserId: stored.author_user_id, parentCommentId: stored.parent_comment_id, body: stored.body, createdAt: stored.created_at },
  };
}

async function createFollowup(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const run = await runForActor(d1, actor, body.runId);
  const mutationId = idempotencyKey(body.mutationId, "提交编号");
  const student = await d1.prepare("SELECT active FROM students WHERE id = ?").bind(run.student_id).first<{ active: number }>();
  if (!student || student.active !== 1) throw new RunServiceError(404, "学生不存在或已停用", "NOT_FOUND");
  let content;
  try { content = parseTaskContent(body); }
  catch (error) {
    if (error instanceof TaskInputError) throw new RunServiceError(400, error.message, "INVALID_INPUT");
    throw error;
  }
  const created = await createResearchTask(d1, {
    studentId: run.student_id, authorUserId: actor.id, mutationId, content, sourceRunId: run.id, parentTaskId: run.task_id,
  });
  const task = await d1.prepare("SELECT student_id, source_run_id FROM research_tasks WHERE id = ?").bind(created.taskId)
    .first<{ student_id: string; source_run_id: string | null }>();
  if (!task || task.student_id !== run.student_id || task.source_run_id !== run.id) {
    throw new RunServiceError(409, "提交编号已用于其他任务", "IDEMPOTENCY_CONFLICT");
  }
  // First follow-up is linked on the review (T25); later ones keep their own source link.
  const linked = await d1.prepare(`UPDATE result_reviews SET followup_task_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE run_id = ? AND followup_task_id IS NULL`).bind(created.taskId, run.id).run();
  const review = await d1.prepare("SELECT followup_task_id FROM result_reviews WHERE run_id = ?").bind(run.id).first<{ followup_task_id: string | null }>();
  return {
    taskId: created.taskId, version: created.version, replayed: created.replayed,
    linkedOnReview: Boolean(linked.meta.changes) || review?.followup_task_id === created.taskId,
  };
}
