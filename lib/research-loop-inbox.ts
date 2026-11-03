// Mentor decision inbox for the research loop (frontend plan FA1).
// CONTRACT (batch 3): types, rules and signatures are fixed; C1 implements the
// queries, C2 renders items in the dashboard inbox, C3 shows per-student
// counts in the group overview, C5 tests the rules independently.
//
// Rules (all server-side; the client never re-derives them):
// - Scope: active students the viewer can review — superadmin: all; admin: an
//   active mentor_student_assignments row with can_review = 1 (same as
//   lib/authorization.ts canReviewStudent). Students never get items.
// - task_confirmation: research_tasks.status = 'draft' and the task was not
//   created by the viewer (a mentor's own draft waits on the student).
// - change_extra_review: change_requests.status = 'pending_review',
//   requires_extra_review = 1, extra_review_approved_at IS NULL, and the
//   attempt was not requested by the viewer (no self-review).
// - run_approval: runs.status = 'awaiting_approval' and neither the run nor its
//   run spec was created by the viewer (no self-approval, superadmin included;
//   mirrors approveRun).
// - result_review: runs.status = 'completed' with no result_reviews row or
//   state = 'pending'. Technically invalid results are included (the mentor
//   still decides); the item says so.
// - plan_review (batch 5, plan-first): agent_attempts.status = 'waiting_approval'
//   with a pending agent_attempt_plans row, not requested by the viewer.
// - Order: oldest waitingSince first; at most 200 items.
// - Items carry no secrets, hashes or file contents — only what the inbox shows.

import { scopeSql, type StudentScope } from "./access-policy.ts";

export const LOOP_INBOX_KINDS = ["task_confirmation", "change_extra_review", "run_approval", "result_review", "plan_review"] as const;
export type LoopInboxKind = typeof LOOP_INBOX_KINDS[number];

export type LoopInboxItem = {
  /** Stable key: `${kind}:${objectId}`. */
  id: string;
  kind: LoopInboxKind;
  studentId: string;
  studentName: string;
  taskId: string;
  taskTitle: string;
  /** taskId | changeRequestId | runId depending on kind. */
  objectId: string;
  /** Per-task creation-order number for runs ("运行 #n"); null otherwise. */
  runNumber: number | null;
  /** Per-task version for task_confirmation; null otherwise. */
  taskVersion: number | null;
  /** Technical validity for result_review ("valid" | "invalid" | "unknown"); null otherwise. */
  technicalValidity: string | null;
  /** One Chinese line, e.g. "批准运行 #2" / "额外审查：变更触及受保护路径". */
  title: string;
  /** Profile deep link: #research-task-<taskId> or #research-run-<runId>. */
  href: string;
  /** ISO-ish timestamp the decision has been waiting since. */
  waitingSince: string;
};

export type LoopInboxViewer = { id: number; role: "superadmin" | "admin" | "student" | "pending" };

// ---------------------------------------------------------------------------
// Implementation (C1). Scope is resolved once (same SQL as canReviewStudent),
// then each kind is one statement per chunk of student ids, so a statement
// never exceeds D1's 100 bound parameters. List and count share the same
// FROM/WHERE fragments, so they cannot drift apart.

const MAX_ITEMS = 200;
// Student ids per statement; leaves room for the viewer/own-student binds.
const STUDENT_CHUNK = 90;

type KindQuery = {
  kind: LoopInboxKind;
  /** `s` is the students alias; the first `?` in `where` binds the viewer id when selfExcluded. */
  from: string;
  where: string;
  selfExcluded: boolean;
  objectId: string;
  waiting: string;
  select: string;
};

// Run numbers follow components/research-loop/numbering.ts: creation order,
// ties on insertion order (rowid), over every run of the task (rows are never deleted).
const RUN_NUMBER = `(SELECT COUNT(*) FROM runs earlier WHERE earlier.task_id = r.task_id
  AND (earlier.created_at < r.created_at OR (earlier.created_at = r.created_at AND earlier.rowid <= r.rowid)))`;

// Agent attempt numbers, same creation-order rule as runs.
const ATTEMPT_NUMBER = `(SELECT COUNT(*) FROM agent_attempts earlier WHERE earlier.task_id = aa.task_id
  AND (earlier.created_at < aa.created_at OR (earlier.created_at = aa.created_at AND earlier.rowid <= aa.rowid)))`;

