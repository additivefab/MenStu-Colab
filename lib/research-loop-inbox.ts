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
// - run_approval: runs.status = 'awaiting_approval' and the run was not created
//   by the viewer (no self-approval, superadmin included).
// - result_review: runs.status = 'completed' with no result_reviews row or
//   state = 'pending'. Technically invalid results are included (the mentor
//   still decides); the item says so.
// - Order: oldest waitingSince first; at most 200 items.
// - Items carry no secrets, hashes or file contents — only what the inbox shows.

export const LOOP_INBOX_KINDS = ["task_confirmation", "change_extra_review", "run_approval", "result_review"] as const;
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

/** Items the viewer must decide. Placeholder until C1 lands. */
export async function listLoopInboxItems(d1: D1Database, viewer: LoopInboxViewer): Promise<LoopInboxItem[]> {
  void d1; void viewer;
  return [];
}

/** studentId → number of open items for the viewer (same rules). Placeholder until C1 lands. */
export async function countLoopInboxByStudent(d1: D1Database, viewer: LoopInboxViewer): Promise<Record<string, number>> {
  void d1; void viewer;
  return {};
}

export function loopInboxHref(studentId: string, target: { taskId: string } | { runId: string }) {
  const student = `/students/${encodeURIComponent(studentId)}`;
  return "runId" in target ? `${student}#research-run-${target.runId}` : `${student}#research-task-${target.taskId}`;
}
