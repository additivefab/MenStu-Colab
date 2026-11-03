// Change request reads and user actions (spec §6.2). Authorization follows
// spec §5: viewers need canViewStudent; publishing is allowed to the student
// owner or a reviewer in scope (canReviewStudent); extra review of protected
// paths needs a reviewer who did not start the agent attempt.
// FB1: a delegated peer reviewer (canCodeReviewStudent) may read the student's
// change requests and publish or reject those with requires_extra_review = 0
// whose attempt they did not request; never extra review.
import { canReviewStudent, canViewStudent } from "../authorization";
import type { AppUser } from "../feishu-auth";
import { canCodeReviewStudent } from "../review-delegation";
import { LIMITS } from "../research-loop/contracts.ts";
import { changeObjectKey } from "./publisher.ts";

export class ChangeRequestInputError extends Error {}
export class ChangeRequestNotFoundError extends Error {}
export class ChangeRequestForbiddenError extends Error {}
export class ChangeRequestConflictError extends Error {
  readonly code: string;
  constructor(message: string, code = "VERSION_CONFLICT") {
    super(message);
    this.code = code;
  }
}

type ChangeRequestRow = {
  id: string;
  task_id: string;
  attempt_id: string;
  student_id: string;
  github_repository_id: number;
  base_commit_sha: string;
  branch_name: string;
  head_commit_sha: string | null;
  pr_number: number | null;
  pr_url: string;
  status: string;
  requires_extra_review: number;
  extra_review_approved_by_user_id: number | null;
  extra_review_approved_at: string | null;
  published_by_user_id: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  provider: string;
  model_id: string;
  attempt_requested_by_user_id: number;
};

const SELECT = `SELECT cr.id, cr.task_id, cr.attempt_id, cr.student_id, cr.github_repository_id, cr.base_commit_sha,
    cr.branch_name, cr.head_commit_sha, cr.pr_number, cr.pr_url, cr.status, cr.requires_extra_review,
    cr.extra_review_approved_by_user_id, cr.extra_review_approved_at, cr.published_by_user_id, cr.version,
    cr.created_at, cr.updated_at, a.provider, a.model_id, a.requested_by_user_id AS attempt_requested_by_user_id
  FROM change_requests cr JOIN agent_attempts a ON a.id = cr.attempt_id`;

export type ChangeRequestPermissions = { canPublish: boolean; canApproveExtraReview: boolean; canReject: boolean };

function isOwner(user: AppUser, studentId: string) {
  return user.role === "student" && user.studentId === studentId;
}

/** Delegated peer review applies only to non-protected changes the delegate
 * did not request themself. Returns false for owners and full reviewers. */
function peerReviewable(user: AppUser, row: ChangeRequestRow) {
  return !Number(row.requires_extra_review) && Number(row.attempt_requested_by_user_id) !== user.id;
}

async function permissions(d1: D1Database, user: AppUser, row: ChangeRequestRow): Promise<ChangeRequestPermissions> {
  const reviewer = await canReviewStudent(user, row.student_id);
  const owner = isOwner(user, row.student_id);
  const peer = !owner && !reviewer && peerReviewable(user, row) && await canCodeReviewStudent(d1, user, row.student_id);
  const actionable = ["pending_review", "failed"].includes(row.status);
  const reviewDone = !row.requires_extra_review || Boolean(row.extra_review_approved_at);
  return {
    canPublish: (owner || reviewer || peer) && reviewDone && (actionable || row.status === "publishing"),
    canApproveExtraReview: reviewer && actionable && Boolean(row.requires_extra_review) && !row.extra_review_approved_at
      && Number(row.attempt_requested_by_user_id) !== user.id,
    canReject: (owner || reviewer || peer) && actionable,
  };
}