const KIND_QUERIES: KindQuery[] = [
  {
    kind: "task_confirmation",
    from: "research_tasks t JOIN students s ON s.id = t.student_id",
    where: "t.status = 'draft' AND t.created_by_user_id <> ?",
    selfExcluded: true,
    objectId: "t.id",
    waiting: "t.updated_at",
    select: "t.current_version AS task_version, NULL AS run_number, NULL AS technical_validity",
  },
  {
    kind: "change_extra_review",
    from: `change_requests cr JOIN agent_attempts aa ON aa.id = cr.attempt_id
      JOIN research_tasks t ON t.id = cr.task_id JOIN students s ON s.id = cr.student_id`,
    where: `cr.status = 'pending_review' AND cr.requires_extra_review = 1 AND cr.extra_review_approved_at IS NULL
      AND aa.requested_by_user_id <> ?`,
    selfExcluded: true,
    objectId: "cr.id",
    waiting: "cr.created_at",
    select: "NULL AS task_version, NULL AS run_number, NULL AS technical_validity",
  },
  {
    kind: "run_approval",
    from: `runs r JOIN research_tasks t ON t.id = r.task_id JOIN students s ON s.id = r.student_id
      JOIN run_specs rs ON rs.sha256 = r.run_spec_sha256`,
    // Mirrors approveRun: neither the run's creator nor the spec's author may approve.
    where: "r.status = 'awaiting_approval' AND ? NOT IN (r.created_by_user_id, rs.created_by_user_id)",
    selfExcluded: true,
    objectId: "r.id",
    waiting: "r.created_at",
    select: `NULL AS task_version, ${RUN_NUMBER} AS run_number, NULL AS technical_validity`,
  },
  {
    kind: "result_review",
    from: `runs r JOIN research_tasks t ON t.id = r.task_id JOIN students s ON s.id = r.student_id
      LEFT JOIN run_results res ON res.run_id = r.id LEFT JOIN result_reviews rv ON rv.run_id = r.id`,
    where: "r.status = 'completed' AND (rv.run_id IS NULL OR rv.state = 'pending')",
    selfExcluded: false,
    objectId: "r.id",
    waiting: "COALESCE(res.created_at, r.ended_at, r.updated_at)",
    select: `NULL AS task_version, ${RUN_NUMBER} AS run_number,
      COALESCE(res.technical_validity, 'unknown') AS technical_validity`,
  },
  {
    kind: "plan_review",
    from: `agent_attempts aa JOIN agent_attempt_plans p ON p.attempt_id = aa.id
      JOIN research_tasks t ON t.id = aa.task_id JOIN students s ON s.id = aa.student_id`,
    where: "aa.status = 'waiting_approval' AND p.decision = 'pending' AND aa.requested_by_user_id <> ?",
    selfExcluded: true,
    objectId: "aa.id",
    waiting: "COALESCE(p.submitted_at, aa.updated_at)",
    // run_number carries the attempt number for the title only; runNumber stays null.
    select: `NULL AS task_version, ${ATTEMPT_NUMBER} AS run_number, NULL AS technical_validity`,
  },
];

type InboxRow = {
  object_id: string;
  student_id: string;
  student_name: string;
  task_id: string;
  task_title: string;
  task_version: number | null;
  run_number: number | null;
  technical_validity: string | null;
  waiting_since: string;
};

type ReviewScope = { scope: StudentScope; viewerId: number; ownStudentId: string | null };

/** Active students the viewer may make formal decisions for (canReviewStudent), or null for none. */
async function resolveReviewScope(d1: D1Database, viewer: LoopInboxViewer): Promise<ReviewScope | null> {
  if (viewer.role !== "superadmin" && viewer.role !== "admin") return null;
  // A dual-persona account never decides on its own student record (canReviewStudent).
  const own = await d1.prepare("SELECT student_id FROM app_users WHERE id = ?").bind(viewer.id)
    .first<{ student_id: string | null }>();
  const ownStudentId = own?.student_id ?? null;
  if (viewer.role === "superadmin") return { scope: { all: true, studentIds: [] }, viewerId: viewer.id, ownStudentId };
  const { results } = await d1.prepare(`SELECT a.student_id FROM mentor_student_assignments a
      JOIN students s ON s.id = a.student_id
    WHERE a.mentor_user_id = ? AND a.active = 1 AND a.can_review = 1 AND s.active = 1
    ORDER BY a.student_id`).bind(viewer.id).all<{ student_id: string }>();
  const studentIds = results.map((row) => row.student_id).filter((id) => id !== ownStudentId);
  return studentIds.length ? { scope: { all: false, studentIds }, viewerId: viewer.id, ownStudentId } : null;
}

function scopeChunks(scope: StudentScope): StudentScope[] {
  if (scope.all) return [scope];
  const chunks: StudentScope[] = [];
  for (let offset = 0; offset < scope.studentIds.length; offset += STUDENT_CHUNK) {
    chunks.push({ all: false, studentIds: scope.studentIds.slice(offset, offset + STUDENT_CHUNK) });
  }
  return chunks;
}

