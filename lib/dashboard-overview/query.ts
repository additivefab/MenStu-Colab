import { getStudentScope, scopeSql } from "../authorization";
import { getD1 } from "../database";
import type { AppUser } from "../feishu-auth";
import { countOverviewStates, deriveStudentOverview } from "./derive";
import { isInCurrentShanghaiWeek } from "./dates";
import {
  canActOnProgressReview,
  canActOnProposalReview,
  canVerifyGuidance,
  filterCurrentAcceptedTracks,
} from "./authority";
import {
  acceptedTrackProgressSql,
  guidanceOverviewSql,
  latestSubmittedSql,
  milestoneOverviewSql,
  outstandingProgressSql,
  paperPositionSql,
  proposalOverviewSql,
  substantiveProgressSql,
} from "./query-sql";
import { overviewStates, type MentorOverviewResponse, type MentorOverviewStudent, type OverviewState } from "./types";

type StudentRow = {
  id: string;
  display_name: string;
  degree: "博士" | "硕士";
  grade_year: number;
  stage: string;
  cadence_days: number;
  current_focus: string;
  tracking_started_at: string | null;
};

type SubstantiveRow = {
  id: number;
  student_id: string;
  kind: string;
  title: string;
  confirmed_at: string;
};

type TrackProgressRow = {
  id: number;
  student_id: string;
  track_type: "paper" | "project";
  next_action: string;
  next_action_due_date: string;
  blocker: string;
  confirmed_at: string;
};

type LatestSubmittedRow = {
  id: number;
  student_id: string;
  current_revision_created_at: string;
};

type OutstandingProgressRow = {
  id: number;
  student_id: string;
  title: string;
  review_status: "submitted" | "in_review" | "changes_requested";
  submitted_by_user_id: number | null;
  reviewed_by_user_id: number | null;
  review_claimed_at: string | null;
  current_revision_created_at: string;
  track_type: "paper" | "project" | null;
};

type ProposalRow = {
  id: number;
  student_id: string;
  title: string;
  status: "draft" | "submitted" | "changes_requested" | "approved";
  current_version: number;
  updated_at: string;
  latest_submitted_by_user_id: number | null;
  latest_version_created_at: string | null;
};

type MilestoneRow = {
  id: number;
  student_id: string;
  proposal_title: string;
  title: string;
  target_date: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  sort_order: number;
  updated_at: string;
};

type GuidanceRow = {
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

type PaperRow = {
  id: number;
  student_id: string;
  title: string;
  current_stage: string;
  status: string;
  updated_at: string;
};

function earliestAction(rows: TrackProgressRow[], waits: GuidanceRow[]) {
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

export async function loadMentorOverview(viewer: AppUser, now = new Date()): Promise<MentorOverviewResponse> {
  const d1 = getD1();
  const scope = await getStudentScope(viewer);
  const studentScope = scopeSql(scope, "s.id");
  const studentStatement = d1.prepare(`SELECT s.id, s.display_name, s.degree, s.grade_year,
    s.stage, s.cadence_days, s.current_focus, s.tracking_started_at
    FROM students s WHERE s.active = 1${studentScope.clause}
    ORDER BY CASE s.degree WHEN '博士' THEN 0 ELSE 1 END, s.grade_year, s.display_name, s.id`);
  const studentResult = studentScope.bindings.length
    ? await studentStatement.bind(...studentScope.bindings).all<StudentRow>()
    : await studentStatement.all<StudentRow>();
  if (studentResult.results.length > 100) {
    throw new Error("当前导师范围超过 100 人，请启用服务端分页后再使用全组总览");
  }
  const baseStudents = studentResult.results;
  const studentIds = baseStudents.map((student) => student.id);

  const emptyCounts = Object.fromEntries(overviewStates.map((state) => [state, 0])) as Record<OverviewState, number>;
  if (!studentIds.length) {
    return {
      generatedAt: now.toISOString(),
      timezone: "Asia/Shanghai",
      total: 0,
      counts: emptyCounts,
      weeklySubstantiveStudentCount: 0,
      students: [],
    };
  }

  const ids = studentIds.map(() => "?").join(",");
  const [reviewableResult, substantiveResult, trackResult, submittedResult, outstandingResult, proposalResult, milestoneResult, guidanceResult, paperResult] = await Promise.all([
    viewer.role === "superadmin"
      ? Promise.resolve({ results: studentIds.map((student_id) => ({ student_id })) })
      : d1.prepare(`SELECT student_id FROM mentor_student_assignments
          WHERE mentor_user_id = ? AND active = 1 AND can_review = 1
            AND student_id IN (${ids}) ORDER BY student_id`)
        .bind(viewer.id, ...studentIds).all<{ student_id: string }>(),
    d1.prepare(substantiveProgressSql(studentIds.length)).bind(...studentIds).all<SubstantiveRow>(),
    d1.prepare(acceptedTrackProgressSql(studentIds.length)).bind(...studentIds).all<TrackProgressRow>(),
    d1.prepare(latestSubmittedSql(studentIds.length)).bind(...studentIds).all<LatestSubmittedRow>(),
    d1.prepare(outstandingProgressSql(studentIds.length)).bind(...studentIds).all<OutstandingProgressRow>(),
    d1.prepare(proposalOverviewSql(studentIds.length)).bind(...studentIds).all<ProposalRow>(),
    d1.prepare(milestoneOverviewSql(studentIds.length)).bind(...studentIds).all<MilestoneRow>(),
    d1.prepare(guidanceOverviewSql(studentIds.length)).bind(...studentIds).all<GuidanceRow>(),
    d1.prepare(paperPositionSql(studentIds.length)).bind(...studentIds).all<PaperRow>(),
  ]);
  const reviewableIds = new Set(reviewableResult.results.map((row) => row.student_id));

  const students: MentorOverviewStudent[] = baseStudents.map((student) => {
    const substantive = substantiveResult.results.filter((row) => row.student_id === student.id);
    const acceptedTracks = trackResult.results.filter((row) => row.student_id === student.id);
    const latestSubmitted = submittedResult.results.find((row) => row.student_id === student.id) ?? null;
    const outstanding = outstandingResult.results.filter((row) => row.student_id === student.id);
    const proposal = proposalResult.results.find((row) => row.student_id === student.id) ?? null;
    const milestones = milestoneResult.results.filter((row) => row.student_id === student.id);
    const guidance = guidanceResult.results.filter((row) => row.student_id === student.id);
    const paper = paperResult.results.find((row) => row.student_id === student.id) ?? null;
    const canReview = reviewableIds.has(student.id);
    const tracks = filterCurrentAcceptedTracks(acceptedTracks, outstanding);

    const actionableProgress = outstanding.filter((row) => (
      canActOnProgressReview(row, viewer.id, canReview, now)
    ));
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
      hasConfirmedMainline: Boolean(proposal?.status === "approved" || paper || latestSubstantive || tracks.length),
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
        dueDate: row.next_action_due_date || null,
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

  const counts = countOverviewStates(students);

  return {
    generatedAt: now.toISOString(),
    timezone: "Asia/Shanghai",
    total: students.length,
    counts,
    weeklySubstantiveStudentCount: students.filter((student) => (
      student.recentSubstantive.some((progress) => isInCurrentShanghaiWeek(progress.confirmedAt, now))
    )).length,
    students,
  };
}
