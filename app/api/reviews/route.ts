import { canReviewStudent } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { legacyProgressStatus, type ProgressAssessment, type ReviewStatus } from "../../../lib/progress-evidence";

const finalActions = new Set(["substantive", "supporting", "supplement", "rejected"]);

type EntryRow = {
  id: number;
  student_id: string;
  review_status: ReviewStatus;
  reviewed_by_user_id: number | null;
  submitted_by_user_id: number | null;
};

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
    const entry = await d1.prepare(`SELECT id, student_id, review_status, reviewed_by_user_id, submitted_by_user_id
      FROM progress_entries WHERE id = ?`).bind(id).first<EntryRow>();
    if (!entry) return Response.json({ error: "记录不存在" }, { status: 404 });
    if (!(await canReviewStudent(auth.user, entry.student_id))) {
      return Response.json({ error: "当前账号无权审核该学生" }, { status: 403 });
    }
    if (entry.submitted_by_user_id === auth.user.id) {
      return Response.json({ error: "不能审核由自己提交或代录的进展" }, { status: 403 });
    }

    if (action === "start_review") {
      if (entry.review_status === "in_review" && entry.reviewed_by_user_id === auth.user.id) {
        return Response.json({ message: "该证据已由您接手审核", reviewStatus: "in_review" });
      }
      if (entry.review_status !== "submitted") {
        return Response.json({ error: "该证据已被接手或审核完成" }, { status: 409 });
      }
      const [result] = await d1.batch([
        d1.prepare(`UPDATE progress_entries SET
          review_status = 'in_review', reviewed_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND review_status = 'submitted'`)
          .bind(auth.user.id, id),
        d1.prepare(`INSERT INTO progress_audit_events
          (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
          SELECT ?, ?, 'user', 'start_review', 'submitted', 'in_review', ? WHERE changes() > 0`)
          .bind(id, auth.user.id, note),
      ]);
      if (!result.meta.changes) return Response.json({ error: "该证据已被其他导师接手" }, { status: 409 });
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
    const legacyStatus = legacyProgressStatus(reviewStatus, assessment);
    const statements = [
      d1.prepare(`UPDATE progress_entries SET
        status = ?, review_status = ?, assessment = ?, reviewer_note = ?,
        reviewed_by_user_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND review_status = ?`)
        .bind(legacyStatus, reviewStatus, assessment, note, auth.user.id, id, entry.review_status),
      d1.prepare(`INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, assessment, note)
        SELECT ?, ?, 'user', ?, ?, ?, ?, ? WHERE changes() > 0`)
        .bind(id, auth.user.id, action, entry.review_status, reviewStatus, assessment ?? "", note),
    ];
    if (assessment === "substantive") {
      statements.push(d1.prepare(`UPDATE students SET last_substantive_at = (
        SELECT MAX(submitted_at) FROM progress_entries
        WHERE student_id = ? AND review_status = 'accepted' AND assessment = 'substantive'
      ) WHERE id = ? AND changes() > 0`).bind(entry.student_id, entry.student_id));
    }
    const [result] = await d1.batch(statements);
    if (!result.meta.changes) return Response.json({ error: "记录已被其他审核操作更新" }, { status: 409 });
    return Response.json({ message: "审核已保存并写入证据审计记录", reviewStatus, assessment });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "审核失败" }, { status: 500 });
  }
}
