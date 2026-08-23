import type { AppUser } from "../feishu-auth";
import { canActOnProgressReview, canActOnProposalReview, canVerifyGuidance, filterCurrentAcceptedTracks } from "./authority.ts";
import { isInCurrentShanghaiWeek } from "./dates.ts";
import { countOverviewStates, deriveStudentOverview } from "./derive.ts";
import type { MentorOverviewResponse, MentorOverviewStudent } from "./types.ts";

export type OverviewStudentRow = {
  id: string;
  display_name: string;
  degree: "博士" | "硕士";
  grade_year: number;
  stage: string;
  cadence_days: number;
  current_focus: string;
  tracking_started_at: string | null;
};

export type OverviewSubstantiveRow = {
  id: number;
  student_id: string;
  kind: string;
  title: string;
  confirmed_at: string;
};

export type OverviewTrackProgressRow = {
  id: number;
  student_id: string;
  track_type: "paper" | "project";
  next_action: string;
  next_action_due_date: string;
  blocker: string;
  current_revision_created_at: string;
  confirmed_at: string;
};

export type OverviewLatestSubmittedRow = {
  id: number;
  student_id: string;
  current_revision_created_at: string;
};

export type OverviewOutstandingProgressRow = {
  id: number;
  student_id: string;
  title: string;
  review_status: "submitted" | "in_review" | "changes_requested";
  submitted_by_user_id: number | null;
  reviewed_by_user_id: number | null;
  review_claimed_at: string | null;
  revision_review_status: "submitted" | "in_review" | "changes_requested";
  revision_reviewed_by_user_id: number | null;
  current_revision_created_at: string;
  track_type: "paper" | "project" | null;
};

export type OverviewProposalRow = {
  id: number;
  student_id: string;
  title: string;
  status: "draft" | "submitted" | "changes_requested" | "approved";
  current_version: number;
  updated_at: string;
  latest_submitted_by_user_id: number | null;
  latest_version_created_at: string | null;
};

export type OverviewMilestoneRow = {
  id: number;
  student_id: string;
  proposal_title: string;
  title: string;
  target_date: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  sort_order: number;
  updated_at: string;
};

