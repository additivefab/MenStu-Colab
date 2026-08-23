import { canReviewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { isPaperStage } from "../../../lib/paper-progress";
import { legacyProgressStatus, type ProgressAssessment, type ReviewStatus } from "../../../lib/progress-evidence";

const finalActions = new Set(["substantive", "supporting", "supplement", "rejected"]);

type EntryRow = {
  id: number;
  student_id: string;
  kind: string;
  review_status: ReviewStatus;
  reviewed_by_user_id: number | null;
  submitted_by_user_id: number | null;
  current_revision: number;
  revision_review_status: ReviewStatus | null;
  revision_reviewed_by_user_id: number | null;
  revision_snapshot_json: string | null;
  paper_id: number | null;
  paper_stage: string | null;
  project_milestone_id: number | null;
  project_proposal_version: number | null;
  completion_requested: number | null;
  milestone_title: string | null;
  milestone_status: string | null;
  milestone_archived_at: string | null;
  proposal_id: number | null;
  proposal_student_id: string | null;
  proposal_status: string | null;
  proposal_current_version: number | null;
};

function paperAuthorityStatus(stage: string | null) {
  if (!stage || !isPaperStage(stage)) return null;
  if (stage === "published") return "published";
  if (stage === "accepted") return "accepted";
  return "active";
}

function paperSnapshot(snapshotJson: string | null) {
  if (!snapshotJson) return null;
  try {
    const snapshot = JSON.parse(snapshotJson) as { paper?: Record<string, unknown> | null };
    if (!snapshot.paper || typeof snapshot.paper !== "object") return null;
    return {
      targetVenue: String(snapshot.paper.targetVenue ?? ""),
      plannedSubmissionDate: String(snapshot.paper.plannedSubmissionDate ?? ""),
      submissionIdentifier: String(snapshot.paper.submissionIdentifier ?? ""),
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const id = Number(body.id);
    const action = String(body.action ?? "");
    const note = String(body.note ?? "").trim();
    if (!Number.isInteger(id) || (action !== "start_review" && !finalActions.has(action))) {
      return Response.json({ error: "审核参数无效" }, { status: 400 });
    }
    if (note.length > 3000) return Response.json({ error: "审核意见不能超过 3000 个字符" }, { status: 400 });
    if ((action === "supplement" || action === "rejected") && !note) {
      return Response.json({ error: "需要补充或判定为非进展时，必须填写具体理由" }, { status: 400 });
    }

    const d1 = getD1();
    const entry = await d1.prepare(`SELECT p.id, p.student_id, p.kind, p.review_status,
      p.reviewed_by_user_id, p.submitted_by_user_id, p.current_revision,
      pr.review_status AS revision_review_status,
      pr.reviewed_by_user_id AS revision_reviewed_by_user_id,
      pr.snapshot_json AS revision_snapshot_json,
      ppd.paper_id, ppd.stage AS paper_stage,
      jpd.milestone_id AS project_milestone_id,
      jpd.proposal_version AS project_proposal_version,
      jpd.completion_requested,
      m.title AS milestone_title, m.status AS milestone_status,
      m.archived_at AS milestone_archived_at, m.proposal_id,
      rp.student_id AS proposal_student_id, rp.status AS proposal_status,
      rp.current_version AS proposal_current_version
      FROM progress_entries p
      LEFT JOIN progress_revisions pr
        ON pr.progress_entry_id = p.id AND pr.revision_number = p.current_revision
      LEFT JOIN paper_progress_details ppd ON ppd.progress_entry_id = p.id
      LEFT JOIN project_progress_details jpd ON jpd.progress_entry_id = p.id
      LEFT JOIN research_milestones m ON m.id = jpd.milestone_id
      LEFT JOIN research_proposals rp ON rp.id = m.proposal_id
      WHERE p.id = ?`).bind(id).first<EntryRow>();
    if (!entry) return Response.json({ error: "记录不存在" }, { status: 404 });
    if (!entry.revision_review_status) {
      return Response.json({ error: "当前修订记录缺失，请先修复数据后再审核" }, { status: 409 });
    }
    if (!(await canReviewStudent(auth.user, entry.student_id))) {
      return Response.json({ error: "当前账号无权审核该学生" }, { status: 403 });
    }
    if (entry.submitted_by_user_id === auth.user.id) {
      return Response.json({ error: "不能审核由自己提交或代录的进展" }, { status: 403 });
    }

    if (action === "start_review") {
      if (entry.review_status === "in_review" && entry.reviewed_by_user_id === auth.user.id) {
        if (
          entry.revision_review_status !== "in_review"
          || entry.revision_reviewed_by_user_id !== auth.user.id
        ) {
          return Response.json({ error: "进展与当前修订的审核状态不一致，请刷新后重试" }, { status: 409 });
        }
        return Response.json({ message: "该证据已由您接手审核", reviewStatus: "in_review" });
      }
      if (entry.review_status !== "submitted" || entry.revision_review_status !== "submitted") {
        return Response.json({ error: "该证据已被接手或审核完成" }, { status: 409 });
      }
      const [revisionResult, parentResult] = await d1.batch([
        d1.prepare(`UPDATE progress_revisions SET
          review_status = 'in_review', reviewed_by_user_id = ?
          WHERE progress_entry_id = ? AND revision_number = ? AND review_status = 'submitted'
            AND EXISTS (SELECT 1 FROM progress_entries
              WHERE id = ? AND review_status = 'submitted' AND current_revision = ?)`)
          .bind(auth.user.id, id, entry.current_revision, id, entry.current_revision),
        d1.prepare(`UPDATE progress_entries SET
          review_status = 'in_review', reviewed_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND review_status = 'submitted' AND current_revision = ?
            AND EXISTS (SELECT 1 FROM progress_revisions
              WHERE progress_entry_id = ? AND revision_number = ?
                AND review_status = 'in_review' AND reviewed_by_user_id = ?)`)
          .bind(auth.user.id, id, entry.current_revision, id, entry.current_revision, auth.user.id),
        d1.prepare(`INSERT INTO progress_audit_events
          (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
          SELECT ?, ?, 'user', 'start_review', 'submitted', 'in_review', ? WHERE changes() > 0`)
          .bind(id, auth.user.id, note),
      ]);
      if (!revisionResult.meta.changes || !parentResult.meta.changes) {
        return Response.json({ error: "该证据已被其他导师接手" }, { status: 409 });
      }
      return Response.json({ message: "已接手审核，其他导师将看到审核中状态", reviewStatus: "in_review" });
    }

    if (entry.review_status !== "submitted" && entry.review_status !== "in_review") {
      return Response.json({ error: "该记录已审核，请刷新后查看" }, { status: 409 });
    }
    if (
      entry.review_status === "in_review"
      && entry.reviewed_by_user_id
      && entry.reviewed_by_user_id !== auth.user.id
    ) {
      return Response.json({ error: "该证据正在由另一位导师审核" }, { status: 409 });
    }
    if (
      entry.revision_review_status !== entry.review_status
      || (
        entry.review_status === "in_review"
        && entry.revision_reviewed_by_user_id !== auth.user.id
      )
    ) {
      return Response.json({ error: "进展与当前修订的审核状态不一致，请刷新后重试" }, { status: 409 });
    }

    let reviewStatus: ReviewStatus;
    let assessment: ProgressAssessment = null;
    if (action === "substantive" || action === "supporting") {
      reviewStatus = "accepted";
      assessment = action;
    } else if (action === "supplement") {
      reviewStatus = "changes_requested";
    } else {
      reviewStatus = "rejected";
    }

    const completingMilestone = assessment === "substantive"
      && entry.kind === "项目"
      && entry.completion_requested === 1;
    if (completingMilestone) {
      const milestoneIsCurrent = entry.project_milestone_id
        && entry.proposal_id
        && entry.proposal_student_id === entry.student_id
        && entry.proposal_status === "approved"
        && entry.milestone_archived_at === null
        && entry.milestone_status !== "completed"
        && entry.project_proposal_version !== null
        && entry.proposal_current_version === entry.project_proposal_version;
      if (!milestoneIsCurrent) {
        return Response.json({ error: "关联节点或研究方案版本已变化，请补充新进展后再申请完成" }, { status: 409 });
      }
    }

    const paperStatus = assessment && entry.kind === "论文"
      ? paperAuthorityStatus(entry.paper_stage)
      : null;
    const reviewedPaperSnapshot = paperSnapshot(entry.revision_snapshot_json);
    if (assessment && entry.kind === "论文" && (!entry.paper_id || !paperStatus)) {
      return Response.json({ error: "论文进展详情不完整，无法回写论文阶段" }, { status: 409 });
    }

    const completionGuard = completingMilestone
      ? ` AND EXISTS (SELECT 1
          FROM project_progress_details guard_ppd
          JOIN research_milestones guard_m ON guard_m.id = guard_ppd.milestone_id
          JOIN research_proposals guard_rp ON guard_rp.id = guard_m.proposal_id
          WHERE guard_ppd.progress_entry_id = ? AND guard_ppd.completion_requested = 1
            AND guard_m.archived_at IS NULL AND guard_m.status <> 'completed'
            AND guard_rp.student_id = ? AND guard_rp.status = 'approved'
            AND guard_rp.current_version = guard_ppd.proposal_version)`
      : "";
    const completionBindings = completingMilestone ? [id, entry.student_id] : [];
    const legacyStatus = legacyProgressStatus(reviewStatus, assessment);
    const statements = [
      d1.prepare(`UPDATE progress_revisions SET
        review_status = ?, assessment = ?, reviewer_note = ?, reviewed_by_user_id = ?,
        reviewed_at = CURRENT_TIMESTAMP
        WHERE progress_entry_id = ? AND revision_number = ? AND review_status = ?
          AND (review_status <> 'in_review' OR reviewed_by_user_id = ?)
          AND EXISTS (SELECT 1 FROM progress_entries
            WHERE id = ? AND current_revision = ? AND review_status = ?
              AND (review_status <> 'in_review' OR reviewed_by_user_id = ?))${completionGuard}`)
        .bind(
          reviewStatus,
          assessment,
          note,
          auth.user.id,
          id,
          entry.current_revision,
          entry.revision_review_status,
          auth.user.id,
          id,
          entry.current_revision,
          entry.review_status,
          auth.user.id,
          ...completionBindings,
        ),
      d1.prepare(`UPDATE progress_entries SET
        status = ?, review_status = ?, assessment = ?, reviewer_note = ?,
        reviewed_by_user_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND current_revision = ? AND review_status = ?
          AND (review_status <> 'in_review' OR reviewed_by_user_id = ?)
          AND EXISTS (SELECT 1 FROM progress_revisions
            WHERE progress_entry_id = ? AND revision_number = ?
              AND review_status = ? AND reviewed_by_user_id = ?)${completionGuard}`)
        .bind(
          legacyStatus,
          reviewStatus,
          assessment,
          note,
          auth.user.id,
          id,
          entry.current_revision,
          entry.review_status,
          auth.user.id,
          id,
          entry.current_revision,
          reviewStatus,
          auth.user.id,
          ...completionBindings,
        ),
      d1.prepare(`INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, assessment, note)
        SELECT ?, ?, 'user', ?, ?, ?, ?, ? WHERE changes() > 0`)
        .bind(id, auth.user.id, action, entry.review_status, reviewStatus, assessment ?? "", note),
    ];
    if (assessment === "substantive") {
      statements.push(d1.prepare(`UPDATE students SET last_substantive_at = (
        SELECT MAX(submitted_at) FROM progress_entries
        WHERE student_id = ? AND review_status = 'accepted' AND assessment = 'substantive'
      ) WHERE id = ? AND EXISTS (SELECT 1 FROM progress_entries
        WHERE id = ? AND current_revision = ? AND review_status = 'accepted'
          AND assessment = 'substantive' AND reviewed_by_user_id = ?)`)
        .bind(entry.student_id, entry.student_id, id, entry.current_revision, auth.user.id));
    }
    if (assessment && entry.kind === "论文" && entry.paper_id && paperStatus) {
      statements.push(d1.prepare(`UPDATE student_papers SET current_stage = ?, status = ?,
        target_venue = COALESCE(NULLIF(?, ''), target_venue),
        planned_submission_date = COALESCE(NULLIF(?, ''), planned_submission_date),
        submission_identifier = COALESCE(NULLIF(?, ''), submission_identifier),
        latest_progress_at = (SELECT submitted_at FROM progress_entries WHERE id = ?),
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND student_id = ? AND EXISTS (SELECT 1 FROM progress_entries
          WHERE id = ? AND current_revision = ? AND review_status = 'accepted'
            AND reviewed_by_user_id = ?)`)
        .bind(
          entry.paper_stage,
          paperStatus,
          reviewedPaperSnapshot?.targetVenue ?? "",
          reviewedPaperSnapshot?.plannedSubmissionDate ?? "",
          reviewedPaperSnapshot?.submissionIdentifier ?? "",
          id,
          entry.paper_id,
          entry.student_id,
          id,
          entry.current_revision,
          auth.user.id,
        ));
    }
    let milestoneResultIndex: number | null = null;
    if (completingMilestone && entry.project_milestone_id && entry.proposal_id) {
      milestoneResultIndex = statements.length;
      statements.push(
        d1.prepare(`UPDATE research_milestones SET status = 'completed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND proposal_id = ? AND archived_at IS NULL AND status <> 'completed'
            AND EXISTS (SELECT 1 FROM research_proposals
              WHERE id = ? AND student_id = ? AND status = 'approved' AND current_version = ?)
            AND EXISTS (SELECT 1 FROM progress_entries
              WHERE id = ? AND current_revision = ? AND review_status = 'accepted'
                AND assessment = 'substantive' AND reviewed_by_user_id = ?)`)
          .bind(
            entry.project_milestone_id,
            entry.proposal_id,
            entry.proposal_id,
            entry.student_id,
            entry.project_proposal_version,
            id,
            entry.current_revision,
            auth.user.id,
          ),
        d1.prepare(`INSERT INTO proposal_audit_events
          (proposal_id, actor_user_id, action, detail)
          SELECT ?, ?, 'milestone_completed_from_progress', ? WHERE changes() > 0`)
          .bind(
            entry.proposal_id,
            auth.user.id,
            `进展 #${id}（修订 V${entry.current_revision}）通过实质进展审核，完成节点“${entry.milestone_title ?? entry.project_milestone_id}”`,
          ),
      );
    }
    const results = await d1.batch(statements);
    const parentResult = results[1];
    if (!parentResult.meta.changes) {
      return Response.json({ error: "记录、修订或关联节点已被其他操作更新" }, { status: 409 });
    }
    if (milestoneResultIndex !== null && !results[milestoneResultIndex]?.meta.changes) {
      return Response.json({ error: "审核已保存，但关联节点状态已变化，请刷新确认" }, { status: 409 });
    }
    return Response.json({ message: "审核已保存并写入证据审计记录", reviewStatus, assessment });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "审核失败" }, { status: 500 });
  }
}
