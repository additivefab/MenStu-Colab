// Run reads, artifact access and result review (docs/科研闭环_实施规格_v1.md §6.3).
import { canReviewStudent, canViewStudent } from "./authorization";
import type { AppUser } from "./feishu-auth";
import { notifyLoopEvent } from "./loop-notifications";
import {
  HYPOTHESIS_OUTCOMES, REVIEW_STATES, TERMINAL_RUN_STATUSES, type HypothesisOutcome, type ReviewState, type RunStatus,
} from "./research-loop/contracts.ts";
import type {
  InterpretationInput, ProgressDraft, ProgressDraftSource, ResultInterpretationView,
} from "./research-loop/results-contract.ts";
import { createResearchTask, parseTaskContent, TaskInputError } from "./research-loop/tasks-core.ts";
import {
  RunServiceError, contentTypeFor, datasetView, entrypointView, getRunArtifactBucket, idempotencyKey, isRunOwner,
  listBaselineCandidates, loadRun, loadSpec, readBaselineView, runNumberSql, userAuditStatement,
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
  const [baseline, baselineCandidates, interpretationVersions] = await Promise.all([
    readBaselineView(d1, runId, spec.evaluationProtocolSha256),
    listBaselineCandidates(d1, row, spec.evaluationProtocolSha256),
    listInterpretations(d1, runId),
  ]);
  const canReview = await canReviewStudent(actor, row.student_id);
  const owner = isRunOwner(actor, row.student_id);
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
    baseline,
    baselineCandidates,
    interpretation: interpretationVersions[0] ?? null,
    /** Every saved version, newest first. */
    interpretationVersions,
    permissions: {
      canApprove: canReview && row.status === "awaiting_approval" && !selfCreated,
      canRevokeApproval: canReview && Boolean(row.approval_id) && !terminal,
      canCancel: !terminal && row.status !== "cancel_requested",
      canRerun: terminal,
      canReview: canReview && Boolean(review),
      canComment: true,
      canSetBaseline: owner || canReview,
      canInterpret: owner && INTERPRETABLE_STATUSES.includes(row.status),
      canDraftProgress: owner || canReview,
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
    case "interpret": return interpretResult(d1, actor, body);
    case "progress_draft": return draftProgress(d1, actor, body);
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
  await notifyLoopEvent(d1, { kind: "review_saved", runId: run.id, version: body.expectedVersion + 1, actorUserId: actor.id });
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
  if (!created.replayed) await notifyLoopEvent(d1, { kind: "task_draft", taskId: created.taskId, actorUserId: actor.id });
  return {
    taskId: created.taskId, version: created.version, replayed: created.replayed,
    linkedOnReview: Boolean(linked.meta.changes) || review?.followup_task_id === created.taskId,
  };
}

// ---------------------------------------------------------------------------
// Student interpretation (batch 4, FA3) and progress drafts (FA4)
// ---------------------------------------------------------------------------

const INTERPRETABLE_STATUSES: readonly RunStatus[] = ["completed", "failed"];
const INTERPRETATION_MAX = 4000;

type InterpretationRow = {
  run_id: string; version: number; author_user_id: number; author_name: string | null; what_it_shows: string;
  alternative_explanations: string; limitations: string; proposed_next_step: string; request_id: string; created_at: string;
};

const INTERPRETATION_SQL = `SELECT i.*, u.display_name AS author_name FROM result_interpretations i
  LEFT JOIN app_users u ON u.id = i.author_user_id`;

function interpretationView(row: InterpretationRow): ResultInterpretationView {
  return {
    version: row.version, authorUserId: row.author_user_id, authorName: row.author_name ?? "", createdAt: row.created_at,
    whatItShows: row.what_it_shows, alternativeExplanations: row.alternative_explanations,
    limitations: row.limitations, proposedNextStep: row.proposed_next_step,
  };
}

async function listInterpretations(d1: D1Database, runId: string) {
  const { results } = await d1.prepare(`${INTERPRETATION_SQL} WHERE i.run_id = ? ORDER BY i.version DESC LIMIT 50`)
    .bind(runId).all<InterpretationRow>();
  return results.map(interpretationView);
}

function interpretationText(value: unknown, label: string, required: boolean) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new RunServiceError(400, `${label}格式无效`, "INVALID_INPUT");
  const trimmed = value.trim();
  if (required && !trimmed) throw new RunServiceError(400, `请填写${label}`, "INVALID_INPUT");
  if ([...trimmed].length > INTERPRETATION_MAX) throw new RunServiceError(400, `${label}不能超过 ${INTERPRETATION_MAX} 个字符`, "INVALID_INPUT");
  return trimmed;
}

