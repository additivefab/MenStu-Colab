import type { MonthlyDeliverySummary } from "../monthly-delivery.ts";

export const overviewStates = [
  "intervene",
  "mentor",
  "student",
  "on_track",
  "insufficient",
] as const;

export type OverviewState = (typeof overviewStates)[number];
export type OverviewIssueState = OverviewState | "follow_up";
export const overviewIssueStates = [...overviewStates, "follow_up"] as const;

export type OverviewReasonCode =
  | "MILESTONE_BLOCKED"
  | "MILESTONE_OVERDUE"
  | "NEXT_ACTION_OVERDUE"
  | "MENTOR_PROGRESS_REVIEW"
  | "MENTOR_PROPOSAL_REVIEW"
  | "MENTOR_GUIDANCE_VERIFY"
  | "MENTOR_RESOLUTION_REVIEW"
  | "STUDENT_RESOLUTION_CHANGES_REQUESTED"
  | "STUDENT_CHANGES_REQUESTED"
  | "STUDENT_GUIDANCE_ACTION"
  | "STUDENT_CADENCE_OVERDUE"
  | "ON_TRACK_RECENT_PROGRESS"
  | "ON_TRACK_NEXT_ACTION"
  | "INSUFFICIENT_NO_BASELINE"
  | "INSUFFICIENT_NO_ACTION";

export type OverviewOwner = "mentor" | "student" | "coordination" | "setup";

export type OverviewAction =
  | "resolve_blocker"
  | "follow_up"
  | "review_progress"
  | "review_resolution"
  | "view_resolution"
  | "review_proposal"
  | "verify_guidance"
  | "view_guidance"
  | "view_progress"
  | "view_proposal"
  | "view_student"
  | "complete_profile";

export type OverviewSourceType = "progress" | "proposal" | "milestone" | "guidance" | "paper" | "profile" | "resolution";

export type OverviewIssue = {
  code: OverviewReasonCode;
  state: OverviewIssueState;
  label: string;
  owner: OverviewOwner;
  dueDate: string | null;
  occurredAt: string | null;
  sourceType: OverviewSourceType;
  sourceId: string | number | null;
  action: OverviewAction;
  actionTargetId: string | number | null;
  resolutionKind?: "blocker" | "next_action";
};

export type OverviewMilestoneFact = {
  id: number;
  title: string;
  targetDate: string | null;
  status: "pending" | "in_progress" | "completed" | "blocked";
  updatedAt: string | null;
};

export type OverviewNextActionFact = {
  id: number;
  label: string;
  dueDate: string | null;
  occurredAt: string | null;
  sourceType: "progress" | "paper";
};

export type OverviewBlockerFact = {
  id: number;
  label: string;
  dueDate: string | null;
  occurredAt: string | null;
  sourceType: "progress" | "paper";
};

export type OverviewMentorReviewFact = {
  id: number;
  title: string;
  occurredAt: string | null;
  kind: "progress" | "proposal" | "guidance";
};

export type OverviewStudentWaitFact = {
  id: number;
  title: string;
  dueDate: string | null;
  occurredAt: string | null;
  kind: "changes_requested" | "proposal_changes_requested" | "guidance";
};

export type OverviewResolutionFact = {
  id: number;
  progressEntryId: number;
  itemKind: "blocker" | "next_action";
  title: string;
  occurredAt: string | null;
  status: "pending" | "changes_requested";
  canReview: boolean;
};

export type StudentOverviewInput = {
  studentId: string;
  cadenceDays: number | null;
  trackingStartedAt: string | null;
  latestSubstantiveAt: string | null;
  latestSubmittedAt: string | null;
  hasConfirmedMainline: boolean;
  milestones: OverviewMilestoneFact[];
  nextActions: OverviewNextActionFact[];
  blockers: OverviewBlockerFact[];
  mentorReviews: OverviewMentorReviewFact[];
  studentWaits: OverviewStudentWaitFact[];
  resolutions?: OverviewResolutionFact[];
  /** Canonical open problems, independent of progress status; omitted by isolated derivation callers. */
  problems?: OverviewIssue[];
};

export type DerivedStudentOverview = {
  primaryState: OverviewState;
  primaryReasonCode: OverviewReasonCode;
  primaryReasonLabel: string;
  nextOwner: OverviewOwner;
  primaryAction: OverviewAction;
  primaryActionTargetId: string | number | null;
  issues: OverviewIssue[];
  additionalIssueCount: number;
  counters: {
    actionableByMentor: number;
    waitingForStudent: number;
    blocked: number;
    overdue: number;
  };
};

export type OverviewPosition = {
  title: string;
  stage: string;
  status: string;
} | null;

export type OverviewRecentProgress = {
  id: number;
  title: string;
  kind: string;
  confirmedAt: string;
};

export type MentorOverviewStudent = DerivedStudentOverview & {
  studentId: string;
  displayName: string;
  degreeLevel: "博士" | "硕士";
  grade: number | null;
  stage: string;
  currentFocus: string;
  cadenceDays: number | null;
  latestSubstantiveTitle: string | null;
  monthlyDelivery?: MonthlyDeliverySummary;
  /**
   * Research-loop decisions waiting on the viewer for this student (plan FA1).
   * Staff viewers only; absent for anyone else. A pending-work count, never an
   * activity metric — it must not be used for ranking or sorting.
   */
  loopPending?: number;
  latestSubstantiveAt: string | null;
  latestSubmittedAt: string | null;
  nextAction: string | null;
  nextActionDueDate: string | null;
  paperPosition: OverviewPosition;
  projectPosition: OverviewPosition;
  recentSubstantive: OverviewRecentProgress[];
};

export type MentorOverviewResponse = {
  generatedAt: string;
  timezone: "Asia/Shanghai";
  total: number;
  counts: Record<OverviewState, number>;
  weeklySubstantiveStudentCount: number;
  students: MentorOverviewStudent[];
};

export const overviewStateMeta: Record<OverviewIssueState, { label: string; icon: string; order: number }> = {
  intervene: { label: "需立即介入", icon: "!", order: 0 },
  mentor: { label: "等我处理", icon: "✓", order: 1 },
  follow_up: { label: "待解决问题", icon: "◇", order: 5 },
  student: { label: "等学生", icon: "↗", order: 2 },
  on_track: { label: "正常推进", icon: "●", order: 3 },
  insufficient: { label: "信息不足", icon: "?", order: 4 },
};