/** One kind over one chunk; list and count differ only in `head` (SELECT list) and `tail`. */
function kindStatement(d1: D1Database, query: KindQuery, review: ReviewScope, chunk: StudentScope, head: string, tail: string) {
  const scoped = scopeSql(chunk, "s.id");
  const ownClause = review.ownStudentId ? " AND s.id <> ?" : "";
  const sql = `SELECT ${head} FROM ${query.from}
    WHERE s.active = 1 AND ${query.where}${ownClause}${scoped.clause} ${tail}`;
  const binds: (string | number)[] = [
    ...(query.selfExcluded ? [review.viewerId] : []),
    ...(review.ownStudentId ? [review.ownStudentId] : []),
    ...scoped.bindings,
  ];
  return d1.prepare(sql).bind(...binds);
}

function waitingMillis(value: string) {
  // CURRENT_TIMESTAMP is UTC without a zone ("YYYY-MM-DD HH:MM:SS"); ISO values carry one.
  const normalized = /[zZ]$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function itemTitle(kind: LoopInboxKind, row: InboxRow) {
  switch (kind) {
    case "task_confirmation": return `确认第 ${Number(row.task_version)} 版任务`;
    case "change_extra_review": return "额外审查：变更触及受保护路径";
    case "run_approval": return `批准运行 #${Number(row.run_number)}`;
    case "result_review": return `评审运行 #${Number(row.run_number)} 的结果${row.technical_validity === "invalid" ? "（技术无效）" : ""}`;
    case "plan_review": return `审阅代理 #${Number(row.run_number)} 的修改计划`;
  }
}

function toItem(kind: LoopInboxKind, row: InboxRow): LoopInboxItem {
  const isRun = kind === "run_approval" || kind === "result_review";
  return {
    id: `${kind}:${row.object_id}`,
    kind,
    studentId: row.student_id,
    studentName: row.student_name,
    taskId: row.task_id,
    taskTitle: row.task_title,
    objectId: row.object_id,
    runNumber: isRun ? Number(row.run_number) : null,
    taskVersion: kind === "task_confirmation" ? Number(row.task_version) : null,
    technicalValidity: kind === "result_review" ? (row.technical_validity ?? "unknown") : null,
    title: itemTitle(kind, row),
    href: loopInboxHref(row.student_id, isRun ? { runId: row.object_id } : { taskId: row.task_id }),
    waitingSince: row.waiting_since,
  };
}

/** Items the viewer must decide: oldest waitingSince first, at most 200. */
export async function listLoopInboxItems(d1: D1Database, viewer: LoopInboxViewer): Promise<LoopInboxItem[]> {
  const review = await resolveReviewScope(d1, viewer);
  if (!review) return [];
  const items: LoopInboxItem[] = [];
  for (const chunk of scopeChunks(review.scope)) {
    // Each statement keeps its own oldest 200, so the global oldest 200 are
    // always among them; julianday() orders both timestamp formats correctly.
    const statements = KIND_QUERIES.map((query) => kindStatement(d1, query, review, chunk,
      `${query.objectId} AS object_id, s.id AS student_id, s.display_name AS student_name, t.id AS task_id,
        t.title AS task_title, ${query.waiting} AS waiting_since, ${query.select}`,
      `ORDER BY julianday(${query.waiting}), ${query.objectId} LIMIT ${MAX_ITEMS}`));
    const results = await d1.batch<InboxRow>(statements);
    results.forEach((result, index) => {
      for (const row of result.results) items.push(toItem(KIND_QUERIES[index].kind, row));
    });
  }
  return items
    .map((item) => ({ item, at: waitingMillis(item.waitingSince) }))
    .sort((a, b) => a.at - b.at || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
    .slice(0, MAX_ITEMS)
    .map(({ item }) => item);
}

/** studentId → number of open items for the viewer (same rules; not capped at 200). */
export async function countLoopInboxByStudent(d1: D1Database, viewer: LoopInboxViewer): Promise<Record<string, number>> {
  const review = await resolveReviewScope(d1, viewer);
  const counts: Record<string, number> = {};
  if (!review) return counts;
  for (const chunk of scopeChunks(review.scope)) {
    const statements = KIND_QUERIES.map((query) => kindStatement(d1, query, review, chunk,
      "s.id AS student_id, COUNT(*) AS item_count", "GROUP BY s.id"));
    const results = await d1.batch<{ student_id: string; item_count: number }>(statements);
    for (const result of results) {
      for (const row of result.results) counts[row.student_id] = (counts[row.student_id] ?? 0) + Number(row.item_count);
    }
  }
  return counts;
}

export function loopInboxHref(studentId: string, target: { taskId: string } | { runId: string }) {
  const student = `/students/${encodeURIComponent(studentId)}`;
  return "runId" in target ? `${student}#research-run-${target.runId}` : `${student}#research-task-${target.taskId}`;
}
