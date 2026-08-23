import { ensureDatabase, getD1, riskFromDate } from "../../../lib/database";
import { getStudentScope, scopeSql } from "../../../lib/authorization";
import { requireAppUser } from "../../../lib/feishu-auth";
import { evidenceDisplayRef, type ProgressAssessment, type ReviewStatus } from "../../../lib/progress-evidence";

type StudentRow = {
  id: string;
  display_name: string;
  degree: "博士" | "硕士";
  grade_year: number;
  stage: string;
  cadence_days: number;
  current_focus: string;
  last_substantive_at: string | null;
  tracking_started_at: string | null;
  latest_title: string | null;
  latest_kind: string | null;
  proposal_status: string | null;
  proposal_title: string | null;
  proposal_version: number | null;
  next_milestone: string | null;
  next_milestone_date: string | null;
  output_count: number;
};

type ProgressRow = {
  id: number;
  student_id: string;
  kind: string;
  title: string;
  summary: string;
  evidence: string;
  literature_ref: string;
  git_url: string;
  status: "pending" | "substantive" | "supporting" | "supplement" | "rejected";
  review_status: ReviewStatus;
  assessment: ProgressAssessment;
  reviewer_note: string;
  reviewer_name: string | null;
  reviewed_by_user_id: number | null;
  review_claimed_at: string | null;
  submitted_by_user_id: number | null;
  submitted_at: string;
  reviewed_at: string | null;
  current_revision: number;
  paper_id: number | null;
  paper_title: string | null;
  paper_type: string | null;
  paper_stage: string | null;
  target_venue: string | null;
  planned_submission_date: string | null;
  submission_identifier: string | null;
  manuscript_version: string | null;
  next_action: string | null;
  next_action_due_date: string | null;
  blocker: string | null;
  project_milestone_id: number | null;
  project_milestone_title: string | null;
  project_milestone_target_date: string | null;
  project_evidence_target: string | null;
  project_proposal_version: number | null;
  project_next_action: string | null;
  project_next_action_due_date: string | null;
  project_blocker: string | null;
  project_completion_requested: number | null;
};

type MilestoneSummaryRow = {
  id: number;
  proposal_id: number;
  student_id: string;
  proposal_title: string;
  proposal_status: string;
  proposal_version: number;
  title: string;
  target_date: string;
  evidence_target: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  sort_order: number;
  updated_at: string;
};

type ProgressRevisionRow = {
  id: number;
  progress_entry_id: number;
  revision_number: number;
  snapshot_json: string;
  review_status: ReviewStatus;
  assessment: ProgressAssessment;
  reviewer_note: string;
  reviewer_name: string | null;
  reviewed_at: string | null;
  created_at: string;
};

type StudentPaperRow = {
  id: number;
  student_id: string;
  student_name: string;
  title: string;
  paper_type: string;
  target_venue: string;
  planned_submission_date: string | null;
  current_stage: string;
  submission_identifier: string;
  status: string;
  latest_progress_at: string | null;
  created_at: string;
  updated_at: string;
};

type EvidenceSourceRow = {
  id: number;
  progress_entry_id: number;
  source_type: string;
  label: string;
  source_ref: string;
  content_sha256: string;
  revision_number: number;
  occurred_at: string | null;
  created_at: string;
};

type AttachmentRow = {
  id: number;
  progress_entry_id: number;
  file_name: string;
  content_type: string;
  size_bytes: number;
  content_sha256: string;
  revision_number: number;
  created_at: string;
};

type ProgressAuditRow = {
  id: number;
  progress_entry_id: number;
  action: string;
  from_status: string;
  to_status: string;
  assessment: string;
  note: string;
  created_at: string;
  actor_name: string | null;
  actor_type: string;
};

type WorkflowTask = {
  id: number;
  type: "proposal_review" | "blocked_milestone" | "overdue_milestone" | "guidance_verification";
  studentId: string;
  studentName: string;
  title: string;
  detail: string;
  targetDate: string | null;
  context?: string;
  nextAction?: string;
  acceptanceCriteria?: string;
};

