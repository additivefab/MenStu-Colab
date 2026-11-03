import { canViewStudent } from "./authorization";
import type { AppUser } from "./feishu-auth";
import { GithubCommitNotFoundError, resolveCommitSha } from "./github/repository-read";
import { GithubNotConfiguredError, mintRepositoryReadToken } from "./github/tokens";
import type { LabRunner } from "./lab-runner-auth";
import {
  AGENT_ATTEMPT_TRANSITIONS, AGENT_PROVIDERS, LIMITS, agentContextSnapshotSha256, PathPolicyError, TERMINAL_ATTEMPT_STATUSES,
  canTransition, canonicalJson, evaluatePathPolicy, isCommitSha, newId, normalizeRepoPath, sha256Hex,
  type AgentAttemptStatus, type AgentClaimResponse, type AgentEvent, type AgentHeartbeatResponse,
  type AgentProvider, type ChangedFile, type JsonValue, type RepositoryReadAccess, type ResearchTaskSnapshot,
} from "./research-loop/contracts";
import {
  ResearchLoopHttpError, TaskSnapshotMismatchError, canDecideTask, conflictError, forbiddenError, inputError, isConstraintError,
  loadTaskVersionSnapshot, notFoundError, parseEntityId, readTaskRow,
} from "./research-tasks-service";
import { notifyLoopEvent } from "./loop-notifications";
import { canCodeReviewStudent } from "./review-delegation";

// Agent attempts (docs/科研闭环_实施规格_v1.md §6.1): user start/cancel, the
// agent-worker lab protocol (claim/heartbeat/events/result) and the superadmin
// credential-profile mapping. The platform never stores agent credentials.

/** Providers implemented this phase; DeepSeek stays in the enum only. */
export const SUPPORTED_AGENT_PROVIDERS: readonly AgentProvider[] = ["codex", "claude"];
const ATTEMPT_EVENT_KINDS = ["status", "message", "tool_call", "tool_result", "file_change", "test", "usage", "error"] as const;
/** Hard cap on stored worker events per attempt. */
export const MAX_AGENT_EVENTS_PER_ATTEMPT = 10_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const GIT_REF = /^[A-Za-z0-9._/-]{1,255}$/;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** FB2: upper bound for an agent's plan text (characters). */
export const MAX_AGENT_PLAN_CHARS = 20_000;
const MAX_PLAN_NOTE_CHARS = 2000;

const leaseLost = () => new ResearchLoopHttpError(409, "LEASE_LOST", "租约已失效，请停止当前工作");
const tooLarge = (message: string) => new ResearchLoopHttpError(413, "PAYLOAD_TOO_LARGE", message);
const invalidResult = (message: string) => new ResearchLoopHttpError(400, "INVALID_RESULT", message);

/** Hash bound into every attempt (shared definition in contracts.ts). */
export { agentContextSnapshotSha256 };

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function shortText(value: unknown, label: string, max: number, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw invalidResult(`${label}格式无效`);
  if (value.length > max) throw invalidResult(`${label}过长`);
  return value;
}

function parseProvider(value: unknown): AgentProvider {
  if (typeof value !== "string" || !(AGENT_PROVIDERS as readonly string[]).includes(value)) throw inputError("代理提供商无效");
  if (!SUPPORTED_AGENT_PROVIDERS.includes(value as AgentProvider)) throw inputError("本期暂不支持该代理提供商");
  return value as AgentProvider;
}

function transitionOrConflict(from: AgentAttemptStatus, to: AgentAttemptStatus) {
  if (!canTransition(AGENT_ATTEMPT_TRANSITIONS, from, to)) {
    throw new ResearchLoopHttpError(409, "INVALID_TRANSITION", `代理尝试状态不能从 ${from} 变为 ${to}`);
  }
}

const nowIso = () => new Date().toISOString();
const leaseUntil = () => new Date(Date.now() + LIMITS.leaseSeconds * 1000).toISOString();

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

export type AttemptRow = {
  id: string;
  task_id: string;
  task_version: number;
  student_id: string;
  provider: AgentProvider;
  model_id: string;
  sdk_version: string;
  credential_profile_id: string;
  github_repository_id: number;
  base_commit_sha: string;
  context_snapshot_sha256: string;
  status: AgentAttemptStatus;
  worker_id: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  idempotency_key: string;
  diff_sha256: string | null;
  diff_r2_key: string | null;
  changed_paths_json: string;
  tests_json: string;
  usage_json: string;
  error_code: string;
  error_message: string;
  requested_by_user_id: number;
  cancel_requested_at: string | null;
  cancel_requested_by_user_id: number | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
};

type ChangeRequestRow = {
  id: string;
  task_id: string;
  attempt_id: string;
  status: string;
  branch_name: string;
  base_commit_sha: string;
  head_commit_sha: string | null;
  requires_extra_review: number;
  pr_number: number | null;
  pr_url: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export function attemptView(row: AttemptRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    taskVersion: Number(row.task_version),
    studentId: row.student_id,
    provider: row.provider,
    modelId: row.model_id,
    sdkVersion: row.sdk_version,
    status: row.status,
    githubRepositoryId: Number(row.github_repository_id),
    baseCommitSha: row.base_commit_sha,
    contextSnapshotSha256: row.context_snapshot_sha256,
    leaseEpoch: Number(row.lease_epoch),
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    changedPaths: parseJson<string[]>(row.changed_paths_json, []),
    tests: parseJson<unknown[]>(row.tests_json, []),
    usage: parseJson<Record<string, unknown>>(row.usage_json, {}),
    diffSha256: row.diff_sha256,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    requestedByUserId: row.requested_by_user_id,
    cancelRequestedAt: row.cancel_requested_at,
    cancelRequestedByUserId: row.cancel_requested_by_user_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  };
}

