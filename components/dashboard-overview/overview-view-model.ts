import { overviewStateMeta, overviewStates, type MentorOverviewStudent, type OverviewState } from "../../lib/dashboard-overview/types.ts";
import type { OverviewDegreeFilter, OverviewLoopFilter } from "./overview-filters";

export type OverviewUrlState = {
  state: OverviewState | "all";
  degree: OverviewDegreeFilter;
  loop: OverviewLoopFilter;
  studentId: string | null;
};

export function parseOverviewUrl(value: string): OverviewUrlState {
  const params = new URL(value).searchParams;
  const requestedState = params.get("state");
  const state = requestedState && overviewStates.includes(requestedState as OverviewState)
    ? requestedState as OverviewState
    : "all";
  const requestedDegree = params.get("degree");
  const degree = requestedDegree === "phd" || requestedDegree === "master" ? requestedDegree : "all";
  const loop = params.get("loop") === "pending" ? "pending" : "all";
  return { state, degree, loop, studentId: params.get("student") };
}

/** Research-loop pending count shown for a student; 0 when absent (non-staff or not loaded). */
export function overviewLoopPending(student: Pick<MentorOverviewStudent, "loopPending">) {
  return typeof student.loopPending === "number" && student.loopPending > 0 ? student.loopPending : 0;
}

/** The loop column/filter only exists when the server sent counts for this viewer. */
export function overviewHasLoopCounts(students: ReadonlyArray<Pick<MentorOverviewStudent, "loopPending">>) {
  return students.some((student) => typeof student.loopPending === "number");
}

export function overviewLoopHref(studentId: string) {
  return `/students/${encodeURIComponent(studentId)}#research-loop`;
}

/** Filter only — the loop count never changes sort order (no ranking, plan §三.6). */
export function matchesOverviewLoopFilter(student: Pick<MentorOverviewStudent, "loopPending">, loop: OverviewLoopFilter) {
  return loop === "all" || overviewLoopPending(student) > 0;
}

function compareNullableDate(left: string | null, right: string | null, nullLast = true) {
  if (left === right) return 0;
  if (left === null) return nullLast ? 1 : -1;
  if (right === null) return nullLast ? -1 : 1;
  return left.localeCompare(right);
}

export function sortOverviewStudents(left: MentorOverviewStudent, right: MentorOverviewStudent) {
  const leftDue = earliestOverviewDueDate(left);
  const rightDue = earliestOverviewDueDate(right);
  return overviewStateMeta[left.primaryState].order - overviewStateMeta[right.primaryState].order
    || compareNullableDate(leftDue, rightDue)
    || compareNullableDate(left.latestSubstantiveAt, right.latestSubstantiveAt, false)
    || left.displayName.localeCompare(right.displayName, "zh-CN")
    || left.studentId.localeCompare(right.studentId);
}

export function earliestOverviewDueDate(student: Pick<MentorOverviewStudent, "issues">) {
  return student.issues.reduce<string | null>((earliest, issue) => {
    if (issue.state === "follow_up" || !issue.dueDate) return earliest;
    return earliest === null || issue.dueDate < earliest ? issue.dueDate : earliest;
  }, null);
}

export function overviewNextActionText(student: Pick<MentorOverviewStudent, "nextAction" | "primaryAction" | "primaryReasonCode" | "primaryState">) {
  if (student.nextAction?.trim()) return student.nextAction;
  if (student.primaryReasonCode === "STUDENT_RESOLUTION_CHANGES_REQUESTED") return "待补充处理结果";
  if (student.primaryAction === "review_resolution" || student.primaryAction === "view_resolution") return "处理结果待确认";
  return student.primaryState === "on_track" ? "暂无待办计划" : "等待补齐明确行动";
}
