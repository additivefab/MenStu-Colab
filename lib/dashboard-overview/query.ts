import { getStudentScope, scopeSql } from "../authorization";
import { getD1 } from "../database";
import type { AppUser } from "../feishu-auth";
import { assembleMentorOverview } from "./assemble";
import {
  acceptedTrackProgressSql,
  guidanceOverviewSql,
  latestSubmittedSql,
  milestoneOverviewSql,
  outstandingProgressSql,
  paperPositionSql,
  proposalOverviewSql,
  reviewableStudentSql,
  substantiveProgressSql,
} from "./query-sql";
import { overviewStates, type MentorOverviewResponse, type OverviewState } from "./types";

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
  current_revision_created_at: string;
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
  revision_review_status: "submitted" | "in_review" | "changes_requested";
  revision_reviewed_by_user_id: number | null;
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

export async function loadMentorOverview(viewer: AppUser, now = new Date()): Promise<MentorOverviewResponse> {
  const d1 = getD1();
  const scope = await getStudentScope(viewer);
  if (!scope.all && scope.studentIds.length > 100) {
    throw new Error("当前导师范围超过 100 人，请启用服务端分页后再使用全组总览");
  }
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
  const baseStudents = studentResult.results as StudentRow[];
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

  const [reviewableResult, substantiveResult, trackResult, submittedResult, outstandingResult, proposalResult, milestoneResult, guidanceResult, paperResult] = await Promise.all([
    viewer.role === "superadmin"
      ? Promise.resolve({ results: studentIds.map((student_id) => ({ student_id })) })
      : d1.prepare(reviewableStudentSql)
        .bind(viewer.id).all<{ student_id: string }>(),
    d1.prepare(substantiveProgressSql(studentIds.length)).bind(...studentIds).all<SubstantiveRow>(),
    d1.prepare(acceptedTrackProgressSql(studentIds.length)).bind(...studentIds).all<TrackProgressRow>(),
    d1.prepare(latestSubmittedSql(studentIds.length)).bind(...studentIds).all<LatestSubmittedRow>(),
    d1.prepare(outstandingProgressSql(studentIds.length)).bind(...studentIds).all<OutstandingProgressRow>(),
    d1.prepare(proposalOverviewSql(studentIds.length)).bind(...studentIds).all<ProposalRow>(),
    d1.prepare(milestoneOverviewSql(studentIds.length)).bind(...studentIds).all<MilestoneRow>(),
    d1.prepare(guidanceOverviewSql(studentIds.length)).bind(...studentIds).all<GuidanceRow>(),
    d1.prepare(paperPositionSql(studentIds.length)).bind(...studentIds).all<PaperRow>(),
  ]);
  const reviewableRows = reviewableResult.results as Array<{ student_id: string }>;
  const substantiveRows = substantiveResult.results as SubstantiveRow[];
  const acceptedTrackRows = trackResult.results as TrackProgressRow[];
  const submittedRows = submittedResult.results as LatestSubmittedRow[];
  const outstandingRows = outstandingResult.results as OutstandingProgressRow[];
  const proposalRows = proposalResult.results as ProposalRow[];
  const milestoneRows = milestoneResult.results as MilestoneRow[];
  const guidanceRows = guidanceResult.results as GuidanceRow[];
  const paperRows = paperResult.results as PaperRow[];
  return assembleMentorOverview({
    students: baseStudents,
    reviewableStudentIds: reviewableRows.map((row) => row.student_id),
    substantive: substantiveRows,
    acceptedTracks: acceptedTrackRows,
    latestSubmitted: submittedRows,
    outstanding: outstandingRows,
    proposals: proposalRows,
    milestones: milestoneRows,
    guidance: guidanceRows,
    papers: paperRows,
  }, viewer, now);
}
