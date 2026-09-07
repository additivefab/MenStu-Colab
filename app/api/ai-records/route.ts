import { canReviewStudent } from '../../../lib/authorization';
import { aiRecordChangeStatements, aiRecordCondition } from '../../../lib/ai-record-deletion';
import { ensureDatabase, getD1 } from '../../../lib/database';
import { assertSameOrigin, requireAppUser } from '../../../lib/feishu-auth';

async function changeRecord(request: Request, action: 'delete' | 'restore') {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: '请求来源无效' }, { status: 403 });
    const auth = await requireAppUser(request, ['superadmin', 'admin']);
    if ('response' in auth) return auth.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'AI 记录参数无效' }, { status: 400 });
    }
    const progressId = Number(body.progressId);
    const revision = Number(body.revision);
    const reviewStatus = String(body.reviewStatus ?? '');
    const deletionId = typeof body.deletionId === 'string' ? body.deletionId : '';
    if (!Number.isSafeInteger(progressId) || progressId < 1 || !Number.isSafeInteger(revision) || revision < 1
      || !['submitted', 'in_review', 'accepted', 'changes_requested', 'rejected'].includes(reviewStatus)
      || (action === 'restore' && (!deletionId || deletionId.length > 80))) {
      return Response.json({ error: 'AI 记录参数无效' }, { status: 400 });
    }
    await ensureDatabase();
    const db = getD1();
    const record = await db.prepare(`SELECT p.student_id, p.current_revision, p.review_status,
      d.operation_id AS deletion_id FROM progress_entries p
      LEFT JOIN progress_deletions d ON d.progress_entry_id = p.id
      WHERE p.id = ? AND ${aiRecordCondition}`).bind(progressId)
      .first<{ student_id: string; current_revision: number; review_status: string; deletion_id: string | null }>();
    if (!record) return Response.json({ error: 'AI 记录不存在' }, { status: 404 });
    if (!(await canReviewStudent(auth.user, record.student_id))) {
      return Response.json({ error: '无权管理该学生的 AI 记录' }, { status: 403 });
    }
    if (record.current_revision !== revision || record.review_status !== reviewStatus) {
      return Response.json({ error: '记录已更新，请刷新后重试' }, { status: 409 });
    }
    if (action === 'restore' && record.deletion_id && record.deletion_id !== deletionId) {
      return Response.json({ error: '删除记录已更新，请刷新后重试' }, { status: 409 });
    }
    if ((action === 'delete') !== Boolean(record.deletion_id)) {
      const statements = aiRecordChangeStatements({ progressId, revision, reviewStatus,
        actorId: auth.user.id, role: auth.user.role, ownStudentId: auth.user.studentId,
        action, operationId: crypto.randomUUID(), deletionId });
      const results = await db.batch(statements.map(({ sql, bindings }) => db.prepare(sql).bind(...bindings)));
      if (!(results[0].meta.changes > 0)) {
        return Response.json({ error: '记录或权限已更新，请刷新后重试' }, { status: 409 });
      }
    }
    return Response.json({ message: action === 'delete' ? '已删除，可在“已删除”中恢复' : '已恢复 AI 记录' });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '操作失败，请重试' }, { status: 500 });
  }
}

export async function DELETE(request: Request) { return changeRecord(request, 'delete'); }
export async function PATCH(request: Request) { return changeRecord(request, 'restore'); }

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ['superadmin', 'admin']);
    if ('response' in auth) return auth.response;
    await ensureDatabase();
    const studentId = new URL(request.url).searchParams.get('studentId')?.trim();
    if (!studentId) return Response.json({ error: '缺少学生参数' }, { status: 400 });
    if (!(await canReviewStudent(auth.user, studentId))) {
      return Response.json({ error: '无权管理该学生的 AI 记录' }, { status: 403 });
    }
    const records = await getD1().prepare(`SELECT p.id, p.title, p.current_revision, p.review_status,
      d.deleted_at, d.operation_id AS deletion_id, u.display_name AS deleted_by
      FROM progress_deletions d JOIN progress_entries p ON p.id = d.progress_entry_id
      JOIN app_users u ON u.id = d.deleted_by_user_id
      WHERE p.student_id = ? AND ${aiRecordCondition}
      ORDER BY d.deleted_at DESC, p.id DESC`).bind(studentId).all();
    return Response.json({ records: records.results }, {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '已删除记录读取失败' }, { status: 500 });
  }
}