function revisionSnapshot(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function paperSnapshotValue(snapshot: Record<string, unknown>, key: string) {
  const paper = snapshot.paper;
  if (!paper || typeof paper !== "object" || Array.isArray(paper)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(paper, key)) return undefined;
  const value = (paper as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function reviewClaimIsStale(value: string | null) {
  if (!value) return true;
  const timestamp = new Date(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`).getTime();
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= 30 * 60 * 1000;
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    const viewer = auth.user;
    if (viewer.role === "student" && !viewer.studentId) {
      return Response.json(
        { code: "FEISHU_ACCOUNT_PENDING", error: "飞书账号尚未绑定学生记录" },
        { status: 403 },
      );
    }
    await ensureDatabase();
    const d1 = getD1();
    const scope = await getStudentScope(viewer);
    const studentScope = scopeSql(scope, "s.id");
    const studentStatement = d1.prepare(`SELECT
      s.id, s.display_name, s.degree, s.grade_year, s.stage, s.cadence_days,
      s.current_focus, s.last_substantive_at, s.tracking_started_at,
      (SELECT p.title FROM progress_entries p WHERE p.student_id = s.id AND p.status = 'substantive' ORDER BY p.submitted_at DESC LIMIT 1) AS latest_title,
      (SELECT p.kind FROM progress_entries p WHERE p.student_id = s.id AND p.status = 'substantive' ORDER BY p.submitted_at DESC LIMIT 1) AS latest_kind,
      (SELECT rp.status FROM research_proposals rp WHERE rp.student_id = s.id LIMIT 1) AS proposal_status,
      (SELECT rp.title FROM research_proposals rp WHERE rp.student_id = s.id LIMIT 1) AS proposal_title,
      (SELECT rp.current_version FROM research_proposals rp WHERE rp.student_id = s.id LIMIT 1) AS proposal_version,
      (SELECT m.title FROM research_milestones m JOIN research_proposals rp ON rp.id = m.proposal_id
        WHERE rp.student_id = s.id AND rp.status = 'approved' AND m.archived_at IS NULL AND m.status != 'completed'
        ORDER BY CASE m.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, m.sort_order LIMIT 1) AS next_milestone,
      (SELECT m.target_date FROM research_milestones m JOIN research_proposals rp ON rp.id = m.proposal_id
        WHERE rp.student_id = s.id AND rp.status = 'approved' AND m.archived_at IS NULL AND m.status != 'completed'
        ORDER BY CASE m.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, m.sort_order LIMIT 1) AS next_milestone_date,
      (SELECT COUNT(*) FROM research_outputs ro WHERE ro.student_id = s.id) AS output_count
      FROM students s WHERE s.active = 1${studentScope.clause}
      ORDER BY CASE s.degree WHEN '博士' THEN 0 ELSE 1 END, s.grade_year, s.display_name`);
    const studentResult = studentScope.bindings.length
      ? await studentStatement.bind(...studentScope.bindings).all<StudentRow>()
      : await studentStatement.all<StudentRow>();

    const studentIds = studentResult.results.map((row) => row.id);
    const reviewableStudentIds = viewer.role === "superadmin"
      ? new Set(studentIds)
      : new Set((await d1.prepare(`SELECT student_id FROM mentor_student_assignments
          WHERE mentor_user_id = ? AND active = 1 AND can_review = 1`)
        .bind(viewer.id).all<{ student_id: string }>()).results.map((item) => item.student_id));
    let progressRows: ProgressRow[] = [];
    let paperRows: StudentPaperRow[] = [];
    let milestoneRows: MilestoneSummaryRow[] = [];
    let evidenceRows: EvidenceSourceRow[] = [];
    let attachmentRows: AttachmentRow[] = [];
    let auditRows: ProgressAuditRow[] = [];
    let revisionRows: ProgressRevisionRow[] = [];
    if (studentIds.length) {
      const placeholders = studentIds.map(() => "?").join(",");
      const [progress, papers, milestones] = await Promise.all([
        d1.prepare(`SELECT p.id, p.student_id, p.kind, p.title, p.summary, p.evidence,
        p.literature_ref, p.git_url, p.status, p.review_status, p.assessment,
        p.reviewer_note, p.reviewed_by_user_id, p.review_claimed_at, p.submitted_by_user_id,
        reviewer.display_name AS reviewer_name, p.submitted_at, p.reviewed_at, p.current_revision,
        pd.paper_id, paper.title AS paper_title, paper.paper_type, pd.stage AS paper_stage,
        paper.target_venue, paper.planned_submission_date, paper.submission_identifier,
        pd.manuscript_version, pd.next_action, pd.next_action_due_date, pd.blocker,
        ppd.milestone_id AS project_milestone_id,
        ppd.milestone_title AS project_milestone_title,
        ppd.milestone_target_date AS project_milestone_target_date,
        ppd.evidence_target AS project_evidence_target,
        ppd.proposal_version AS project_proposal_version,
        ppd.next_action AS project_next_action,
        ppd.next_action_due_date AS project_next_action_due_date,
        ppd.blocker AS project_blocker,
        ppd.completion_requested AS project_completion_requested
        FROM progress_entries p
        LEFT JOIN app_users reviewer ON reviewer.id = p.reviewed_by_user_id
        LEFT JOIN paper_progress_details pd ON pd.progress_entry_id = p.id
        LEFT JOIN student_papers paper ON paper.id = pd.paper_id
        LEFT JOIN project_progress_details ppd ON ppd.progress_entry_id = p.id
        WHERE p.student_id IN (${placeholders})
        ORDER BY p.submitted_at DESC, p.id DESC LIMIT 1000`)
          .bind(...studentIds).all<ProgressRow>(),
        d1.prepare(`SELECT paper.id, paper.student_id, s.display_name AS student_name,
          paper.title, paper.paper_type, paper.target_venue, paper.planned_submission_date,
          paper.current_stage, paper.submission_identifier, paper.status,
          paper.latest_progress_at, paper.created_at, paper.updated_at
          FROM student_papers paper JOIN students s ON s.id = paper.student_id
          WHERE paper.student_id IN (${placeholders}) AND paper.status != 'closed'
          ORDER BY CASE paper.status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END,
            paper.updated_at DESC, paper.id DESC`)
          .bind(...studentIds).all<StudentPaperRow>(),
        d1.prepare(`SELECT m.id, m.proposal_id, rp.student_id, rp.title AS proposal_title,
          rp.status AS proposal_status, rp.current_version AS proposal_version,
          m.title, m.target_date, m.evidence_target, m.status, m.sort_order, m.updated_at
          FROM research_milestones m
          JOIN research_proposals rp ON rp.id = m.proposal_id
          WHERE rp.student_id IN (${placeholders}) AND m.archived_at IS NULL
          ORDER BY rp.student_id, m.sort_order, m.target_date`)
          .bind(...studentIds).all<MilestoneSummaryRow>(),
      ]);
      progressRows = progress.results;
      paperRows = papers.results;
      milestoneRows = milestones.results;

      const progressIds = progressRows.map((entry) => entry.id);
      if (progressIds.length) {
        const progressPlaceholders = progressIds.map(() => "?").join(",");
        const [evidence, attachments, audit, revisions] = await Promise.all([
          d1.prepare(`SELECT id, progress_entry_id, source_type, label,
            source_ref, content_sha256, revision_number, occurred_at, created_at
            FROM progress_evidence_sources WHERE progress_entry_id IN (${progressPlaceholders})
            ORDER BY progress_entry_id, created_at, id`).bind(...progressIds).all<EvidenceSourceRow>(),
          d1.prepare(`SELECT id, progress_entry_id, file_name, content_type,
            size_bytes, content_sha256, revision_number, created_at
            FROM progress_attachments WHERE progress_entry_id IN (${progressPlaceholders})
            ORDER BY progress_entry_id, created_at, id`).bind(...progressIds).all<AttachmentRow>(),
          d1.prepare(`SELECT a.id, a.progress_entry_id, a.action, a.from_status, a.to_status,
            a.assessment, a.note, a.created_at, a.actor_type, u.display_name AS actor_name
            FROM progress_audit_events a LEFT JOIN app_users u ON u.id = a.actor_user_id
            WHERE a.progress_entry_id IN (${progressPlaceholders})
            ORDER BY a.progress_entry_id, a.created_at DESC, a.id DESC`)
            .bind(...progressIds).all<ProgressAuditRow>(),
          d1.prepare(`SELECT r.id, r.progress_entry_id, r.revision_number, r.snapshot_json,
            r.review_status, r.assessment, r.reviewer_note,
            reviewer.display_name AS reviewer_name, r.reviewed_at, r.created_at
            FROM progress_revisions r
            LEFT JOIN app_users reviewer ON reviewer.id = r.reviewed_by_user_id
            WHERE r.progress_entry_id IN (${progressPlaceholders})
            ORDER BY r.progress_entry_id, r.revision_number DESC`)
            .bind(...progressIds).all<ProgressRevisionRow>(),
        ]);
        evidenceRows = evidence.results;
        attachmentRows = attachments.results;
        auditRows = audit.results;
        revisionRows = revisions.results;
      }
    }

    const mappedProgress = progressRows.map((entry) => {
      const currentSnapshot = revisionSnapshot(
        revisionRows.find((revision) => (
          revision.progress_entry_id === entry.id && revision.revision_number === entry.current_revision
        ))?.snapshot_json ?? "{}",
      );
      return {
        ...entry,
        paper: entry.paper_id ? {
          id: entry.paper_id,
          title: entry.paper_title ?? "未命名论文",
          paper_type: entry.paper_type ?? "期刊论文",
          stage: entry.paper_stage ?? "planning",
          target_venue: paperSnapshotValue(currentSnapshot, "targetVenue") ?? entry.target_venue ?? "",
          planned_submission_date: paperSnapshotValue(currentSnapshot, "plannedSubmissionDate") ?? entry.planned_submission_date,
          submission_identifier: paperSnapshotValue(currentSnapshot, "submissionIdentifier") ?? entry.submission_identifier ?? "",
          manuscript_version: entry.manuscript_version ?? "",
          next_action: entry.next_action ?? "",
          next_action_due_date: entry.next_action_due_date ?? "",
          blocker: entry.blocker ?? "",
        } : null,
        project: entry.project_next_action ? {
          milestone_id: entry.project_milestone_id,
          milestone_title: entry.project_milestone_title ?? "",
          milestone_target_date: entry.project_milestone_target_date,
          evidence_target: entry.project_evidence_target ?? "",
          proposal_version: entry.project_proposal_version,
          next_action: entry.project_next_action,
          next_action_due_date: entry.project_next_action_due_date ?? "",
          blocker: entry.project_blocker ?? "",
          completion_requested: Boolean(entry.project_completion_requested),
        } : null,
        evidence_sources: evidenceRows
          .filter((source) => source.progress_entry_id === entry.id)
          .map((source) => ({
            ...source,
            source_ref: evidenceDisplayRef(source.source_type, source.source_ref),
            content_sha256: source.content_sha256 ? source.content_sha256.slice(0, 12) : "",
          })),
        attachments: attachmentRows
          .filter((attachment) => attachment.progress_entry_id === entry.id)
          .map((attachment) => ({
            ...attachment,
            content_sha256: attachment.content_sha256.slice(0, 12),
            download_url: `/api/progress/files?id=${attachment.id}`,
          })),
        audit: auditRows.filter((event) => event.progress_entry_id === entry.id).slice(0, 12),
        revisions: revisionRows.filter((revision) => revision.progress_entry_id === entry.id).map((revision) => ({
          id: revision.id,
          revision_number: revision.revision_number,
          snapshot: revisionSnapshot(revision.snapshot_json),
          review_status: revision.review_status,
          assessment: revision.assessment,
          reviewer_note: revision.reviewer_note,
          reviewer_name: revision.reviewer_name,
          reviewed_at: revision.reviewed_at,
          created_at: revision.created_at,
        })),
      };
    });

    const nameById = new Map(studentResult.results.map((row) => [row.id, row.display_name]));
    const papers = paperRows.map((paper) => ({
      ...paper,
      update_count: mappedProgress.filter((entry) => entry.paper_id === paper.id).length,
      pending_count: mappedProgress.filter((entry) => entry.paper_id === paper.id && (
        entry.review_status === "submitted" || entry.review_status === "in_review"
      )).length,
    }));
    const pending = mappedProgress
      .filter((entry) => entry.review_status === "submitted" || entry.review_status === "in_review")
      .map((entry) => {
        const claimStale = entry.review_status === "in_review"
          && entry.reviewed_by_user_id !== viewer.id
          && reviewClaimIsStale(entry.review_claimed_at);
        return {
          ...entry,
          display_name: nameById.get(entry.student_id) ?? entry.student_id,
          evidence_sources: entry.evidence_sources.filter((source) => source.revision_number === entry.current_revision),
          attachments: entry.attachments.filter((attachment) => attachment.revision_number === entry.current_revision),
          claim_stale: claimStale,
          can_release: entry.review_status === "in_review" && entry.reviewed_by_user_id === viewer.id,
          can_decide: entry.submitted_by_user_id !== viewer.id
            && reviewableStudentIds.has(entry.student_id)
            && (entry.review_status === "submitted" || entry.reviewed_by_user_id === viewer.id),
          can_finalize: entry.submitted_by_user_id !== viewer.id
            && reviewableStudentIds.has(entry.student_id) && (
            entry.review_status === "submitted" || entry.reviewed_by_user_id === viewer.id || claimStale
          ),
        };
      });

    const students = studentResult.results.map((row) => ({
      id: row.id,
      name: row.display_name,
      degree: row.degree,
      gradeYear: row.grade_year,
      stage: row.stage,
      cadenceDays: row.cadence_days,
      currentFocus: row.current_focus,
      lastSubstantiveAt: row.last_substantive_at,
      latestTitle: row.latest_title ?? "尚无已确认记录",
      latestKind: row.latest_kind ?? "待补充",
      proposalStatus: row.proposal_status,
      proposalTitle: row.proposal_title,
      proposalVersion: row.proposal_version,
      nextMilestone: row.next_milestone,
      nextMilestoneDate: row.next_milestone_date,
      outputCount: Number(row.output_count ?? 0),
      risk: riskFromDate(row.last_substantive_at ?? row.tracking_started_at),
      progress: mappedProgress.filter((entry) => entry.student_id === row.id),
      milestones: milestoneRows.filter((milestone) => milestone.student_id === row.id),
    }));

    if (viewer.role === "student") {
      return Response.json({
        viewer: {
          id: viewer.id,
          name: viewer.displayName,
          avatarUrl: viewer.avatarUrl,
          role: viewer.role,
          studentId: viewer.studentId,
        },
        students: students.map((student) => ({
          id: student.id,
          name: student.name,
          degree: student.degree,
          gradeYear: student.gradeYear,
          stage: student.stage,
          cadenceDays: student.cadenceDays,
          currentFocus: student.currentFocus,
          latestTitle: student.latestTitle,
          latestKind: student.latestKind,
          proposalStatus: student.proposalStatus,
          proposalTitle: student.proposalStatus === "approved" ? student.proposalTitle : null,
          proposalVersion: student.proposalStatus === "approved" ? student.proposalVersion : null,
          nextMilestone: student.nextMilestone,
          nextMilestoneDate: student.nextMilestoneDate,
          outputCount: student.outputCount,
          risk: student.risk,
          progress: student.progress.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            title: entry.title,
            summary: entry.summary,
            evidence: entry.evidence,
            literature_ref: entry.literature_ref,
            git_url: entry.git_url,
            status: entry.status,
            review_status: entry.review_status,
            assessment: entry.assessment,
            reviewer_note: entry.reviewer_note,
            reviewer_name: entry.reviewer_name,
            submitted_at: entry.submitted_at,
            reviewed_at: entry.reviewed_at,
            paper: entry.paper,
            project: entry.project,
            evidence_sources: entry.evidence_sources,
            attachments: entry.attachments,
            audit: entry.audit,
            current_revision: entry.current_revision,
            revisions: entry.revisions,
          })),
          milestones: student.milestones.filter((milestone) => milestone.proposal_status === "approved"),
        })),
        papers,
        pending: [],
        workflowTasks: [],
        metrics: {
          total: 1,
          doctors: 0,
          masters: 0,
          pending: 0,
          waiting: 0,
          proposalPending: 0,
          guidancePending: 0,
          blocked: 0,
          outputs: 0,
          attention: 0,
          riskCounts: {},
        },
      });
    }

    const workflowTasks: WorkflowTask[] = [];
    if (studentIds.length) {
      const placeholders = studentIds.map(() => "?").join(",");
      const [proposalTasks, milestoneTasks, guidanceTasks] = await Promise.all([
        d1.prepare(`SELECT rp.id, rp.student_id, s.display_name, rp.title, rp.updated_at
          FROM research_proposals rp JOIN students s ON s.id = rp.student_id
          WHERE rp.status = 'submitted' AND rp.student_id IN (${placeholders})
          ORDER BY rp.updated_at`).bind(...studentIds).all<{
            id: number; student_id: string; display_name: string; title: string; updated_at: string;
          }>(),
        d1.prepare(`SELECT m.id, rp.student_id, s.display_name, m.title, m.status, m.target_date
          FROM research_milestones m
          JOIN research_proposals rp ON rp.id = m.proposal_id
          JOIN students s ON s.id = rp.student_id
          WHERE rp.student_id IN (${placeholders}) AND rp.status = 'approved'
            AND m.archived_at IS NULL
            AND (m.status = 'blocked' OR (m.status != 'completed' AND date(m.target_date) < date('now')))
          ORDER BY CASE m.status WHEN 'blocked' THEN 0 ELSE 1 END, m.target_date`).bind(...studentIds).all<{
            id: number; student_id: string; display_name: string; title: string; status: string; target_date: string;
          }>(),
        d1.prepare(`SELECT n.id, n.student_id, n.mentor_user_id, s.display_name,
            COALESCE(NULLIF(n.title, ''), NULLIF(n.next_action, ''), '导师指导') AS title,
            n.content, n.next_action, n.acceptance_criteria, n.completion_note, n.due_date
          FROM student_guidance_notes n JOIN students s ON s.id = n.student_id
          WHERE n.student_id IN (${placeholders}) AND n.status = 'open'
            AND n.verification_mode = 'mentor_verify' AND n.student_reported_at IS NOT NULL
          ORDER BY n.student_reported_at, n.updated_at`).bind(...studentIds).all<{
            id: number; student_id: string; mentor_user_id: number; display_name: string;
            title: string; content: string; next_action: string; acceptance_criteria: string;
            completion_note: string; due_date: string | null;
          }>(),
      ]);
      workflowTasks.push(
        ...proposalTasks.results.filter((item) => reviewableStudentIds.has(item.student_id)).map((item) => ({
          id: item.id,
          type: "proposal_review" as const,
          studentId: item.student_id,
          studentName: item.display_name,
          title: item.title,
          detail: "研究方案等待导师确认",
          targetDate: null,
        })),
        ...milestoneTasks.results.map((item) => ({
          id: item.id,
          type: item.status === "blocked" ? "blocked_milestone" as const : "overdue_milestone" as const,
          studentId: item.student_id,
          studentName: item.display_name,
          title: item.title,
          detail: item.status === "blocked" ? "培养节点受阻，需要导师决策" : "培养节点已逾期",
          targetDate: item.target_date,
        })),
        ...guidanceTasks.results
          .filter((item) => viewer.role === "superadmin" || item.mentor_user_id === viewer.id || reviewableStudentIds.has(item.student_id))
          .map((item) => ({
            id: item.id,
            type: "guidance_verification" as const,
            studentId: item.student_id,
            studentName: item.display_name,
            title: item.title,
            detail: item.completion_note ? `学生完成说明：${item.completion_note}` : "学生已提交完成说明",
            targetDate: item.due_date,
            context: item.content,
            nextAction: item.next_action,
            acceptanceCriteria: item.acceptance_criteria,
          })),
      );
    }

    const riskCounts = students.reduce<Record<string, number>>((acc, student) => {
      acc[student.risk.level] = (acc[student.risk.level] ?? 0) + 1;
      return acc;
    }, {});

    const actionablePendingCount = pending.filter((entry) => entry.can_finalize).length;
    return Response.json({
      viewer: {
        id: viewer.id,
        name: viewer.displayName,
        avatarUrl: viewer.avatarUrl,
        role: viewer.role,
        studentId: viewer.studentId,
      },
      students,
      papers,
      pending,
      workflowTasks,
      metrics: {
        total: students.length,
        doctors: students.filter((student) => student.degree === "博士").length,
        masters: students.filter((student) => student.degree === "硕士").length,
        pending: actionablePendingCount,
        waiting: pending.length - actionablePendingCount,
        proposalPending: workflowTasks.filter((task) => task.type === "proposal_review").length,
        guidancePending: workflowTasks.filter((task) => task.type === "guidance_verification").length,
        blocked: workflowTasks.filter((task) => task.type === "blocked_milestone" || task.type === "overdue_milestone").length,
        outputs: students.reduce((sum, student) => sum + student.outputCount, 0),
        attention: students.filter((student) => student.risk.level !== "正常").length,
        riskCounts,
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取失败" }, { status: 500 });
  }
}
