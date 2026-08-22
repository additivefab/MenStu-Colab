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
  submitted_by_user_id: number | null;
  submitted_at: string;
  reviewed_at: string | null;
};

type EvidenceSourceRow = {
  id: number;
  progress_entry_id: number;
  source_type: string;
  label: string;
  source_ref: string;
  content_sha256: string;
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
  type: "proposal_review" | "blocked_milestone" | "overdue_milestone";
  studentId: string;
  studentName: string;
  title: string;
  detail: string;
  targetDate: string | null;
};

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
      (SELECT m.title FROM research_milestones m JOIN research_proposals rp ON rp.id = m.proposal_id
        WHERE rp.student_id = s.id AND m.status != 'completed'
        ORDER BY CASE m.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, m.sort_order LIMIT 1) AS next_milestone,
      (SELECT m.target_date FROM research_milestones m JOIN research_proposals rp ON rp.id = m.proposal_id
        WHERE rp.student_id = s.id AND m.status != 'completed'
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
    let evidenceRows: EvidenceSourceRow[] = [];
    let attachmentRows: AttachmentRow[] = [];
    let auditRows: ProgressAuditRow[] = [];
    if (studentIds.length) {
      const placeholders = studentIds.map(() => "?").join(",");
      const progress = await d1.prepare(`SELECT p.id, p.student_id, p.kind, p.title, p.summary, p.evidence,
        p.literature_ref, p.git_url, p.status, p.review_status, p.assessment,
        p.reviewer_note, p.reviewed_by_user_id, p.submitted_by_user_id,
        reviewer.display_name AS reviewer_name, p.submitted_at, p.reviewed_at
        FROM progress_entries p
        LEFT JOIN app_users reviewer ON reviewer.id = p.reviewed_by_user_id
        WHERE p.student_id IN (${placeholders})
        ORDER BY p.submitted_at DESC, p.id DESC LIMIT 1000`)
        .bind(...studentIds).all<ProgressRow>();
      progressRows = progress.results;

      const progressIds = progressRows.map((entry) => entry.id);
      if (progressIds.length) {
        const progressPlaceholders = progressIds.map(() => "?").join(",");
        const [evidence, attachments, audit] = await Promise.all([
          d1.prepare(`SELECT id, progress_entry_id, source_type, label,
            source_ref, content_sha256, occurred_at, created_at
            FROM progress_evidence_sources WHERE progress_entry_id IN (${progressPlaceholders})
            ORDER BY progress_entry_id, created_at, id`).bind(...progressIds).all<EvidenceSourceRow>(),
          d1.prepare(`SELECT id, progress_entry_id, file_name, content_type,
            size_bytes, content_sha256, created_at
            FROM progress_attachments WHERE progress_entry_id IN (${progressPlaceholders})
            ORDER BY progress_entry_id, created_at, id`).bind(...progressIds).all<AttachmentRow>(),
          d1.prepare(`SELECT a.id, a.progress_entry_id, a.action, a.from_status, a.to_status,
            a.assessment, a.note, a.created_at, a.actor_type, u.display_name AS actor_name
            FROM progress_audit_events a LEFT JOIN app_users u ON u.id = a.actor_user_id
            WHERE a.progress_entry_id IN (${progressPlaceholders})
            ORDER BY a.progress_entry_id, a.created_at DESC, a.id DESC`)
            .bind(...progressIds).all<ProgressAuditRow>(),
        ]);
        evidenceRows = evidence.results;
        attachmentRows = attachments.results;
        auditRows = audit.results;
      }
    }

    const mappedProgress = progressRows.map((entry) => ({
      ...entry,
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
    }));

    const nameById = new Map(studentResult.results.map((row) => [row.id, row.display_name]));
    const pending = mappedProgress
      .filter((entry) => entry.review_status === "submitted" || entry.review_status === "in_review")
      .map((entry) => ({
        ...entry,
        display_name: nameById.get(entry.student_id) ?? entry.student_id,
        can_finalize: entry.submitted_by_user_id !== viewer.id
          && reviewableStudentIds.has(entry.student_id) && (
          entry.review_status === "submitted" || entry.reviewed_by_user_id === viewer.id
        ),
      }));

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
      nextMilestone: row.next_milestone,
      nextMilestoneDate: row.next_milestone_date,
      outputCount: Number(row.output_count ?? 0),
      risk: riskFromDate(row.last_substantive_at ?? row.tracking_started_at),
      progress: mappedProgress.filter((entry) => entry.student_id === row.id),
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
            evidence_sources: entry.evidence_sources,
            attachments: entry.attachments,
            audit: entry.audit,
          })),
        })),
        pending: [],
        workflowTasks: [],
        metrics: {
          total: 1,
          doctors: 0,
          masters: 0,
          pending: 0,
          proposalPending: 0,
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
      const [proposalTasks, milestoneTasks] = await Promise.all([
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
          WHERE rp.student_id IN (${placeholders})
            AND (m.status = 'blocked' OR (m.status != 'completed' AND date(m.target_date) < date('now')))
          ORDER BY CASE m.status WHEN 'blocked' THEN 0 ELSE 1 END, m.target_date`).bind(...studentIds).all<{
            id: number; student_id: string; display_name: string; title: string; status: string; target_date: string;
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
      );
    }

    const riskCounts = students.reduce<Record<string, number>>((acc, student) => {
      acc[student.risk.level] = (acc[student.risk.level] ?? 0) + 1;
      return acc;
    }, {});

    return Response.json({
      viewer: {
        id: viewer.id,
        name: viewer.displayName,
        avatarUrl: viewer.avatarUrl,
        role: viewer.role,
        studentId: viewer.studentId,
      },
      students,
      pending,
      workflowTasks,
      metrics: {
        total: students.length,
        doctors: students.filter((student) => student.degree === "博士").length,
        masters: students.filter((student) => student.degree === "硕士").length,
        pending: pending.length,
        proposalPending: workflowTasks.filter((task) => task.type === "proposal_review").length,
        blocked: workflowTasks.filter((task) => task.type !== "proposal_review").length,
        outputs: students.reduce((sum, student) => sum + student.outputCount, 0),
        attention: students.filter((student) => student.risk.level !== "正常").length,
        riskCounts,
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取失败" }, { status: 500 });
  }
}