function parseInterpretation(body: Record<string, unknown>): InterpretationInput {
  return {
    whatItShows: interpretationText(body.whatItShows, "“本次结果说明了什么”", true),
    alternativeExplanations: interpretationText(body.alternativeExplanations, "“其他可能的解释”", false),
    limitations: interpretationText(body.limitations, "“限制与异常”", false),
    proposedNextStep: interpretationText(body.proposedNextStep, "“建议的下一步”", false),
  };
}

async function interpretationReplay(d1: D1Database, requestId: string, run: RunRow, actor: AppUser) {
  const stored = await d1.prepare(`${INTERPRETATION_SQL} WHERE i.request_id = ?`).bind(requestId).first<InterpretationRow>();
  if (!stored) return null;
  if (stored.run_id !== run.id || stored.author_user_id !== actor.id) throw new RunServiceError(409, "请求编号已被使用", "IDEMPOTENCY_CONFLICT");
  return { interpretation: interpretationView(stored) };
}

async function interpretResult(d1: D1Database, actor: AppUser, body: Record<string, unknown>): Promise<{ interpretation: ResultInterpretationView }> {
  const run = await runForActor(d1, actor, body.runId);
  if (!isRunOwner(actor, run.student_id)) throw new RunServiceError(403, "只有该运行所属的学生本人可以填写结果解读", "FORBIDDEN");
  const requestId = idempotencyKey(body.requestId, "请求编号");
  const replay = await interpretationReplay(d1, requestId, run, actor);
  if (replay) return replay;
  if (!INTERPRETABLE_STATUSES.includes(run.status)) {
    throw new RunServiceError(409, "运行结束（完成或失败）后才能填写结果解读", "RUN_NOT_TERMINAL");
  }
  const expected = body.expectedVersion;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) {
    throw new RunServiceError(400, "版本号无效", "INVALID_INPUT");
  }
  const input = parseInterpretation(body);
  const version = expected + 1;
  const stale = () => new RunServiceError(409, "结果解读已被更新，请刷新后重试", "STALE_VERSION");
  try {
    const [inserted] = await d1.batch([
      // Compare-and-insert: only when the latest stored version is the one the client saw.
      d1.prepare(`INSERT INTO result_interpretations (run_id, version, author_user_id, what_it_shows, alternative_explanations,
          limitations, proposed_next_step, request_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT MAX(version) FROM result_interpretations WHERE run_id = ?), 0) = ?`)
        .bind(run.id, version, actor.id, input.whatItShows, input.alternativeExplanations, input.limitations,
          input.proposedNextStep, requestId, run.id, expected),
      userAuditStatement(d1, run.id, actor.id, { action: "interpretation_saved", version }, {
        sql: "EXISTS (SELECT 1 FROM result_interpretations WHERE run_id = ? AND version = ? AND request_id = ?)",
        binds: [run.id, version, requestId],
      }),
    ]);
    if (!inserted?.meta?.changes) throw stale();
  } catch (error) {
    if (error instanceof RunServiceError) throw error;
    if (!String(error).includes("UNIQUE")) throw error;
    // Lost a race: either the same request landed first (replay) or another version did.
    const raced = await interpretationReplay(d1, requestId, run, actor);
    if (raced) return raced;
    throw stale();
  }
  const saved = await interpretationReplay(d1, requestId, run, actor);
  if (!saved) throw stale();
  return saved;
}

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  awaiting_approval: "待批准", queued: "已排队", dispatching: "派发中", running: "运行中", collecting: "收集结果中",
  completed: "已完成", failed: "失败", cancel_requested: "取消中", canceled: "已取消", reconciling: "对账中",
};
const VALIDITY_LABELS: Record<string, string> = { valid: "有效", invalid: "无效", unknown: "未知" };

function clip(value: string, max: number) {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}

/** Concise, factual progress draft. Every line restates stored records;
 * nothing is saved and no conclusion is added on the student's behalf. */
