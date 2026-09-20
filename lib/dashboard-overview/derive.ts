import {
  overviewStates,
  overviewStateMeta,
  type DerivedStudentOverview,
  type OverviewIssue,
  type OverviewReasonCode,
  type StudentOverviewInput,
} from "./types.ts";
import { daysSinceInShanghai, isOverdueInShanghai } from "./dates.ts";
import { activeBlockerText } from "../progress-blocker.ts";

const reasonOrder: Record<OverviewReasonCode, number> = {
  MILESTONE_BLOCKED: 0,
  MILESTONE_OVERDUE: 1,
  NEXT_ACTION_OVERDUE: 2,
  MENTOR_PROGRESS_REVIEW: 3,
  MENTOR_PROPOSAL_REVIEW: 4,
  MENTOR_GUIDANCE_VERIFY: 5,
  MENTOR_RESOLUTION_REVIEW: 5.5,
  STUDENT_RESOLUTION_CHANGES_REQUESTED: 6.5,
  STUDENT_CHANGES_REQUESTED: 6,
  STUDENT_GUIDANCE_ACTION: 7,
  STUDENT_CADENCE_OVERDUE: 8,
  ON_TRACK_NEXT_ACTION: 9,
  ON_TRACK_RECENT_PROGRESS: 10,
  INSUFFICIENT_NO_BASELINE: 11,
  INSUFFICIENT_NO_ACTION: 12,
};

function compareNullable(left: string | null, right: string | null) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

export function sortOverviewIssues(issues: OverviewIssue[]) {
  return [...issues].sort((left, right) => (
    overviewStateMeta[left.state].order - overviewStateMeta[right.state].order
    || reasonOrder[left.code] - reasonOrder[right.code]
    || compareNullable(left.dueDate, right.dueDate)
    || compareNullable(left.occurredAt, right.occurredAt)
    || left.sourceType.localeCompare(right.sourceType)
    || String(left.sourceId ?? "").localeCompare(String(right.sourceId ?? ""))
  ));
}