export type OverviewGuidanceRow = {
  id: number;
  student_id: string;
  mentor_user_id: number;
  title: string;
  next_action: string;
  due_date: string | null;
  verification_mode: "self_report" | "mentor_verify";
  student_reported_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OverviewPaperRow = {
  id: number;
  student_id: string;
  title: string;
  current_stage: string;
  status: string;
  updated_at: string;
};

export type MentorOverviewAssemblyInput = {
  students: OverviewStudentRow[];
  reviewableStudentIds: string[];
  substantive: OverviewSubstantiveRow[];
  acceptedTracks: OverviewTrackProgressRow[];
  latestSubmitted: OverviewLatestSubmittedRow[];
  outstanding: OverviewOutstandingProgressRow[];
  proposals: OverviewProposalRow[];
  milestones: OverviewMilestoneRow[];
  guidance: OverviewGuidanceRow[];
  papers: OverviewPaperRow[];
};

function earliestAction(rows: OverviewTrackProgressRow[], waits: OverviewGuidanceRow[]) {
  const candidates = [
    ...rows.filter((row) => row.next_action.trim()).map((row) => ({
      label: row.next_action,
      dueDate: row.next_action_due_date || null,
      occurredAt: row.confirmed_at,
    })),
    ...waits.filter((row) => !row.student_reported_at && row.next_action.trim()).map((row) => ({
      label: row.next_action,
      dueDate: row.due_date,
      occurredAt: row.created_at,
    })),
  ];
  return candidates.sort((left, right) => (
    (left.dueDate === right.dueDate ? 0 : left.dueDate === null ? 1 : right.dueDate === null ? -1 : left.dueDate.localeCompare(right.dueDate))
    || right.occurredAt.localeCompare(left.occurredAt)
  ))[0] ?? null;
}

export function assembleMentorOverview(
  input: MentorOverviewAssemblyInput,
  viewer: Pick<AppUser, "id" | "role">,
  now: string | Date,
): MentorOverviewResponse {
  const reviewableIds = new Set(input.reviewableStudentIds);
  const students: MentorOverviewStudent[] = input.students.map((student) => {
    const substantive = input.substantive.filter((row) => row.student_id === student.id);
    const acceptedTracks = input.acceptedTracks.filter((row) => row.student_id === student.id);
    const latestSubmitted = input.latestSubmitted.find((row) => row.student_id === student.id) ?? null;
    const outstanding = input.outstanding.filter((row) => row.student_id === student.id);
    const proposal = input.proposals.find((row) => row.student_id === student.id) ?? null;
    const milestones = input.milestones.filter((row) => row.student_id === student.id);
    const guidance = input.guidance.filter((row) => row.student_id === student.id);
    const paper = input.papers.find((row) => row.student_id === student.id) ?? null;
    const canReview = reviewableIds.has(student.id);
    const tracks = filterCurrentAcceptedTracks(acceptedTracks, outstanding);

    const actionableProgress = outstanding.filter((row) => canActOnProgressReview(row, viewer.id, canReview, now));
    const actionableProposal = proposal && canActOnProposalReview(
      proposal.status,
      proposal.latest_submitted_by_user_id,
      viewer.id,
      canReview,
    ) ? [proposal] : [];
    const guidanceToVerify = guidance.filter((row) => canVerifyGuidance(row, viewer.id, canReview));
    const waitingGuidance = guidance.filter((row) => !row.student_reported_at);
    const latestSubstantive = substantive[0] ?? null;
    const currentAction = earliestAction(tracks, waitingGuidance);
    const currentMilestone = milestones[0] ?? null;

    const derived = deriveStudentOverview({
      studentId: student.id,
      cadenceDays: student.cadence_days,
      trackingStartedAt: student.tracking_started_at,
      latestSubstantiveAt: latestSubstantive?.confirmed_at ?? null,
      latestSubmittedAt: latestSubmitted?.current_revision_created_at ?? null,
      hasConfirmedMainline: Boolean(proposal?.status === "approved" || latestSubstantive || tracks.length),
      milestones: milestones.map((row) => ({
        id: row.id,
        title: row.title,
        targetDate: row.target_date || null,
        status: row.status,
        updatedAt: row.updated_at,
      })),
      nextActions: tracks.filter((row) => row.next_action.trim()).map((row) => ({
        id: row.id,
        label: row.next_action,
        dueDate: row.next_action_due_date || null,
        occurredAt: row.confirmed_at,
        sourceType: row.track_type === "paper" ? "paper" as const : "progress" as const,
      })),
      blockers: tracks.filter((row) => row.blocker.trim()).map((row) => ({
        id: row.id,
        label: row.blocker,
        dueDate: null,
        occurredAt: row.confirmed_at,
        sourceType: row.track_type === "paper" ? "paper" as const : "progress" as const,
      })),
      mentorReviews: [
        ...actionableProgress.map((row) => ({ id: row.id, title: row.title, occurredAt: row.current_revision_created_at, kind: "progress" as const })),
        ...actionableProposal.map((row) => ({ id: row.id, title: row.title, occurredAt: row.latest_version_created_at ?? row.updated_at, kind: "proposal" as const })),
        ...guidanceToVerify.map((row) => ({ id: row.id, title: row.title || row.next_action || "导师指导", occurredAt: row.student_reported_at, kind: "guidance" as const })),
      ],
      studentWaits: [
        ...outstanding.filter((row) => row.review_status === "changes_requested").map((row) => ({
          id: row.id,
          title: row.title,
          dueDate: null,
          occurredAt: row.current_revision_created_at,
          kind: "changes_requested" as const,
        })),
        ...(proposal?.status === "changes_requested" ? [{
          id: proposal.id,
          title: proposal.title,
          dueDate: null,
          occurredAt: proposal.latest_version_created_at ?? proposal.updated_at,
          kind: "proposal_changes_requested" as const,
        }] : []),
        ...waitingGuidance.map((row) => ({
          id: row.id,
          title: row.next_action || row.title || "导师指导",
          dueDate: row.due_date,
          occurredAt: row.created_at,
          kind: "guidance" as const,
        })),
      ],
    }, now);

    return {
      studentId: student.id,
      displayName: student.display_name,
      degreeLevel: student.degree,
      grade: student.grade_year,
      stage: student.stage,
      currentFocus: student.current_focus,
      cadenceDays: student.cadence_days,
      latestSubstantiveTitle: latestSubstantive?.title ?? null,
      latestSubstantiveAt: latestSubstantive?.confirmed_at ?? null,
      latestSubmittedAt: latestSubmitted?.current_revision_created_at ?? null,
      nextAction: currentAction?.label ?? null,
      nextActionDueDate: currentAction?.dueDate ?? null,
      paperPosition: paper ? { title: paper.title, stage: paper.current_stage, status: paper.status } : null,
      projectPosition: proposal ? {
        title: proposal.title,
        stage: currentMilestone?.title ?? (proposal.status === "approved" ? "暂无未完成节点" : "方案待确认"),
        status: currentMilestone?.status ?? proposal.status,
      } : null,
      recentSubstantive: substantive.map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind,
        confirmedAt: row.confirmed_at,
      })),
      ...derived,
    };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: "Asia/Shanghai",
    total: students.length,
    counts: countOverviewStates(students),
    weeklySubstantiveStudentCount: students.filter((student) => (
      student.recentSubstantive.some((progress) => isInCurrentShanghaiWeek(progress.confirmedAt, now))
    )).length,
    students,
  };
}
