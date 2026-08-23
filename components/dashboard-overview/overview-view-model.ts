import { overviewStateMeta, type MentorOverviewStudent, type OverviewState } from "../../lib/dashboard-overview/types.ts";
import type { OverviewDegreeFilter } from "./overview-filters";

export type OverviewUrlState = {
  state: OverviewState | "all";
  degree: OverviewDegreeFilter;
  studentId: string | null;
};

export function parseOverviewUrl(value: string): OverviewUrlState {
  const params = new URL(value).searchParams;
  const requestedState = params.get("state");
  const state = requestedState && Object.prototype.hasOwnProperty.call(overviewStateMeta, requestedState)
    ? requestedState as OverviewState
    : "all";
  const requestedDegree = params.get("degree");
  const degree = requestedDegree === "phd" || requestedDegree === "master" ? requestedDegree : "all";
  return { state, degree, studentId: params.get("student") };
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
    if (!issue.dueDate) return earliest;
    return earliest === null || issue.dueDate < earliest ? issue.dueDate : earliest;
  }, null);
}
