import { isOwnStudentRecord } from "./access-policy";
import { canReviewStudent } from "./authorization";
import type { AppUser } from "./feishu-auth";

// FB1 (batch 5): peer code review. A reviewer in scope of a student (or a
// superadmin) may delegate routine code review (G2) of that student's change
// requests to another active user, typically a senior student or an engineer.
// A delegation grants only:
//   - read access to that student's research-loop tasks, attempts and change requests;
//   - publish / reject of change requests with requires_extra_review = 0 that the
//     delegate did not request themself.
// It never implies canViewStudent (progress, guidance, runs, results), run
// approval, extra review of protected paths or result review.

/** Validity of an active delegation row `rd`, checked on every request so
 * revocation (of the delegation, the student, the delegate or the delegator's
 * own review scope) takes effect immediately (T12). */
export const VALID_DELEGATION_SQL = `rd.active = 1
  AND EXISTS (SELECT 1 FROM students s WHERE s.id = rd.student_id AND s.active = 1)
  AND EXISTS (SELECT 1 FROM app_users r WHERE r.id = rd.reviewer_user_id AND r.active = 1 AND r.role <> 'pending'
    AND (r.student_id IS NULL OR r.student_id <> rd.student_id))
  AND EXISTS (SELECT 1 FROM app_users d WHERE d.id = rd.delegated_by_user_id AND d.active = 1
    AND (d.role = 'superadmin' OR EXISTS (SELECT 1 FROM mentor_student_assignments m
      WHERE m.mentor_user_id = d.id AND m.student_id = rd.student_id AND m.active = 1 AND m.can_review = 1)))`;