function present(row: ChangeRequestRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    studentId: row.student_id,
    baseCommitSha: row.base_commit_sha,
    branchName: row.branch_name,
    headCommitSha: row.head_commit_sha,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    status: row.status,
    requiresExtraReview: Boolean(row.requires_extra_review),
    extraReviewApprovedByUserId: row.extra_review_approved_by_user_id,
    extraReviewApprovedAt: row.extra_review_approved_at,
    publishedByUserId: row.published_by_user_id,
    provider: row.provider,
    modelId: row.model_id,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseId(value: unknown, prefix: "cr" | "task") {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,64}$`).test(value)) {
    throw new ChangeRequestInputError(prefix === "cr" ? "变更请求参数无效" : "任务参数无效");
  }
  return value;
}

export function parseExpectedVersion(body: Record<string, unknown>) {
  const value = body.expectedVersion ?? body.version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ChangeRequestInputError("版本参数无效，请重新载入");
  }
  return value;
}

async function canReadStudentChanges(d1: D1Database, user: AppUser, studentId: string) {
  return (await canViewStudent(user, studentId)) || canCodeReviewStudent(d1, user, studentId);
}

/** Loads a row the user may view (viewers of the student and delegated peer
 * reviewers). Out-of-scope rows look exactly like missing rows so IDs from
 * another student never confirm existence (T01/T03). */
export async function loadVisibleChangeRequest(d1: D1Database, user: AppUser, id: string) {
  const row = await d1.prepare(`${SELECT} WHERE cr.id = ?`).bind(id).first<ChangeRequestRow>();
  if (!row || !(await canReadStudentChanges(d1, user, row.student_id))) throw new ChangeRequestNotFoundError("变更请求不存在或无权查看");
  return row;
}

type ActorKind = "owner" | "reviewer" | "peer";

/** Who may publish or reject: the owner student, a reviewer in scope, or a
 * delegated peer reviewer for non-protected changes they did not request. */
async function requireDecider(d1: D1Database, user: AppUser, row: ChangeRequestRow, verb: string): Promise<ActorKind> {
  if (isOwner(user, row.student_id)) return "owner";
  if (await canReviewStudent(user, row.student_id)) return "reviewer";
  if (await canCodeReviewStudent(d1, user, row.student_id)) {
    if (Number(row.requires_extra_review)) throw new ChangeRequestForbiddenError("修改涉及受保护路径，只能由导师审查");
    if (Number(row.attempt_requested_by_user_id) === user.id) throw new ChangeRequestForbiddenError("不能审查自己发起的代理修改");
    return "peer";
  }
  throw new ChangeRequestForbiddenError(`只有学生本人或有审核权限的导师可以${verb}`);
}

export async function readChangeRequestDetail(d1: D1Database, files: R2Bucket, user: AppUser, id: string) {
  const row = await loadVisibleChangeRequest(d1, user, id);
  let change: { paths: { path: string; action: string }[]; unifiedDiff: string; diffTruncated: boolean } | null = null;
  const object = await files.get(changeObjectKey(row.attempt_id));
  if (object && object.size <= LIMITS.maxChangeTotalBytes * 2 + LIMITS.maxDiffBytes) {
    try {
      const parsed = JSON.parse(await object.text()) as { files?: { path?: unknown; action?: unknown }[]; unifiedDiff?: unknown };
      const diff = typeof parsed.unifiedDiff === "string" ? parsed.unifiedDiff : "";
      const cap = 200_000;
      change = {
        paths: (parsed.files ?? []).slice(0, LIMITS.maxChangedFiles).map((file) => ({ path: String(file?.path ?? ""), action: String(file?.action ?? "") })),
        unifiedDiff: diff.slice(0, cap),
        diffTruncated: diff.length > cap,
      };
    } catch { change = null; }
  }
  return { changeRequest: present(row), change, permissions: await permissions(d1, user, row) };
}

export async function listTaskChangeRequests(d1: D1Database, user: AppUser, taskId: string) {
  const task = await d1.prepare("SELECT student_id FROM research_tasks WHERE id = ?").bind(taskId).first<{ student_id: string }>();
  if (!task || !(await canReadStudentChanges(d1, user, task.student_id))) throw new ChangeRequestNotFoundError("任务不存在或无权查看");
  const { results } = await d1.prepare(`${SELECT} WHERE cr.task_id = ? ORDER BY cr.created_at DESC, cr.id`).bind(taskId).all<ChangeRequestRow>();
  return {
    changeRequests: await Promise.all(results.map(async (row) => ({ ...present(row), permissions: await permissions(d1, user, row) }))),
  };
}

async function explainCasFailure(d1: D1Database, id: string, expectedVersion: number): Promise<never> {
  const current = await d1.prepare("SELECT version, status, requires_extra_review, extra_review_approved_at FROM change_requests WHERE id = ?")
    .bind(id).first<{ version: number; status: string; requires_extra_review: number; extra_review_approved_at: string | null }>();
  if (!current || Number(current.version) !== expectedVersion) throw new ChangeRequestConflictError("变更请求已被更新，请重新载入");
  if (current.requires_extra_review && !current.extra_review_approved_at) {
    throw new ChangeRequestConflictError("修改涉及受保护路径，需先由导师完成额外审查", "EXTRA_REVIEW_REQUIRED");
  }
  throw new ChangeRequestConflictError("当前状态不允许此操作", "INVALID_STATE");
}

/** Moves the row to `publishing` (CAS). The caller then runs the publisher. */
export async function claimPublish(d1: D1Database, user: AppUser, id: string, expectedVersion: number) {
  const row = await loadVisibleChangeRequest(d1, user, id);
  const actor = await requireDecider(d1, user, row, "发布");
  // A peer reviewer's claim additionally requires a non-protected change at the
  // moment of the CAS, so a concurrent protected-path flag cannot slip through.
  const claimed = await d1.prepare(`UPDATE change_requests SET status = 'publishing', published_by_user_id = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND version = ? AND status IN ('pending_review', 'failed', 'publishing')
      AND (requires_extra_review = 0 OR extra_review_approved_at IS NOT NULL)
      ${actor === "peer" ? "AND requires_extra_review = 0" : ""}
    RETURNING id`).bind(user.id, id, expectedVersion).first();
  if (!claimed) {
    if (actor === "peer") {
      const current = await d1.prepare("SELECT version, requires_extra_review FROM change_requests WHERE id = ?").bind(id)
        .first<{ version: number; requires_extra_review: number }>();
      if (current && Number(current.version) === expectedVersion && Number(current.requires_extra_review)) {
        throw new ChangeRequestForbiddenError("修改涉及受保护路径，只能由导师审查");
      }
    }
    await explainCasFailure(d1, id, expectedVersion);
  }
}

export async function approveExtraReview(d1: D1Database, user: AppUser, id: string, expectedVersion: number) {
  const row = await loadVisibleChangeRequest(d1, user, id);
  if (!(await canReviewStudent(user, row.student_id))) throw new ChangeRequestForbiddenError("只有有审核权限的导师或超级管理员可以完成额外审查");
  if (Number(row.attempt_requested_by_user_id) === user.id) throw new ChangeRequestForbiddenError("不能审查自己发起的代理修改");
  const updated = await d1.prepare(`UPDATE change_requests SET extra_review_approved_by_user_id = ?,
      extra_review_approved_at = CURRENT_TIMESTAMP, version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND version = ? AND requires_extra_review = 1 AND extra_review_approved_at IS NULL
      AND status IN ('pending_review', 'failed') RETURNING id`).bind(user.id, id, expectedVersion).first();
  if (!updated) {
    const current = await d1.prepare("SELECT version, requires_extra_review FROM change_requests WHERE id = ?").bind(id)
      .first<{ version: number; requires_extra_review: number }>();
    if (current && Number(current.version) === expectedVersion && !current.requires_extra_review) {
      throw new ChangeRequestConflictError("该变更不需要额外审查", "INVALID_STATE");
    }
    await explainCasFailure(d1, id, expectedVersion);
  }
}

export async function rejectChangeRequest(d1: D1Database, user: AppUser, id: string, expectedVersion: number) {
  const row = await loadVisibleChangeRequest(d1, user, id);
  const actor = await requireDecider(d1, user, row, "驳回");
  const updated = await d1.prepare(`UPDATE change_requests SET status = 'rejected', version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND version = ? AND status IN ('pending_review', 'failed')
      ${actor === "peer" ? "AND requires_extra_review = 0" : ""} RETURNING id`).bind(id, expectedVersion).first();
  if (!updated) {
    const current = await d1.prepare("SELECT version FROM change_requests WHERE id = ?").bind(id).first<{ version: number }>();
    if (!current || Number(current.version) !== expectedVersion) throw new ChangeRequestConflictError("变更请求已被更新，请重新载入");
    throw new ChangeRequestConflictError("当前状态不允许此操作", "INVALID_STATE");
  }
}