export function deriveStudentOverview(input: StudentOverviewInput, now: string | Date): DerivedStudentOverview {
  const issues: OverviewIssue[] = [];

  for (const blocker of input.blockers) {
    if (!activeBlockerText(blocker.label)) continue;
    issues.push({
      code: "MILESTONE_BLOCKED",
      state: "intervene",
      label: blocker.label ? `当前阻塞：${blocker.label}` : "当前研究工作存在阻塞",
      owner: "coordination",
      dueDate: blocker.dueDate,
      occurredAt: blocker.occurredAt,
      sourceType: blocker.sourceType,
      sourceId: blocker.id,
      action: "resolve_blocker",
      actionTargetId: blocker.id,
    });
  }

  for (const milestone of input.milestones) {
    if (milestone.status === "completed") continue;
    if (milestone.status === "blocked") {
      issues.push({
        code: "MILESTONE_BLOCKED",
        state: "intervene",
        label: `培养节点受阻：${milestone.title}`,
        owner: "coordination",
        dueDate: milestone.targetDate,
        occurredAt: milestone.updatedAt,
        sourceType: "milestone",
        sourceId: milestone.id,
        action: "resolve_blocker",
        actionTargetId: milestone.id,
      });
    } else if (isOverdueInShanghai(milestone.targetDate, now)) {
      issues.push({
        code: "MILESTONE_OVERDUE",
        state: "intervene",
        label: `培养节点逾期：${milestone.title}`,
        owner: "coordination",
        dueDate: milestone.targetDate,
        occurredAt: milestone.updatedAt,
        sourceType: "milestone",
        sourceId: milestone.id,
        action: "follow_up",
        actionTargetId: milestone.id,
      });
    }
  }

  for (const action of input.nextActions) {
    const overdue = isOverdueInShanghai(action.dueDate, now);
    issues.push({
      code: overdue ? "NEXT_ACTION_OVERDUE" : "ON_TRACK_NEXT_ACTION",
      state: overdue ? "intervene" : "on_track",
      label: overdue ? `下一行动逾期：${action.label}` : `下一行动明确：${action.label}`,
      owner: overdue ? "coordination" : "student",
      dueDate: action.dueDate,
      occurredAt: action.occurredAt,
      sourceType: action.sourceType,
      sourceId: action.id,
      action: overdue ? "follow_up" : "view_progress",
      actionTargetId: action.id,
    });
  }

  for (const review of input.mentorReviews) {
    const metadata = review.kind === "progress"
      ? { code: "MENTOR_PROGRESS_REVIEW" as const, label: `审核进展：${review.title}`, action: "review_progress" as const, sourceType: "progress" as const }
      : review.kind === "proposal"
        ? { code: "MENTOR_PROPOSAL_REVIEW" as const, label: `审核方案：${review.title}`, action: "review_proposal" as const, sourceType: "proposal" as const }
        : { code: "MENTOR_GUIDANCE_VERIFY" as const, label: `验收指导：${review.title}`, action: "verify_guidance" as const, sourceType: "guidance" as const };
    issues.push({
      code: metadata.code,
      state: "mentor",
      label: metadata.label,
      owner: "mentor",
      dueDate: null,
      occurredAt: review.occurredAt,
      sourceType: metadata.sourceType,
      sourceId: review.id,
      action: metadata.action,
      actionTargetId: review.id,
    });
  }

  for (const wait of input.studentWaits) {
    if (wait.kind === "guidance" && isOverdueInShanghai(wait.dueDate, now)) {
      issues.push({
        code: "NEXT_ACTION_OVERDUE",
        state: "intervene",
        label: `指导行动逾期：${wait.title}`,
        owner: "coordination",
        dueDate: wait.dueDate,
        occurredAt: wait.occurredAt,
        sourceType: "guidance",
        sourceId: wait.id,
        action: "follow_up",
        actionTargetId: wait.id,
      });
    }
    const changesRequested = wait.kind === "changes_requested" || wait.kind === "proposal_changes_requested";
    issues.push({
      code: changesRequested ? "STUDENT_CHANGES_REQUESTED" : "STUDENT_GUIDANCE_ACTION",
      state: "student",
      label: wait.kind === "changes_requested"
        ? `等待补交：${wait.title}`
        : wait.kind === "proposal_changes_requested"
          ? `等待方案修改：${wait.title}`
          : `等待学生执行：${wait.title}`,
      owner: "student",
      dueDate: wait.dueDate,
      occurredAt: wait.occurredAt,
      sourceType: wait.kind === "changes_requested" ? "progress" : wait.kind === "proposal_changes_requested" ? "proposal" : "guidance",
      sourceId: wait.id,
      action: wait.kind === "changes_requested" ? "view_progress" : wait.kind === "proposal_changes_requested" ? "view_proposal" : "view_guidance",
      actionTargetId: wait.id,
    });
  }

  for (const resolution of input.resolutions ?? []) {
    const returned = resolution.status === "changes_requested";
    issues.push({
      code: returned ? "STUDENT_RESOLUTION_CHANGES_REQUESTED" : "MENTOR_RESOLUTION_REVIEW",
      state: returned ? "student" : resolution.canReview ? "mentor" : "on_track",
      label: returned
        ? `等待补充处理结果：${resolution.title}`
        : resolution.canReview ? `确认处理结果：${resolution.title}` : `等待导师确认处理结果：${resolution.title}`,
      owner: returned ? "student" : "mentor",
      dueDate: null,
      occurredAt: resolution.occurredAt,
      sourceType: "resolution",
      sourceId: resolution.id,
      action: !returned && resolution.canReview ? "review_resolution" : "view_resolution",
      actionTargetId: resolution.progressEntryId,
    });
  }

  const hasMentorWork = issues.some((issue) => issue.state === "mentor" || issue.code === "MENTOR_RESOLUTION_REVIEW");
  const cadenceBaseline = input.latestSubstantiveAt ?? input.trackingStartedAt;
  const daysSinceBaseline = daysSinceInShanghai(cadenceBaseline, now);
  if (!hasMentorWork && input.cadenceDays && input.cadenceDays > 0 && daysSinceBaseline !== null
    && daysSinceBaseline > input.cadenceDays) {
    issues.push({
      code: "STUDENT_CADENCE_OVERDUE",
      state: "student",
      label: `等待学生更新，已超节奏 ${daysSinceBaseline - input.cadenceDays} 天`,
      owner: "student",
      dueDate: null,
      occurredAt: cadenceBaseline,
      sourceType: "profile",
      sourceId: input.studentId,
      action: "view_student",
      actionTargetId: input.studentId,
    });
  } else if (!issues.length && input.latestSubstantiveAt && input.cadenceDays && daysSinceBaseline !== null
    && daysSinceBaseline <= input.cadenceDays) {
    issues.push({
      code: "ON_TRACK_RECENT_PROGRESS",
      state: "on_track",
      label: `最近可信进展在 ${input.cadenceDays} 天节奏内`,
      owner: "student",
      dueDate: null,
      occurredAt: input.latestSubstantiveAt,
      sourceType: "progress",
      sourceId: null,
      action: "view_student",
      actionTargetId: input.studentId,
    });
  }

  if (!issues.length && input.hasConfirmedMainline) {
    issues.push({
      code: "ON_TRACK_NEXT_ACTION",
      state: "on_track",
      label: "已有确认研究主线，当前无逾期或待处理事项",
      owner: "student",
      dueDate: null,
      occurredAt: input.latestSubstantiveAt ?? input.trackingStartedAt,
      sourceType: "profile",
      sourceId: input.studentId,
      action: "view_student",
      actionTargetId: input.studentId,
    });
  }

  if (!issues.length) {
    const missingBaseline = !input.trackingStartedAt && !input.latestSubstantiveAt;
    issues.push({
      code: missingBaseline ? "INSUFFICIENT_NO_BASELINE" : "INSUFFICIENT_NO_ACTION",
      state: "insufficient",
      label: missingBaseline ? "尚无正式跟踪起点或可信进展" : "尚无可判断的明确下一行动",
      owner: "setup",
      dueDate: null,
      occurredAt: input.latestSubmittedAt,
      sourceType: "profile",
      sourceId: input.studentId,
      action: "complete_profile",
      actionTargetId: input.studentId,
    });
  }

  const sorted = sortOverviewIssues(issues);
  const primary = sorted[0];
  return {
    primaryState: primary.state,
    primaryReasonCode: primary.code,
    primaryReasonLabel: primary.label,
    nextOwner: primary.owner,
    primaryAction: primary.action,
    primaryActionTargetId: primary.actionTargetId,
    issues: sorted,
    additionalIssueCount: Math.max(0, sorted.length - 1),
    counters: {
      actionableByMentor: sorted.filter((issue) => issue.state === "mentor").length,
      waitingForStudent: sorted.filter((issue) => issue.state === "student").length,
      blocked: sorted.filter((issue) => issue.code === "MILESTONE_BLOCKED").length,
      overdue: sorted.filter((issue) => issue.code === "MILESTONE_OVERDUE" || issue.code === "NEXT_ACTION_OVERDUE").length,
    },
  };
}

export function countOverviewStates<T extends { primaryState: keyof typeof overviewStateMeta }>(students: T[]) {
  const counts = Object.fromEntries(overviewStates.map((state) => [state, 0])) as Record<keyof typeof overviewStateMeta, number>;
  students.forEach((student) => { counts[student.primaryState] += 1; });
  const total = overviewStates.reduce((sum, state) => sum + counts[state], 0);
  if (total !== students.length) throw new Error("导师总览互斥计数不一致");
  return counts;
}