// True when `user` holds an active review delegation for `studentId`
// (review_delegations, active = 1, student active). Grants only routine code
// review (G2) of non-protected change requests and read access to that
// student's research-loop tasks, attempts and change requests. Never implies
// canViewStudent for other data, run approval, extra review or result review.
export async function canCodeReviewStudent(d1: D1Database, user: AppUser, studentId: string): Promise<boolean> {
  if (!studentId || user.role === "pending" || isOwnStudentRecord(user, studentId)) return false;
  const row = await d1.prepare(`SELECT rd.id FROM review_delegations rd
    WHERE rd.reviewer_user_id = ? AND rd.student_id = ? AND ${VALID_DELEGATION_SQL} LIMIT 1`)
    .bind(user.id, studentId)
    .first();
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Management (app/api/review-delegations)
// ---------------------------------------------------------------------------

export class ReviewDelegationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STUDENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DELEGATION_ID = /^rdg_[A-Za-z0-9]{1,64}$/;

export function parseStudentId(value: unknown) {
  if (typeof value !== "string" || !STUDENT_ID.test(value.trim())) throw new ReviewDelegationError(400, "INVALID_INPUT", "学生参数无效");
  return value.trim();
}

function parseUserId(value: unknown) {
  const id = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new ReviewDelegationError(400, "INVALID_INPUT", "审查人参数无效");
  return id;
}

function parseDelegationId(value: unknown) {
  if (typeof value !== "string" || !DELEGATION_ID.test(value)) throw new ReviewDelegationError(400, "INVALID_INPUT", "委托参数无效");
  return value;
}

async function requireManager(user: AppUser, studentId: string) {
  if (!(await canReviewStudent(user, studentId))) {
    throw new ReviewDelegationError(403, "FORBIDDEN", "只有可审核该学生的导师或超级管理员可以管理代码审查委托");
  }
}

type DelegationRow = {
  id: string;
  student_id: string;
  reviewer_user_id: number;
  reviewer_name: string | null;
  delegated_by_name: string | null;
  revoked_by_name: string | null;
  active: number;
  created_at: string;
  revoked_at: string | null;
};

const DELEGATION_SELECT = `SELECT rd.id, rd.student_id, rd.reviewer_user_id, r.display_name AS reviewer_name,
    d.display_name AS delegated_by_name, v.display_name AS revoked_by_name, rd.active, rd.created_at, rd.revoked_at
  FROM review_delegations rd
  LEFT JOIN app_users r ON r.id = rd.reviewer_user_id
  LEFT JOIN app_users d ON d.id = rd.delegated_by_user_id
  LEFT JOIN app_users v ON v.id = rd.revoked_by_user_id`;

/** Display names and dates only; never credentials, emails or open IDs. */
function presentDelegation(row: DelegationRow) {
  return {
    id: row.id,
    studentId: row.student_id,
    reviewerUserId: Number(row.reviewer_user_id),
    reviewerName: row.reviewer_name ?? "",
    delegatedByName: row.delegated_by_name ?? "",
    active: Number(row.active) === 1,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedByName: row.revoked_by_name,
  };
}

/** All delegations of one student, active first; revoked rows stay for audit. */
export async function listStudentDelegations(d1: D1Database, user: AppUser, studentId: string) {
  await requireManager(user, studentId);
  const { results } = await d1.prepare(`${DELEGATION_SELECT} WHERE rd.student_id = ?
    ORDER BY rd.active DESC, rd.created_at DESC, rd.rowid DESC LIMIT 200`).bind(studentId).all<DelegationRow>();
  return { studentId, delegations: results.map(presentDelegation) };
}

/** Students the current user may code-review through a valid delegation. */
export async function listMyDelegatedStudents(d1: D1Database, user: AppUser) {
  if (user.role === "pending") return { students: [] };
  const { results } = await d1.prepare(`SELECT rd.student_id, s.display_name, MIN(rd.created_at) AS since
    FROM review_delegations rd JOIN students s ON s.id = rd.student_id
    WHERE rd.reviewer_user_id = ? AND ${VALID_DELEGATION_SQL}
    GROUP BY rd.student_id, s.display_name ORDER BY s.display_name, rd.student_id LIMIT 200`)
    .bind(user.id).all<{ student_id: string; display_name: string; since: string }>();
  return {
    students: results
      .filter((row) => !isOwnStudentRecord(user, row.student_id))
      .map((row) => ({ studentId: row.student_id, displayName: row.display_name, since: row.since })),
  };
}

async function readDelegation(d1: D1Database, id: string) {
  return d1.prepare(`${DELEGATION_SELECT} WHERE rd.id = ?`).bind(id).first<DelegationRow>();
}

export async function grantDelegation(d1: D1Database, user: AppUser, body: Record<string, unknown>) {
  const studentId = parseStudentId(body.studentId);
  const reviewerUserId = parseUserId(body.reviewerUserId);
  await requireManager(user, studentId);
  const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
  if (!student) throw new ReviewDelegationError(404, "NOT_FOUND", "学生不存在或已停用");
  if (reviewerUserId === user.id) throw new ReviewDelegationError(400, "SELF_DELEGATION", "不能把代码审查委托给自己");
  const reviewer = await d1.prepare("SELECT id, role, active, student_id FROM app_users WHERE id = ?")
    .bind(reviewerUserId).first<{ id: number; role: string; active: number; student_id: string | null }>();
  if (!reviewer || Number(reviewer.active) !== 1) throw new ReviewDelegationError(404, "REVIEWER_NOT_FOUND", "审查人不存在或已停用");
  if (reviewer.role === "pending") throw new ReviewDelegationError(400, "REVIEWER_PENDING", "审查人账号尚未通过审核，不能接受委托");
  if (reviewer.student_id === studentId) throw new ReviewDelegationError(400, "SELF_DELEGATION", "不能把代码审查委托给学生本人");
  const id = `rdg_${crypto.randomUUID().replace(/-/g, "")}`;
  // Single statement: at most one active delegation per student and reviewer.
  const inserted = await d1.prepare(`INSERT INTO review_delegations (id, student_id, reviewer_user_id, delegated_by_user_id, active)
    SELECT ?, ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM review_delegations
      WHERE student_id = ? AND reviewer_user_id = ? AND active = 1) RETURNING id`)
    .bind(id, studentId, reviewerUserId, user.id, studentId, reviewerUserId).first<{ id: string }>();
  const row = inserted
    ? await readDelegation(d1, inserted.id)
    : await d1.prepare(`${DELEGATION_SELECT} WHERE rd.student_id = ? AND rd.reviewer_user_id = ? AND rd.active = 1
      ORDER BY rd.created_at, rd.rowid LIMIT 1`).bind(studentId, reviewerUserId).first<DelegationRow>();
  if (!row) throw new ReviewDelegationError(409, "CONFLICT", "委托已被更新，请刷新后重试");
  return { delegation: presentDelegation(row), created: Boolean(inserted) };
}

export async function revokeDelegation(d1: D1Database, user: AppUser, body: Record<string, unknown>) {
  const id = parseDelegationId(body.delegationId);
  const current = await readDelegation(d1, id);
  // Out-of-scope rows look missing so delegation IDs never confirm existence.
  if (!current || !(await canReviewStudent(user, current.student_id))) {
    throw new ReviewDelegationError(404, "NOT_FOUND", "委托不存在或无权管理");
  }
  const updated = await d1.prepare(`UPDATE review_delegations SET active = 0, revoked_at = CURRENT_TIMESTAMP, revoked_by_user_id = ?
    WHERE id = ? AND active = 1 RETURNING id`).bind(user.id, id).first();
  const row = await readDelegation(d1, id);
  return { delegation: presentDelegation(row ?? current), revoked: Boolean(updated) };
}