async function draftProgress(d1: D1Database, actor: AppUser, body: Record<string, unknown>): Promise<{ draft: ProgressDraft }> {
  const run = await runForActor(d1, actor, body.runId);
  if (!isRunOwner(actor, run.student_id) && !(await canReviewStudent(actor, run.student_id))) {
    throw new RunServiceError(403, "只有该学生本人或可审核该学生的导师可以生成进展草稿", "FORBIDDEN");
  }
  const { spec } = await loadSpec(d1, run.run_spec_sha256);
  const [facts, latest] = await Promise.all([
    d1.prepare(`SELECT t.title AS task_title, ${runNumberSql("r")} AS number, res.technical_validity, res.metrics_json,
        a.relative_path AS metrics_path, a.sha256 AS metrics_sha256, cr.id AS cr_id, cr.pr_url, cr.pr_number
      FROM runs r
      LEFT JOIN research_tasks t ON t.id = r.task_id
      LEFT JOIN run_results res ON res.run_id = r.id
      LEFT JOIN run_artifacts a ON a.id = res.metrics_source_artifact_id AND a.run_id = r.id
      LEFT JOIN change_requests cr ON cr.id = ? AND cr.student_id = r.student_id
      WHERE r.id = ?`).bind(spec.changeRequestId, run.id).first<{
        task_title: string | null; number: number | null; technical_validity: string | null; metrics_json: string | null;
        metrics_path: string | null; metrics_sha256: string | null; cr_id: string | null; pr_url: string | null; pr_number: number | null;
      }>(),
    d1.prepare(`${INTERPRETATION_SQL} WHERE i.run_id = ? ORDER BY i.version DESC LIMIT 1`).bind(run.id).first<InterpretationRow>(),
  ]);
  const taskTitle = facts?.task_title || "研究任务";
  const runName = facts?.number ? `运行 #${facts.number}` : "运行";
  const commit = spec.executedCommitSha;
  const status = RUN_STATUS_LABELS[run.status] ?? run.status;
  const validity = facts?.technical_validity ? VALIDITY_LABELS[facts.technical_validity] ?? facts.technical_validity : null;
  const metrics = parseJson<{ values?: Record<string, number> } | null>(facts?.metrics_json, null)?.values ?? null;
  const prUrl = facts?.pr_url && facts.pr_url.startsWith("https://") ? facts.pr_url : "";
  const prLabel = facts?.pr_number ? `PR #${facts.pr_number}` : "PR";

  const summary: string[] = [validity
    ? `${runName}（执行提交 ${commit.slice(0, 7)}）${status}，技术有效性：${validity}。`
    : `${runName}（执行提交 ${commit.slice(0, 7)}）当前状态：${status}，尚无结果记录。`];
  if (latest) {
    summary.push(`学生解读（第 ${latest.version} 版）`);
    const parts: [string, string][] = [
      ["本次结果说明了什么", latest.what_it_shows], ["其他可能的解释", latest.alternative_explanations],
      ["限制与异常", latest.limitations], ["建议的下一步", latest.proposed_next_step],
    ];
    for (const [label, value] of parts) if (value) summary.push(`${label}：${clip(value, 2800)}`);
  } else {
    summary.push("学生尚未填写结果解读：提交前需要学生本人说明这次结果意味着什么、还有哪些可能的解释和限制。");
  }

  const evidence = [`研究任务：${taskTitle}（${run.task_id}）`, `${runName}：${run.id}，状态 ${status}，执行提交 ${commit}`];
  if (metrics && Object.keys(metrics).length) {
    const entries = Object.entries(metrics);
    const shown = entries.slice(0, 20).map(([name, value]) => `${name} = ${value}`).join("；");
    const more = entries.length > 20 ? `；等共 ${entries.length} 项` : "";
    const source = facts?.metrics_path
      ? `来源 ${facts.metrics_path}，sha256 ${(facts.metrics_sha256 ?? "").slice(0, 12)}`
      : "来源文件未记录";
    evidence.push(`指标（${source}；评价协议 ${spec.evaluationProtocolSha256.slice(0, 12)}）：${shown}${more}`);
  } else {
    evidence.push(`没有正式指标（技术有效性：${validity ?? "尚无结果"}）`);
  }
  if (prUrl) evidence.push(`变更请求：${prLabel} ${prUrl}`);
  else if (facts?.cr_id) evidence.push(`变更请求：${facts.cr_id}（尚无 PR 链接）`);

  const evidenceSources: ProgressDraftSource[] = [];
  if (prUrl) evidenceSources.push({ sourceType: "url", label: prLabel, ref: prUrl });
  evidenceSources.push({
    sourceType: "git", label: `执行提交 ${commit.slice(0, 7)}`,
    ref: `https://github.com/${spec.repository.fullName}/commit/${commit}`,
  });

  return {
    draft: {
      kind: "项目",
      title: clip(`${taskTitle} · ${runName} 结果`, 160),
      summary: clip(summary.join("\n"), 12_000),
      evidence: clip(evidence.join("\n"), 4000),
      evidenceSources,
      from: { taskId: run.task_id, runId: run.id, changeRequestId: facts?.cr_id ?? null, interpretationVersion: latest?.version ?? null },
    },
  };
}