function changeRequestView(row: ChangeRequestRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    status: row.status,
    branchName: row.branch_name,
    baseCommitSha: row.base_commit_sha,
    headCommitSha: row.head_commit_sha,
    requiresExtraReview: Boolean(row.requires_extra_review),
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readAttempt(d1: D1Database, attemptId: string) {
  return d1.prepare("SELECT * FROM agent_attempts WHERE id = ?").bind(attemptId).first<AttemptRow>();
}

async function readChangeRequest(d1: D1Database, attemptId: string) {
  return d1.prepare(`SELECT id, task_id, attempt_id, status, branch_name, base_commit_sha, head_commit_sha,
    requires_extra_review, pr_number, pr_url, version, created_at, updated_at
    FROM change_requests WHERE attempt_id = ?`).bind(attemptId).first<ChangeRequestRow>();
}

// ---------------------------------------------------------------------------
// Plan-first attempts (FB2)
// ---------------------------------------------------------------------------

// A row in agent_attempt_plans marks the attempt as plan-first (spec §12):
//   awaiting_plan --plan_ready--> pending --approved--> approved (edit phase)
//                                         \--rejected--> rejected (attempt canceled)
// The attempt meanwhile goes queued → running (plan mode) → waiting_approval
// (lease released) → queued → running (edit mode) → change_ready, or ends as
// canceled with PLAN_REJECTED.

type PlanDecision = "awaiting_plan" | "pending" | "approved" | "rejected";

type PlanRow = {
  attempt_id: string;
  plan_text: string;
  plan_sha256: string;
  decision: PlanDecision;
  submitted_at: string | null;
  decided_by_user_id: number | null;
  decided_at: string | null;
  note: string;
  version: number;
  decided_by_display_name: string | null;
};

async function readPlan(d1: D1Database, attemptId: string) {
  return d1.prepare(`SELECT pl.*, u.display_name AS decided_by_display_name FROM agent_attempt_plans pl
    LEFT JOIN app_users u ON u.id = pl.decided_by_user_id WHERE pl.attempt_id = ?`).bind(attemptId).first<PlanRow>();
}

function planView(row: PlanRow | null) {
  if (!row) return null;
  return {
    text: row.plan_text,
    decision: row.decision,
    submittedAt: row.submitted_at,
    decidedBy: row.decided_by_user_id === null ? null : { id: Number(row.decided_by_user_id), displayName: row.decided_by_display_name ?? "" },
    decidedAt: row.decided_at,
    note: row.note,
    version: Number(row.version),
  };
}

/** Platform audit entries share agent_attempt_events with worker events but use
 * negative sequences (-1, -2, …), so they never collide with worker sequences
 * (always ≥ 1), never count toward the worker event cap and never appear in the
 * `afterSequence` event stream. */
function auditStatement(d1: D1Database, attemptId: string, payload: Record<string, string | number | null>,
  guard?: { sql: string; binds: unknown[] }) {
  return d1.prepare(`INSERT INTO agent_attempt_events (attempt_id, sequence, kind, payload_json)
    SELECT ?, COALESCE((SELECT MIN(sequence) FROM agent_attempt_events WHERE attempt_id = ? AND sequence < 0), 0) - 1, 'status', ?
    ${guard ? `WHERE ${guard.sql}` : ""}`)
    .bind(attemptId, attemptId, JSON.stringify({ source: "platform", ...payload }), ...(guard?.binds ?? []));
}

/** Workers number events per lease from 1, so the edit phase of a plan-first
 * attempt would collide with the plan phase. Edit-phase sequences are stored
 * shifted by the plan phase's last sequence (recorded when the plan arrived). */
async function editPhaseSequenceOffset(d1: D1Database, attemptId: string) {
  const row = await d1.prepare(`SELECT json_extract(payload_json, '$.lastWorkerSequence') AS s FROM agent_attempt_events
    WHERE attempt_id = ? AND sequence < 0 AND json_extract(payload_json, '$.action') = 'plan_submitted'
    ORDER BY sequence DESC LIMIT 1`).bind(attemptId).first<{ s: number | null }>();
  return Number(row?.s ?? 0);
}

// ---------------------------------------------------------------------------
// Lease expiry (lazy) and revocation
// ---------------------------------------------------------------------------

/** Running attempts whose lease lapsed are failed with LEASE_EXPIRED and never
 * re-dispatched; a lapsed cancel_requested attempt is recorded as canceled. */
export async function expireAgentLeases(d1: D1Database, scope: { attemptId?: string; taskId?: string; workerId?: string } = {}) {
  const now = nowIso();
  const filters: string[] = [];
  const bindings: string[] = [];
  if (scope.attemptId) { filters.push("id = ?"); bindings.push(scope.attemptId); }
  if (scope.taskId) { filters.push("task_id = ?"); bindings.push(scope.taskId); }
  if (scope.workerId) { filters.push("worker_id = ?"); bindings.push(scope.workerId); }
  const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";
  await d1.batch([
    d1.prepare(`UPDATE agent_attempts SET status = 'failed', error_code = 'LEASE_EXPIRED',
      error_message = '代理工作进程租约过期，未自动重派；如需继续请新建尝试', ended_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('running', 'waiting_approval') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?${where}`)
      .bind(now, now, ...bindings),
    d1.prepare(`UPDATE agent_attempts SET status = 'canceled',
      error_code = CASE WHEN error_code = '' THEN 'LEASE_EXPIRED' ELSE error_code END,
      ended_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'cancel_requested' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?${where}`)
      .bind(now, now, ...bindings),
    // A plan awaiting approval holds no lease; a cancel request on it (e.g. the
    // task was canceled) has no worker to report back, so it ends here.
    d1.prepare(`UPDATE agent_attempts SET status = 'canceled',
      error_code = CASE WHEN error_code = '' THEN 'CANCELED' ELSE error_code END,
      ended_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'cancel_requested' AND lease_expires_at IS NULL
        AND EXISTS (SELECT 1 FROM agent_attempt_plans pl WHERE pl.attempt_id = agent_attempts.id AND pl.decision = 'pending')${where}`)
      .bind(now, ...bindings),
  ]);
}

type EligibilityRow = {
  profile_active: number;
  user_active: number;
  user_role: string;
  user_student_id: string | null;
  assigned: number;
  student_active: number;
  task_status: string;
  link_status: string | null;
  link_repository_id: number | null;
  installation_id: number | null;
  installation_status: string | null;
  full_name: string | null;
};

async function readEligibility(d1: D1Database, attemptId: string) {
  return d1.prepare(`SELECT p.active AS profile_active, u.active AS user_active, u.role AS user_role,
      u.student_id AS user_student_id,
      EXISTS (SELECT 1 FROM mentor_student_assignments m
        WHERE m.mentor_user_id = a.requested_by_user_id AND m.student_id = a.student_id AND m.active = 1) AS assigned,
      s.active AS student_active, t.status AS task_status,
      l.status AS link_status, l.github_repository_id AS link_repository_id, l.installation_id, l.full_name,
      i.status AS installation_status
    FROM agent_attempts a
    JOIN agent_credential_profiles p ON p.id = a.credential_profile_id
    JOIN app_users u ON u.id = a.requested_by_user_id
    JOIN students s ON s.id = a.student_id
    JOIN research_tasks t ON t.id = a.task_id
    LEFT JOIN repository_links l ON l.student_id = a.student_id
    LEFT JOIN github_installations i ON i.installation_id = l.installation_id
    WHERE a.id = ?`).bind(attemptId).first<EligibilityRow>();
}

/** T12: the requester, scope, credential profile, student, task and repository
 * link are re-checked at claim, heartbeat and result. */
function revocationReason(row: EligibilityRow | null, attempt: AttemptRow): { code: string; message: string } | null {
  if (!row) return { code: "ACCESS_REVOKED", message: "代理尝试的关联记录已不存在" };
  if (!row.profile_active) return { code: "CREDENTIAL_PROFILE_REVOKED", message: "发起人的代理凭据档案已停用" };
  if (!row.user_active) return { code: "ACCESS_REVOKED", message: "发起人账号已停用" };
  const inScope = row.user_role === "superadmin"
    || (row.user_role === "student" && row.user_student_id === attempt.student_id)
    || ((row.user_role === "admin" || row.user_role === "mentor") && Boolean(row.assigned));
  if (!inScope) return { code: "ACCESS_REVOKED", message: "发起人已不再拥有该学生的访问权限" };
  if (!row.student_active) return { code: "ACCESS_REVOKED", message: "学生已停用" };
  if (row.task_status === "canceled") return { code: "TASK_CANCELED", message: "研究任务已取消" };
  if (row.task_status === "closed") return { code: "TASK_CLOSED", message: "研究任务已关闭" };
  if (row.link_status !== "active" || Number(row.link_repository_id) !== Number(attempt.github_repository_id)
    || row.installation_status !== "active") {
    return { code: "REPOSITORY_REVOKED", message: "科研仓库授权已撤销或已变更" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// User operations
// ---------------------------------------------------------------------------

export async function startAgentAttempt(d1: D1Database, user: AppUser, body: Record<string, unknown>) {
  const taskId = parseEntityId(body.taskId, "任务");
  const provider = parseProvider(body.provider);
  if (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) throw inputError("缺少有效的 idempotencyKey，请刷新后重试");
  const idempotencyKey = body.idempotencyKey;
  let baseRef: string | null = null;
  if (body.baseRef !== undefined && body.baseRef !== null && body.baseRef !== "") {
    if (typeof body.baseRef !== "string" || !GIT_REF.test(body.baseRef) || body.baseRef.includes("..")
      || body.baseRef.startsWith("/") || body.baseRef.endsWith("/")) {
      throw inputError("基准分支或提交格式无效");
    }
    baseRef = body.baseRef;
  }
  if (body.planFirst !== undefined && body.planFirst !== null && typeof body.planFirst !== "boolean") throw inputError("planFirst 必须是布尔值");
  const planFirst = body.planFirst === true;
  const task = await readTaskRow(d1, taskId);
  if (!task || !(await canViewStudent(user, task.student_id))) throw notFoundError("研究任务不存在或无权查看");

  const replay = async () => {
    const existing = await d1.prepare(`SELECT a.*, EXISTS (SELECT 1 FROM agent_attempt_plans pl WHERE pl.attempt_id = a.id) AS plan_first
      FROM agent_attempts a WHERE a.idempotency_key = ?`).bind(idempotencyKey).first<AttemptRow & { plan_first: number }>();
    if (!existing) return null;
    if (existing.task_id !== taskId || existing.requested_by_user_id !== user.id || existing.provider !== provider
      || Boolean(existing.plan_first) !== planFirst) {
      throw conflictError("该提交标识已被使用，请刷新页面后重试");
    }
    return { attempt: attemptView(existing), planFirst, replayed: true };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  if (task.status !== "confirmed" || task.confirmed_version === null) throw conflictError("任务尚未确认（或修改后尚未重新确认），不能启动代理", "TASK_NOT_CONFIRMED");
  const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(task.student_id).first();
  if (!student) throw notFoundError("学生不存在或已停用");
  const link = await d1.prepare(`SELECT l.github_repository_id, l.installation_id, l.full_name, l.default_branch
    FROM repository_links l JOIN github_installations i ON i.installation_id = l.installation_id
    WHERE l.student_id = ? AND l.status = 'active' AND i.status = 'active'`).bind(task.student_id)
    .first<{ github_repository_id: number; installation_id: number; full_name: string; default_branch: string }>();
  if (!link) throw conflictError("该学生尚未完成 GitHub 仓库授权链接，请联系管理员", "REPOSITORY_NOT_LINKED");
  const profile = await d1.prepare(`SELECT p.id FROM agent_credential_profiles p JOIN lab_runners r ON r.id = p.worker_id
    WHERE p.user_id = ? AND p.provider = ? AND p.active = 1 AND r.status = 'active' AND r.kind = 'agent'`)
    .bind(user.id, provider).first<{ id: string }>();
  if (!profile) throw conflictError("你还没有可用的代理凭据档案，请联系超级管理员配置", "CREDENTIAL_PROFILE_MISSING");

  let snapshot: ResearchTaskSnapshot;
  try {
    snapshot = (await loadTaskVersionSnapshot(d1, taskId, Number(task.confirmed_version))).snapshot;
  } catch (error) {
    if (error instanceof TaskSnapshotMismatchError) throw new ResearchLoopHttpError(500, "SNAPSHOT_MISMATCH", "任务快照校验失败，请联系管理员");
    throw error;
  }

  let baseCommitSha: string;
  try {
    baseCommitSha = await resolveCommitSha({
      installationId: Number(link.installation_id), repositoryId: Number(link.github_repository_id),
      fullName: link.full_name, ref: baseRef ?? link.default_branch,
    });
  } catch (error) {
    if (error instanceof GithubNotConfiguredError) throw new ResearchLoopHttpError(503, "GITHUB_NOT_CONFIGURED", "GitHub App 尚未配置，暂时不能启动代理");
    if (error instanceof GithubCommitNotFoundError) throw inputError("基准分支或提交在仓库中不存在");
    throw new ResearchLoopHttpError(502, "GITHUB_UNAVAILABLE", "暂时无法读取 GitHub 仓库，请稍后重试");
  }
  if (!isCommitSha(baseCommitSha)) throw new ResearchLoopHttpError(502, "GITHUB_UNAVAILABLE", "GitHub 返回的提交无效");
  const contextSnapshotSha256 = await agentContextSnapshotSha256(snapshot, baseCommitSha);
  const attemptId = newId("att");
  const insertAttempt = d1.prepare(`INSERT INTO agent_attempts
      (id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id, base_commit_sha,
       context_snapshot_sha256, status, idempotency_key, requested_by_user_id, created_at)
      SELECT ?, id, confirmed_version, student_id, ?, ?, ?, ?, ?, 'queued', ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now')
      FROM research_tasks WHERE id = ? AND status = 'confirmed' AND confirmed_version = ?`)
    .bind(attemptId, provider, profile.id, Number(link.github_repository_id), baseCommitSha, contextSnapshotSha256,
      idempotencyKey, user.id, taskId, Number(task.confirmed_version));
  try {
    if (planFirst) {
      // Same batch (one transaction): the plan row exists iff the attempt does.
      const inserted = { sql: "EXISTS (SELECT 1 FROM agent_attempts WHERE id = ?)", binds: [attemptId] };
      await d1.batch([
        insertAttempt,
        d1.prepare(`INSERT INTO agent_attempt_plans (attempt_id, decision) SELECT ?, 'awaiting_plan' WHERE ${inserted.sql}`)
          .bind(attemptId, ...inserted.binds),
        auditStatement(d1, attemptId, { action: "plan_requested", userId: user.id }, inserted),
      ]);
    } else {
      await insertAttempt.run();
    }
  } catch (error) {
    if (!isConstraintError(error)) throw error;
    const raced = await replay();
    if (raced) return raced;
    throw error;
  }
  const row = await readAttempt(d1, attemptId);
  if (!row) throw conflictError("任务已被修改，请重新确认后再启动代理", "TASK_NOT_CONFIRMED");
  return { attempt: attemptView(row), planFirst, replayed: false };
}

/** Write access: the student's normal scope (canViewStudent). */
async function requireVisibleAttempt(d1: D1Database, user: AppUser, attemptId: string) {
  const attempt = await readAttempt(d1, attemptId);
  if (!attempt || !(await canViewStudent(user, attempt.student_id))) throw notFoundError("代理尝试不存在或无权查看");
  return attempt;
}

/** Read access: the student's scope, or a delegated code reviewer (FB1). */
async function canReadStudentAttempts(d1: D1Database, user: AppUser, studentId: string) {
  return (await canViewStudent(user, studentId)) || canCodeReviewStudent(d1, user, studentId);
}

export async function cancelAgentAttempt(d1: D1Database, user: AppUser, body: Record<string, unknown>) {
  const attemptId = parseEntityId(body.attemptId, "代理尝试");
  await requireVisibleAttempt(d1, user, attemptId);
  await expireAgentLeases(d1, { attemptId });
  const attempt = await readAttempt(d1, attemptId) as AttemptRow;
  if (attempt.status === "cancel_requested" || attempt.status === "canceled") return { attempt: attemptView(attempt), replayed: true };
  if (TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) throw conflictError("代理尝试已结束，不能取消");
  // No worker holds a queued attempt or a plan awaiting approval (lease released).
  const unleased = attempt.status === "queued" || (attempt.status === "waiting_approval" && !attempt.lease_expires_at);
  const target: AgentAttemptStatus = unleased ? "canceled" : "cancel_requested";
  transitionOrConflict(attempt.status, target);
  const now = nowIso();
  const row = await d1.prepare(`UPDATE agent_attempts SET status = ?, cancel_requested_at = ?, cancel_requested_by_user_id = ?,
    ended_at = CASE WHEN ? = 'canceled' THEN ? ELSE ended_at END, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = ? RETURNING *`)
    .bind(target, now, user.id, target, now, attemptId, attempt.status).first<AttemptRow>();
  if (!row) throw conflictError("代理尝试状态已变化，请刷新后重试");
  return { attempt: attemptView(row), replayed: false };
}

export async function listTaskAttempts(d1: D1Database, user: AppUser, taskId: string) {
  const task = await readTaskRow(d1, taskId);
  if (!task || !(await canReadStudentAttempts(d1, user, task.student_id))) throw notFoundError("研究任务不存在或无权查看");
  await expireAgentLeases(d1, { taskId });
  const { results } = await d1.prepare("SELECT * FROM agent_attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100")
    .bind(taskId).all<AttemptRow>();
  return { attempts: results.map(attemptView) };
}

export async function agentAttemptDetail(d1: D1Database, user: AppUser, attemptId: string, afterSequence: number) {
  const visible = await readAttempt(d1, attemptId);
  if (!visible || !(await canReadStudentAttempts(d1, user, visible.student_id))) throw notFoundError("代理尝试不存在或无权查看");
  await expireAgentLeases(d1, { attemptId });
  const [attempt, events, changeRequest, plan] = await Promise.all([
    readAttempt(d1, attemptId),
    d1.prepare(`SELECT sequence, kind, payload_json, created_at FROM agent_attempt_events
      WHERE attempt_id = ? AND sequence > ? ORDER BY sequence LIMIT 500`).bind(attemptId, afterSequence)
      .all<{ sequence: number; kind: string; payload_json: string; created_at: string }>(),
    readChangeRequest(d1, attemptId),
    readPlan(d1, attemptId),
  ]);
  const current = attempt as AttemptRow;
  const items = events.results.map((row) => ({
    sequence: Number(row.sequence), kind: row.kind, payload: parseJson<Record<string, unknown>>(row.payload_json, {}), createdAt: row.created_at,
  }));
  const canDecidePlan = Boolean(plan && plan.decision === "pending" && current.status === "waiting_approval")
    && await canDecidePlanFor(user, current);
  return {
    attempt: attemptView(current),
    events: items,
    nextAfterSequence: items.length ? items[items.length - 1].sequence : afterSequence,
    changeRequest: changeRequestView(changeRequest),
    plan: planView(plan),
    permissions: { canDecidePlan },
  };
}

/** Owning student or a reviewer in scope, never the requester (no self-approval,
 * as for runs; superadmins included). Delegated code reviewers cannot decide. */
async function canDecidePlanFor(user: AppUser, attempt: AttemptRow) {
  if (user.id === Number(attempt.requested_by_user_id)) return false;
  return (await canViewStudent(user, attempt.student_id)) && canDecideTask(user, attempt.student_id);
}

export async function decideAgentPlan(d1: D1Database, user: AppUser, body: Record<string, unknown>) {
  const attemptId = parseEntityId(body.attemptId, "代理尝试");
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") throw inputError("decision 只能是 approved 或 rejected");
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") throw inputError("说明格式无效");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > MAX_PLAN_NOTE_CHARS) throw inputError(`说明不能超过 ${MAX_PLAN_NOTE_CHARS} 字`);
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    throw inputError("expectedVersion 无效");
  }
  const expectedVersion = body.expectedVersion;
  const attempt = await requireVisibleAttempt(d1, user, attemptId);
  const plan = await readPlan(d1, attemptId);
  if (!plan) throw conflictError("该代理尝试不是先出计划模式", "NOT_PLAN_FIRST");
  if (user.id === Number(attempt.requested_by_user_id)) throw forbiddenError("不能批准或退回自己发起的代理计划");
  if (!(await canDecideTask(user, attempt.student_id))) throw forbiddenError("只有学生本人或可审核该学生的导师可以决定代理计划");
  if (Number(plan.version) !== expectedVersion) throw conflictError("计划已被更新，请刷新后重试", "VERSION_CONFLICT");
  if (plan.decision !== "pending" || attempt.status !== "waiting_approval") throw conflictError("该计划当前不在待批准状态", "PLAN_NOT_PENDING");
  const target: AgentAttemptStatus = decision === "approved" ? "queued" : "canceled";
  transitionOrConflict(attempt.status, target);

  const now = nowIso();
  const decided = {
    // decided_at identifies this request's write, so a concurrent duplicate that
    // lost the CAS neither moves the attempt nor writes a second audit entry.
    sql: `EXISTS (SELECT 1 FROM agent_attempt_plans
      WHERE attempt_id = ? AND version = ? AND decision = ? AND decided_by_user_id = ? AND decided_at = ?)`,
    binds: [attemptId, expectedVersion + 1, decision, user.id, now],
  };
  const attemptUpdate = decision === "approved"
    ? d1.prepare(`UPDATE agent_attempts SET status = 'queued', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'waiting_approval' AND ${decided.sql}`).bind(attemptId, ...decided.binds)
    : d1.prepare(`UPDATE agent_attempts SET status = 'canceled', error_code = 'PLAN_REJECTED', error_message = ?, ended_at = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'waiting_approval' AND ${decided.sql}`)
      .bind((note ? `计划被退回：${note}` : "计划被退回").slice(0, 2000), now, attemptId, ...decided.binds);
  const results = await d1.batch([
    // CAS on the plan row version; the attempt only moves if this row moved.
    d1.prepare(`UPDATE agent_attempt_plans SET decision = ?, decided_by_user_id = ?, decided_at = ?, note = ?, version = version + 1
      WHERE attempt_id = ? AND version = ? AND decision = 'pending'
        AND EXISTS (SELECT 1 FROM agent_attempts WHERE id = ? AND status = 'waiting_approval')`)
      .bind(decision, user.id, now, note, attemptId, expectedVersion, attemptId),
    attemptUpdate,
    auditStatement(d1, attemptId, {
      action: decision === "approved" ? "plan_approved" : "plan_rejected", userId: user.id, planVersion: expectedVersion + 1,
      planSha256: plan.plan_sha256,
    }, decided),
  ]);
  if (!Number(results[0].meta.changes ?? 0) || !Number(results[1].meta.changes ?? 0)) {
    throw conflictError("计划已被更新，请刷新后重试", "VERSION_CONFLICT");
  }
  const [row, updated] = await Promise.all([readAttempt(d1, attemptId), readPlan(d1, attemptId)]);
  return { attempt: attemptView(row as AttemptRow), plan: planView(updated) };
}

// ---------------------------------------------------------------------------
// Lab protocol
// ---------------------------------------------------------------------------

export async function claimAgentAttempt(d1: D1Database, runner: LabRunner): Promise<AgentClaimResponse> {
  await expireAgentLeases(d1, { workerId: runner.id });
  for (let round = 0; round < 5; round += 1) {
    const { results } = await d1.prepare(`SELECT a.*, pl.decision AS plan_decision, pl.plan_text AS plan_text FROM agent_attempts a
      JOIN agent_credential_profiles p ON p.id = a.credential_profile_id
      LEFT JOIN agent_attempt_plans pl ON pl.attempt_id = a.id
      WHERE a.status = 'queued' AND p.worker_id = ?
      ORDER BY a.created_at, a.rowid LIMIT 10`).bind(runner.id).all<AttemptRow & { plan_decision: PlanDecision | null; plan_text: string | null }>();
    if (!results.length) return { work: null };
    for (const candidate of results) {
      const eligibility = await readEligibility(d1, candidate.id);
      const revoked = revocationReason(eligibility, candidate);
      if (revoked) {
        await d1.prepare(`UPDATE agent_attempts SET status = 'canceled', error_code = ?, error_message = ?,
          ended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'`)
          .bind(revoked.code, revoked.message, nowIso(), candidate.id).run();
        continue;
      }
      // FB2: a plan-first attempt is first claimed to plan, then (once approved)
      // to edit following the approved plan. Ordinary attempts always edit.
      if (candidate.plan_decision === "pending" || candidate.plan_decision === "rejected") {
        await d1.prepare(`UPDATE agent_attempts SET status = 'failed', error_code = 'PLAN_STATE_INVALID',
          error_message = '计划状态与尝试状态不一致，未派发', ended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'`)
          .bind(nowIso(), candidate.id).run();
        continue;
      }
      const mode: "plan" | "edit" = candidate.plan_decision === "awaiting_plan" ? "plan" : "edit";
      const approvedPlan = candidate.plan_decision === "approved" ? candidate.plan_text ?? "" : null;
      let snapshot: ResearchTaskSnapshot;
      try {
        snapshot = (await loadTaskVersionSnapshot(d1, candidate.task_id, Number(candidate.task_version))).snapshot;
        if (await agentContextSnapshotSha256(snapshot, candidate.base_commit_sha) !== candidate.context_snapshot_sha256) {
          throw new TaskSnapshotMismatchError("context");
        }
      } catch (error) {
        if (!(error instanceof TaskSnapshotMismatchError)) throw error;
        await d1.prepare(`UPDATE agent_attempts SET status = 'failed', error_code = 'SNAPSHOT_MISMATCH',
          error_message = '任务快照校验失败，未派发', ended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'`)
          .bind(nowIso(), candidate.id).run();
        continue;
      }
      transitionOrConflict(candidate.status, "running");
      const now = nowIso();
      const leaseExpiresAt = leaseUntil();
      const claimed = await d1.prepare(`UPDATE agent_attempts SET status = 'running', worker_id = ?, lease_epoch = lease_epoch + 1,
        lease_expires_at = ?, heartbeat_at = ?, started_at = COALESCE(started_at, ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'queued' RETURNING lease_epoch`)
        .bind(runner.id, leaseExpiresAt, now, now, candidate.id).first<{ lease_epoch: number }>();
      if (!claimed) continue;
      if (candidate.plan_decision) {
        await auditStatement(d1, candidate.id, {
          action: mode === "plan" ? "plan_phase_claimed" : "edit_phase_claimed", workerId: runner.id, leaseEpoch: Number(claimed.lease_epoch),
        }).run();
      }
      let repository: RepositoryReadAccess | null = null;
      if (eligibility?.installation_id && eligibility.full_name) {
        try {
          repository = await mintRepositoryReadToken({
            installationId: Number(eligibility.installation_id),
            repositoryId: Number(candidate.github_repository_id),
            fullName: eligibility.full_name,
          });
        } catch (error) {
          // Not configured (or GitHub unavailable): the worker falls back to its
          // own read-only access, as the contract allows.
          if (!(error instanceof GithubNotConfiguredError)) console.warn("agent claim: repository token unavailable");
          repository = null;
        }
      }
      return {
        work: {
          attemptId: candidate.id,
          leaseEpoch: Number(claimed.lease_epoch),
          leaseExpiresAt,
          provider: candidate.provider,
          modelId: candidate.model_id,
          credentialProfileId: candidate.credential_profile_id,
          baseCommitSha: candidate.base_commit_sha,
          mode,
          approvedPlan,
          task: snapshot,
          contextSnapshotSha256: candidate.context_snapshot_sha256,
          repository,
          repositoryId: Number(candidate.github_repository_id),
          repositoryFullName: eligibility?.full_name ?? "",
        },
      };
    }
  }
  return { work: null };
}

function parseLeaseRequest(body: Record<string, unknown>) {
  const attemptId = parseEntityId(body.attemptId, "代理尝试");
  if (typeof body.leaseEpoch !== "number" || !Number.isSafeInteger(body.leaseEpoch) || body.leaseEpoch < 1) {
    throw inputError("leaseEpoch 无效");
  }
  return { attemptId, leaseEpoch: body.leaseEpoch };
}

/** Lease fencing: the attempt must belong to this worker, carry the same epoch,
 * be active and have an unexpired lease. An expired lease is failed on the spot. */
async function requireLease(d1: D1Database, runner: LabRunner, attemptId: string, leaseEpoch: number) {
  const attempt = await readAttempt(d1, attemptId);
  if (!attempt) throw new ResearchLoopHttpError(404, "NOT_FOUND", "代理尝试不存在");
  if (attempt.worker_id !== runner.id || Number(attempt.lease_epoch) !== leaseEpoch) throw leaseLost();
  if (!["running", "waiting_approval", "cancel_requested"].includes(attempt.status)) return { attempt, active: false } as const;
  // FB2: a submitted plan releases the lease while it waits for a human.
  if (attempt.status === "waiting_approval" && !attempt.lease_expires_at) return { attempt, active: false } as const;
  if (!attempt.lease_expires_at || attempt.lease_expires_at < nowIso()) {
    await expireAgentLeases(d1, { attemptId });
    throw leaseLost();
  }
  return { attempt, active: true } as const;
}

async function flagRevocation(d1: D1Database, attempt: AttemptRow) {
  if (attempt.status !== "running" && attempt.status !== "waiting_approval") return attempt;
  const revoked = revocationReason(await readEligibility(d1, attempt.id), attempt);
  if (!revoked) return attempt;
  transitionOrConflict(attempt.status, "cancel_requested");
  const row = await d1.prepare(`UPDATE agent_attempts SET status = 'cancel_requested', error_code = ?, error_message = ?,
    cancel_requested_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND lease_epoch = ? AND status = ? RETURNING *`)
    .bind(revoked.code, revoked.message, nowIso(), attempt.id, attempt.lease_epoch, attempt.status).first<AttemptRow>();
  return row ?? attempt;
}

export async function heartbeatAgentAttempt(d1: D1Database, runner: LabRunner, body: Record<string, unknown>): Promise<AgentHeartbeatResponse> {
  const { attemptId, leaseEpoch } = parseLeaseRequest(body);
  const lease = await requireLease(d1, runner, attemptId, leaseEpoch);
  if (!lease.active) throw leaseLost();
  const attempt = await flagRevocation(d1, lease.attempt);
  const leaseExpiresAt = leaseUntil();
  const row = await d1.prepare(`UPDATE agent_attempts SET lease_expires_at = ?, heartbeat_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND worker_id = ? AND lease_epoch = ? AND status IN ('running', 'waiting_approval', 'cancel_requested')
    RETURNING status`).bind(leaseExpiresAt, nowIso(), attemptId, runner.id, leaseEpoch).first<{ status: AgentAttemptStatus }>();
  if (!row) throw leaseLost();
  return { leaseExpiresAt, cancelRequested: row.status === "cancel_requested" || attempt.status === "cancel_requested" };
}

export async function recordAgentEvents(d1: D1Database, runner: LabRunner, body: Record<string, unknown>) {
  const { attemptId, leaseEpoch } = parseLeaseRequest(body);
  if (!Array.isArray(body.events) || !body.events.length) throw inputError("events 不能为空");
  if (body.events.length > LIMITS.maxAgentEventsPerRequest) throw tooLarge(`每次最多上报 ${LIMITS.maxAgentEventsPerRequest} 条事件`);
  const events: { sequence: number; kind: AgentEvent["kind"]; payloadJson: string }[] = [];
  let previous = 0;
  for (const raw of body.events as unknown[]) {
    if (!isPlainObject(raw)) throw inputError("事件格式无效");
    const { sequence, kind, payload } = raw;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw inputError("事件序号无效");
    if (sequence <= previous) throw inputError("同一请求内事件序号必须严格递增");
    previous = sequence;
    if (typeof kind !== "string" || !(ATTEMPT_EVENT_KINDS as readonly string[]).includes(kind)) throw inputError("事件类型无效");
    if (!isPlainObject(payload)) throw inputError("事件内容必须是对象");
    let payloadJson: string;
    try { payloadJson = canonicalJson(payload); }
    catch { throw inputError("事件内容不是有效 JSON"); }
    if (byteLength(payloadJson) > LIMITS.maxAgentEventPayloadBytes) {
      throw tooLarge(`事件内容超过 ${LIMITS.maxAgentEventPayloadBytes} 字节上限（序号 ${sequence}）`);
    }
    events.push({ sequence, kind: kind as AgentEvent["kind"], payloadJson });
  }
  const lease = await requireLease(d1, runner, attemptId, leaseEpoch);
  if (!lease.active) throw leaseLost();
  const offset = await editPhaseSequenceOffset(d1, attemptId);
  const stored = await d1.prepare("SELECT count(*) AS n FROM agent_attempt_events WHERE attempt_id = ? AND sequence > 0").bind(attemptId).first<{ n: number }>();
  if (Number(stored?.n ?? 0) + events.length > MAX_AGENT_EVENTS_PER_ATTEMPT) {
    throw tooLarge(`单个代理尝试最多保存 ${MAX_AGENT_EVENTS_PER_ATTEMPT} 条事件`);
  }
  const results = await d1.batch(events.map((event) => d1.prepare(`INSERT INTO agent_attempt_events
    (attempt_id, sequence, kind, payload_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_id, sequence) DO NOTHING`).bind(attemptId, event.sequence + offset, event.kind, event.payloadJson)));
  const accepted = results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
  const last = await d1.prepare("SELECT max(sequence) AS s FROM agent_attempt_events WHERE attempt_id = ? AND sequence > ?")
    .bind(attemptId, offset).first<{ s: number | null }>();
  return {
    accepted,
    duplicates: events.length - accepted,
    // In the worker's own numbering (edit phase: relative to the plan phase).
    lastSequence: last?.s === null || last?.s === undefined ? 0 : Number(last.s) - offset,
    cancelRequested: lease.attempt.status === "cancel_requested",
  };
}

type ParsedFile = ChangedFile & { bytes: number };

function decodeBase64(value: string) {
  if (value.length % 4 !== 0 || !BASE64.test(value)) throw invalidResult("文件内容不是有效的 base64");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function parseChangedFiles(value: unknown): Promise<{ files: ParsedFile[]; rawPaths: unknown[] }> {
  if (!Array.isArray(value)) throw invalidResult("files 必须是列表");
  if (value.length > LIMITS.maxChangedFiles) throw tooLarge(`改动文件不能超过 ${LIMITS.maxChangedFiles} 个`);
  const files: ParsedFile[] = [];
  const rawPaths: unknown[] = [];
  let total = 0;
  for (const raw of value as unknown[]) {
    if (!isPlainObject(raw)) throw invalidResult("改动文件格式无效");
    rawPaths.push(raw.path);
    if (raw.action !== "add" && raw.action !== "modify" && raw.action !== "delete") throw invalidResult("改动类型无效");
    if (raw.mode !== undefined && raw.mode !== "100644" && raw.mode !== "100755") throw invalidResult("文件模式无效");
    const file: ParsedFile = { path: typeof raw.path === "string" ? raw.path : "", action: raw.action, bytes: 0 };
    if (raw.mode !== undefined) file.mode = raw.mode;
    if (raw.action === "delete") {
      if (raw.contentBase64 !== undefined || raw.sha256 !== undefined) throw invalidResult("删除操作不能携带文件内容");
    } else {
      if (typeof raw.contentBase64 !== "string" || typeof raw.sha256 !== "string") throw invalidResult("新增或修改的文件必须提供内容和 sha256");
      if (raw.contentBase64.length > Math.ceil(LIMITS.maxChangedFileBytes / 3) * 4) throw tooLarge(`单个文件不能超过 ${LIMITS.maxChangedFileBytes} 字节`);
      const bytes = decodeBase64(raw.contentBase64);
      if (bytes.byteLength > LIMITS.maxChangedFileBytes) throw tooLarge(`单个文件不能超过 ${LIMITS.maxChangedFileBytes} 字节`);
      total += bytes.byteLength;
      if (total > LIMITS.maxChangeTotalBytes) throw tooLarge(`改动总量不能超过 ${LIMITS.maxChangeTotalBytes} 字节`);
      if (await sha256Hex(bytes) !== raw.sha256) throw invalidResult("文件 sha256 与内容不一致");
      file.contentBase64 = raw.contentBase64;
      file.sha256 = raw.sha256;
      file.bytes = bytes.byteLength;
    }
    files.push(file);
  }
  return { files, rawPaths };
}

function parseTests(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw invalidResult("tests 需为不超过 100 项的列表");
  return value.map((item) => {
    if (!isPlainObject(item) || typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode)) throw invalidResult("测试记录格式无效");
    return {
      command: shortText(item.command, "测试命令", 2000),
      exitCode: item.exitCode,
      summary: shortText(item.summary, "测试摘要", 4000),
    };
  });
}

function parseUsage(value: unknown) {
  if (value === undefined || value === null) return "{}";
  if (!isPlainObject(value)) throw invalidResult("usage 必须是对象");
  let json: string;
  try { json = canonicalJson(value); } catch { throw invalidResult("usage 不是有效 JSON"); }
  if (byteLength(json) > LIMITS.maxAgentEventPayloadBytes) throw tooLarge("usage 过大");
  return json;
}

export const agentChangeR2Key = (attemptId: string) => `agent-attempts/${attemptId}/change.json`;
export const changeRequestBranchName = (taskId: string, attemptId: string) => `tanyan/${taskId.slice(-8)}/${attemptId.slice(-8)}`;

async function resultResponse(d1: D1Database, attempt: AttemptRow, replayed: boolean, policy?: { outsideAllowed: string[]; protectedTouched: string[] }) {
  const changeRequest = await readChangeRequest(d1, attempt.id);
  return {
    status: attempt.status,
    errorCode: attempt.error_code,
    diffSha256: attempt.diff_sha256,
    changeRequest: changeRequest ? {
      id: changeRequest.id, status: changeRequest.status, branchName: changeRequest.branch_name,
      requiresExtraReview: Boolean(changeRequest.requires_extra_review),
    } : null,
    policy: policy ?? null,
    replayed,
  };
}

export async function submitAgentResult(d1: D1Database, bucket: R2Bucket | undefined, runner: LabRunner, body: Record<string, unknown>) {
  const { attemptId, leaseEpoch } = parseLeaseRequest(body);
  const outcome = body.outcome;
  if (outcome !== "change_ready" && outcome !== "failed" && outcome !== "canceled" && outcome !== "plan_ready") throw invalidResult("outcome 无效");
  let plan = "";
  if (outcome === "plan_ready") {
    if (typeof body.plan !== "string" || !body.plan.trim()) throw invalidResult("plan_ready 结果必须包含非空的 plan");
    if (body.plan.length > MAX_AGENT_PLAN_CHARS) throw tooLarge(`计划不能超过 ${MAX_AGENT_PLAN_CHARS} 字`);
    if (body.files !== undefined && body.files !== null && !(Array.isArray(body.files) && body.files.length === 0)) {
      throw invalidResult("plan_ready 结果不能包含改动文件");
    }
    if (body.unifiedDiff !== undefined && body.unifiedDiff !== null && body.unifiedDiff !== "") throw invalidResult("plan_ready 结果不能包含 diff");
    plan = body.plan;
  } else if (body.plan !== undefined && body.plan !== null && body.plan !== "") {
    throw invalidResult("只有 plan_ready 结果可以携带 plan");
  }
  const modelId = shortText(body.modelId, "modelId", 200);
  const sdkVersion = shortText(body.sdkVersion, "sdkVersion", 200);
  const tests = parseTests(body.tests);
  const usageJson = parseUsage(body.usage);
  const workerErrorCode = shortText(body.errorCode, "errorCode", 64);
  if (workerErrorCode && !ERROR_CODE.test(workerErrorCode)) throw invalidResult("errorCode 格式无效");
  const workerErrorMessage = shortText(body.errorMessage, "errorMessage", 2000);

  const lease = await requireLease(d1, runner, attemptId, leaseEpoch);
  // Same-epoch retry after a recorded result: answer with what was stored.
  if (!lease.active) return resultResponse(d1, lease.attempt, true);
  const attempt = lease.attempt;
  const now = nowIso();
  // FB2: plan mode = plan-first attempt whose plan has not been submitted yet.
  const planRow = await d1.prepare("SELECT decision FROM agent_attempt_plans WHERE attempt_id = ?").bind(attemptId).first<{ decision: PlanDecision }>();
  const planMode = planRow?.decision === "awaiting_plan";
  if (outcome === "plan_ready" && !planMode) throw invalidResult("plan_ready 只能在计划模式下提交");
  if (outcome === "change_ready" && planMode) throw invalidResult("计划模式下不能提交代码改动，请先提交 plan_ready 等待批准");

  const finish = async (status: AgentAttemptStatus, errorCode: string, errorMessage: string, changedPaths: string[] = [],
    policy?: { outsideAllowed: string[]; protectedTouched: string[] }) => {
    transitionOrConflict(attempt.status, status);
    const row = await d1.prepare(`UPDATE agent_attempts SET status = ?, model_id = ?, sdk_version = ?, changed_paths_json = ?,
      tests_json = ?, usage_json = ?, error_code = ?, error_message = ?, ended_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND worker_id = ? AND lease_epoch = ? AND status = ? RETURNING *`)
      .bind(status, modelId, sdkVersion, JSON.stringify(changedPaths), JSON.stringify(tests), usageJson,
        errorCode, errorMessage.slice(0, 2000), now, attemptId, runner.id, leaseEpoch, attempt.status).first<AttemptRow>();
    if (!row) throw leaseLost();
    return resultResponse(d1, row, false, policy);
  };

  // Re-verify authorization at result time (pack §5, T12): a revoked attempt
  // never produces a change request.
  const revoked = revocationReason(await readEligibility(d1, attemptId), attempt);
  if (revoked) {
    return finish(attempt.status === "cancel_requested" ? "canceled" : "failed", revoked.code, revoked.message);
  }

  if (outcome === "failed") return finish("failed", workerErrorCode || "AGENT_FAILED", workerErrorMessage || "代理执行失败");
  if (outcome === "canceled") {
    // Only a requested cancel ends as canceled; a worker-side stop is a failure.
    return attempt.status === "cancel_requested"
      ? finish("canceled", workerErrorCode || attempt.error_code || "CANCELED", workerErrorMessage || attempt.error_message || "代理执行已取消")
      : finish("failed", workerErrorCode || "CANCELED", workerErrorMessage || "代理工作进程中止了执行");
  }
  if (outcome === "plan_ready") return submitPlan(d1, runner, attempt, { plan, modelId, sdkVersion, tests, usageJson, finish });

  transitionOrConflict(attempt.status, "change_ready");
  const { files, rawPaths } = await parseChangedFiles(body.files);
  if (!files.length) throw invalidResult("change_ready 结果必须包含至少一个改动文件；没有改动请上报 failed");
  if (typeof body.unifiedDiff !== "string") throw invalidResult("unifiedDiff 必须是字符串");
  const unifiedDiff = body.unifiedDiff;
  if (byteLength(unifiedDiff) > LIMITS.maxDiffBytes) throw tooLarge(`diff 不能超过 ${LIMITS.maxDiffBytes} 字节`);

  // Path policy against the attempt's own (immutable) task version (T04/T05).
  const version = await d1.prepare(`SELECT allowed_paths_json, protected_paths_json FROM research_task_versions
    WHERE task_id = ? AND version = ?`).bind(attempt.task_id, attempt.task_version)
    .first<{ allowed_paths_json: string; protected_paths_json: string }>();
  if (!version) throw new ResearchLoopHttpError(500, "SNAPSHOT_MISMATCH", "任务版本不存在");
  let policy;
  try {
    policy = evaluatePathPolicy(rawPaths, parseJson<string[]>(version.allowed_paths_json, []), parseJson<string[]>(version.protected_paths_json, []));
  } catch (error) {
    if (!(error instanceof PathPolicyError)) throw error;
    return finish("failed", "POLICY_VIOLATION", `改动包含非法路径：${error.message}`, [], { outsideAllowed: [], protectedTouched: [] });
  }
  if (policy.paths.length !== files.length) throw invalidResult("改动文件路径重复");
  const pathPolicy = { outsideAllowed: policy.outsideAllowed, protectedTouched: policy.protectedTouched };
  if (policy.outsideAllowed.length) {
    return finish("failed", "POLICY_VIOLATION", `改动超出任务允许范围：${policy.outsideAllowed.slice(0, 20).join(", ")}`, policy.paths, pathPolicy);
  }

  if (!bucket) throw new ResearchLoopHttpError(503, "STORAGE_NOT_CONFIGURED", "文件存储尚未配置");
  const normalizedFiles: ChangedFile[] = files.map((file) => {
    const item: ChangedFile = { path: normalizeRepoPath(file.path), action: file.action };
    if (file.contentBase64 !== undefined) item.contentBase64 = file.contentBase64;
    if (file.sha256 !== undefined) item.sha256 = file.sha256;
    if (file.mode !== undefined) item.mode = file.mode;
    return item;
  }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const changeJson = canonicalJson({ files: normalizedFiles, unifiedDiff } as unknown as JsonValue);
  const diffSha256 = await sha256Hex(changeJson);
  const r2Key = agentChangeR2Key(attemptId);
  await bucket.put(r2Key, changeJson, {
    sha256: diffSha256,
    httpMetadata: { contentType: "application/json" },
    customMetadata: { attemptId, sha256: diffSha256 },
  });

  const changeRequestId = newId("cr");
  const requiresExtraReview = policy.protectedTouched.length ? 1 : 0;
  let batch: D1Result<AttemptRow>[];
  try {
    batch = await d1.batch<AttemptRow>([
      d1.prepare(`UPDATE agent_attempts SET status = 'change_ready', model_id = ?, sdk_version = ?, diff_sha256 = ?, diff_r2_key = ?,
        changed_paths_json = ?, tests_json = ?, usage_json = ?, error_code = '', error_message = '', ended_at = ?,
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND worker_id = ? AND lease_epoch = ? AND status = ? RETURNING *`)
        .bind(modelId, sdkVersion, diffSha256, r2Key, JSON.stringify(policy.paths), JSON.stringify(tests), usageJson, now,
          attemptId, runner.id, leaseEpoch, attempt.status),
      d1.prepare(`INSERT INTO change_requests
        (id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, status, requires_extra_review)
        SELECT ?, task_id, id, student_id, github_repository_id, base_commit_sha, ?, 'pending_review', ?
        FROM agent_attempts WHERE id = ? AND status = 'change_ready' AND lease_epoch = ? AND diff_sha256 = ?`)
        .bind(changeRequestId, changeRequestBranchName(attempt.task_id, attemptId), requiresExtraReview,
          attemptId, leaseEpoch, diffSha256),
    ]);
  } catch (error) {
    if (!isConstraintError(error)) throw error;
    const current = await readAttempt(d1, attemptId);
    if (current && current.status === "change_ready" && Number(current.lease_epoch) === leaseEpoch) return resultResponse(d1, current, true);
    throw conflictError("变更请求创建冲突");
  }
  const row = batch[0].results[0];
  if (!row) throw leaseLost();
  await notifyLoopEvent(d1, { kind: "change_request", changeRequestId, actorUserId: null });
  return resultResponse(d1, row, false, pathPolicy);
}

/** plan_ready: store the plan, move to waiting_approval and release the lease,
 * atomically. A pending cancel ends the attempt instead of asking for approval. */
async function submitPlan(d1: D1Database, runner: LabRunner, attempt: AttemptRow, input: {
  plan: string; modelId: string; sdkVersion: string; tests: unknown[]; usageJson: string;
  finish: (status: AgentAttemptStatus, errorCode: string, errorMessage: string) => Promise<Awaited<ReturnType<typeof resultResponse>>>;
}) {
  if (attempt.status === "cancel_requested") {
    return input.finish("canceled", attempt.error_code || "CANCELED", attempt.error_message || "代理执行已取消");
  }
  transitionOrConflict(attempt.status, "waiting_approval");
  const leaseEpoch = Number(attempt.lease_epoch);
  const planSha256 = await sha256Hex(input.plan);
  const submittedAt = nowIso();
  const results = await d1.batch<AttemptRow>([
    d1.prepare(`UPDATE agent_attempts SET status = 'waiting_approval', model_id = ?, sdk_version = ?, tests_json = ?, usage_json = ?,
      lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND worker_id = ? AND lease_epoch = ? AND status = ?
        AND EXISTS (SELECT 1 FROM agent_attempt_plans WHERE attempt_id = ? AND decision = 'awaiting_plan') RETURNING *`)
      .bind(input.modelId, input.sdkVersion, JSON.stringify(input.tests), input.usageJson, attempt.id, runner.id, leaseEpoch, attempt.status,
        attempt.id),
    d1.prepare(`UPDATE agent_attempt_plans SET plan_text = ?, plan_sha256 = ?, submitted_at = ?, decision = 'pending', version = version + 1
      WHERE attempt_id = ? AND decision = 'awaiting_plan'
        AND EXISTS (SELECT 1 FROM agent_attempts WHERE id = ? AND status = 'waiting_approval' AND lease_epoch = ? AND lease_expires_at IS NULL)`)
      .bind(input.plan, planSha256, submittedAt, attempt.id, attempt.id, leaseEpoch),
    // The plan phase's last worker sequence is kept for the edit-phase offset.
    d1.prepare(`INSERT INTO agent_attempt_events (attempt_id, sequence, kind, payload_json)
      SELECT ?, COALESCE((SELECT MIN(sequence) FROM agent_attempt_events WHERE attempt_id = ? AND sequence < 0), 0) - 1, 'status',
        json_set(?, '$.lastWorkerSequence', (SELECT COALESCE(MAX(sequence), 0) FROM agent_attempt_events WHERE attempt_id = ? AND sequence > 0))
      WHERE EXISTS (SELECT 1 FROM agent_attempt_plans WHERE attempt_id = ? AND decision = 'pending' AND submitted_at = ?)`)
      .bind(attempt.id, attempt.id, JSON.stringify({ source: "platform", action: "plan_submitted", workerId: runner.id, leaseEpoch, planSha256 }),
        attempt.id, attempt.id, submittedAt),
  ]);
  const row = results[0].results[0];
  if (!row) throw leaseLost();
  await notifyLoopEvent(d1, { kind: "plan_submitted", attemptId: attempt.id });
  return resultResponse(d1, row, false);
}

// ---------------------------------------------------------------------------
// Superadmin: credential profile mapping (never secrets)
// ---------------------------------------------------------------------------

type ProfileRow = {
  id: string;
  user_id: number;
  provider: string;
  worker_id: string;
  active: number;
  created_by_user_id: number | null;
  created_at: string;
  user_display_name: string;
  worker_label: string;
  worker_status: string;
};

function profileView(row: ProfileRow) {
  return {
    id: row.id,
    userId: row.user_id,
    userDisplayName: row.user_display_name,
    provider: row.provider,
    workerId: row.worker_id,
    workerLabel: row.worker_label,
    workerStatus: row.worker_status,
    active: Boolean(row.active),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

const PROFILE_SELECT = `SELECT p.id, p.user_id, p.provider, p.worker_id, p.active, p.created_by_user_id, p.created_at,
  u.display_name AS user_display_name, r.label AS worker_label, r.status AS worker_status
  FROM agent_credential_profiles p JOIN app_users u ON u.id = p.user_id JOIN lab_runners r ON r.id = p.worker_id`;

export async function listCredentialProfiles(d1: D1Database) {
  const [profiles, workers] = await Promise.all([
    d1.prepare(`${PROFILE_SELECT} ORDER BY p.active DESC, u.display_name, p.provider`).all<ProfileRow>(),
    d1.prepare(`SELECT id, label, status, last_seen_at FROM lab_runners WHERE kind = 'agent' ORDER BY label`)
      .all<{ id: string; label: string; status: string; last_seen_at: string | null }>(),
  ]);
  return {
    profiles: profiles.results.map(profileView),
    workers: workers.results.map((row) => ({ id: row.id, label: row.label, status: row.status, lastSeenAt: row.last_seen_at })),
  };
}

const PROFILE_FIELDS = new Set(["action", "userId", "provider", "workerId", "id"]);

export async function changeCredentialProfile(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const extra = Object.keys(body).filter((key) => !PROFILE_FIELDS.has(key));
  if (extra.length) throw inputError("平台不接收或保存任何代理凭据，只记录用户、提供商与工作进程的对应关系");
  if (body.action === "deactivate") {
    const id = parseEntityId(body.id, "凭据档案");
    const row = await d1.prepare("UPDATE agent_credential_profiles SET active = 0 WHERE id = ? RETURNING id").bind(id).first();
    if (!row) throw notFoundError("凭据档案不存在");
  } else if (body.action === "create") {
    if (typeof body.userId !== "number" || !Number.isSafeInteger(body.userId) || body.userId < 1) throw inputError("用户参数无效");
    const provider = parseProvider(body.provider);
    const workerId = parseEntityId(body.workerId, "工作进程");
    const user = await d1.prepare("SELECT id, role FROM app_users WHERE id = ? AND active = 1").bind(body.userId).first<{ id: number; role: string }>();
    if (!user || user.role === "pending") throw notFoundError("用户不存在、已停用或尚未授权");
    const worker = await d1.prepare("SELECT id FROM lab_runners WHERE id = ? AND kind = 'agent' AND status = 'active'").bind(workerId).first();
    if (!worker) throw notFoundError("代理工作进程不存在或已停用");
    const existing = await d1.prepare("SELECT id, active FROM agent_credential_profiles WHERE user_id = ? AND provider = ?")
      .bind(body.userId, provider).first<{ id: string; active: number }>();
    if (existing?.active) throw conflictError("该用户已有此提供商的有效凭据档案，请先停用");
    if (existing) {
      await d1.prepare("UPDATE agent_credential_profiles SET active = 1, worker_id = ?, created_by_user_id = ? WHERE id = ? AND active = 0")
        .bind(workerId, actor.id, existing.id).run();
    } else {
      try {
        await d1.prepare(`INSERT INTO agent_credential_profiles (id, user_id, provider, worker_id, active, created_by_user_id)
          VALUES (?, ?, ?, ?, 1, ?)`).bind(newId("cred"), body.userId, provider, workerId, actor.id).run();
      } catch (error) {
        if (isConstraintError(error)) throw conflictError("该用户已有此提供商的凭据档案");
        throw error;
      }
    }
  } else {
    throw inputError("不支持的操作");
  }
  return listCredentialProfiles(d1);
}

