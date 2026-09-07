// Keep the original progress, revisions and import links for recovery and deduplication.
export const createProgressDeletionsSql = `CREATE TABLE IF NOT EXISTS progress_deletions (
  progress_entry_id INTEGER PRIMARY KEY REFERENCES progress_entries(id),
  deleted_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_id TEXT NOT NULL
)`;

// A review already in flight must roll back instead of modifying a deleted record.
export const protectDeletedProgressSql = `CREATE TRIGGER IF NOT EXISTS protect_deleted_progress
  BEFORE UPDATE ON progress_entries
  WHEN EXISTS (SELECT 1 FROM progress_deletions WHERE progress_entry_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'AI_RECORD_DELETED'); END`;

export const aiRecordCondition = `p.kind = '组会'
  AND EXISTS (SELECT 1 FROM progress_revisions revision
    WHERE revision.progress_entry_id = p.id AND revision.revision_number = p.current_revision)
  AND (EXISTS (SELECT 1 FROM feishu_meeting_summary_links l
    WHERE l.progress_entry_id = p.id AND l.student_id = p.student_id)
    OR EXISTS (SELECT 1 FROM progress_evidence_sources e WHERE e.progress_entry_id = p.id
      AND (e.source_type GLOB 'feishu_*' OR e.label LIKE '%智能纪要%' OR e.label LIKE '%飞书妙记%')))
  AND NOT EXISTS (SELECT 1 FROM paper_progress_details WHERE progress_entry_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM project_progress_details WHERE progress_entry_id = p.id)`;

type ChangeInput = {
  progressId: number;
  revision: number;
  reviewStatus: string;
  actorId: number;
  role: string;
  ownStudentId: string | null;
  action: 'delete' | 'restore';
  operationId: string;
  deletionId?: string;
};

export function aiRecordChangeStatements(input: ChangeInput) {
  if (input.role !== 'admin' && input.role !== 'superadmin') throw new Error('无权管理 AI 记录');
  const eligible = `SELECT p.id FROM progress_entries p
    WHERE p.id = ? AND p.current_revision = ? AND p.review_status = ?
      AND p.student_id != COALESCE(?, '') AND ${aiRecordCondition}
      AND EXISTS (SELECT 1 FROM app_users actor WHERE actor.id = ? AND actor.active = 1
        AND actor.role = ? AND (actor.student_id IS NULL OR actor.student_id != p.student_id))
      AND (? = 'superadmin' OR EXISTS (SELECT 1 FROM mentor_student_assignments a
        WHERE a.mentor_user_id = ? AND a.student_id = p.student_id AND a.active = 1 AND a.can_review = 1))`;
  const scope = [input.progressId, input.revision, input.reviewStatus, input.ownStudentId,
    input.actorId, input.role, input.role, input.actorId];
  const statements: Array<{ sql: string; bindings: Array<string | number | null> }> = [];
  if (input.action === 'delete') {
    statements.push({
      sql: `INSERT INTO progress_deletions (progress_entry_id, deleted_by_user_id, operation_id)
        SELECT id, ?, ? FROM (${eligible}) WHERE 1 = 1
        ON CONFLICT(progress_entry_id) DO NOTHING`,
      bindings: [input.actorId, input.operationId, ...scope],
    }, {
      sql: `INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
        SELECT p.id, ?, 'user', 'ai_record_deleted', p.review_status, p.review_status, '管理员删除 AI 记录'
        FROM progress_entries p JOIN progress_deletions d ON d.progress_entry_id = p.id
        WHERE d.operation_id = ? AND p.id = ?`,
      bindings: [input.actorId, input.operationId, input.progressId],
    });
  } else {
    statements.push({
      sql: `INSERT INTO progress_audit_events
        (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
        SELECT p.id, ?, 'user', 'ai_record_restored', p.review_status, p.review_status, '管理员恢复 AI 记录'
        FROM progress_entries p JOIN progress_deletions d ON d.progress_entry_id = p.id
        WHERE d.operation_id = ? AND p.id IN (${eligible})`,
      bindings: [input.actorId, input.deletionId ?? '', ...scope],
    }, {
      sql: `DELETE FROM progress_deletions WHERE operation_id = ? AND progress_entry_id IN (${eligible})`,
      bindings: [input.deletionId ?? '', ...scope],
    });
  }
  statements.push({
    sql: `UPDATE students SET last_substantive_at = (
      SELECT MAX(p.submitted_at) FROM progress_entries p
      WHERE p.student_id = students.id AND p.review_status = 'accepted' AND p.assessment = 'substantive'
        AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)
    ) WHERE id = (SELECT student_id FROM progress_entries WHERE id IN (${eligible}))`,
    bindings: scope,
  });
  return statements;
}
