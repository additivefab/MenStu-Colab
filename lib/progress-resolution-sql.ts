// The source query is supplied by acceptedTrackProgressSql, never by a request.
export function resolutionSourceGuardSql(sourceSql: string) {
  return `EXISTS (SELECT 1 FROM (${sourceSql}) current_source
    JOIN students active_student ON active_student.id = current_source.student_id AND active_student.active = 1
    WHERE current_source.id = ? AND current_source.current_revision = ?)`;
}
export const resolutionStudentAuthoritySql = `EXISTS (SELECT 1 FROM app_users actor
  WHERE actor.id = ? AND actor.active = 1 AND actor.student_id = ?
    AND actor.role IN ('student', 'mentor', 'admin', 'superadmin'))`;
export const resolutionReviewerAuthoritySql = `EXISTS (SELECT 1 FROM app_users actor
  WHERE actor.id = ? AND actor.active = 1 AND COALESCE(actor.student_id, '') != ?
    AND (actor.role = 'superadmin' OR (actor.role IN ('mentor', 'admin') AND EXISTS (
      SELECT 1 FROM mentor_student_assignments assignment
      WHERE assignment.mentor_user_id = actor.id AND assignment.student_id = ?
        AND assignment.active = 1 AND assignment.can_review = 1))))`;
export function resolutionUploadGuardSql(count: number) {
  if (!count) return "1 = 1";
  return `(SELECT COUNT(*) FROM progress_file_cleanup_queue intent
    WHERE intent.storage_key IN (${Array.from({ length: count }, () => "?").join(",")})
      AND intent.progress_entry_id IS NULL AND intent.reason = 'upload_intent') = ${count}`;
}
export function insertResolutionSql(guard: string) {
  return `INSERT INTO progress_resolutions
    (student_id, progress_entry_id, revision_number, item_kind, source_title, source_text, source_due_date,
      track_type, status, version, submission_note, submitted_by_user_id, submitted_at, last_request_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, CURRENT_TIMESTAMP, ?
    WHERE ${guard}
    ON CONFLICT(progress_entry_id, revision_number, item_kind) DO NOTHING RETURNING id`;
}
export function updateResolutionSql(guard: string) {
  return `UPDATE progress_resolutions SET status = ?, version = version + 1,
    submission_note = CASE WHEN ? = 'submit' THEN ? ELSE submission_note END,
    submitted_by_user_id = CASE WHEN ? = 'submit' THEN ? ELSE submitted_by_user_id END,
    submitted_at = CASE WHEN ? = 'submit' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
    reviewer_note = CASE WHEN ? = 'submit' THEN '' ELSE ? END,
    resolved_at = CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE NULL END,
    last_request_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE progress_entry_id = ? AND revision_number = ? AND item_kind = ?
      AND version = ? AND status = ? AND (? = 'submit' OR submitted_by_user_id IS NOT ?)
      AND ${guard} RETURNING id`;
}
export function insertConfirmedResolutionSql(guard: string) {
  return `INSERT INTO progress_resolutions
    (student_id, progress_entry_id, revision_number, item_kind, source_title, source_text, source_due_date,
      track_type, status, version, reviewer_note, resolved_at, last_request_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', 1, ?, CURRENT_TIMESTAMP, ?
    WHERE ${guard}
    ON CONFLICT(progress_entry_id, revision_number, item_kind) DO NOTHING RETURNING id`;
}
export function insertReturnedResolutionSql(guard: string) {
  return `INSERT INTO progress_resolutions
    (student_id, progress_entry_id, revision_number, item_kind, source_title, source_text, source_due_date,
      track_type, status, version, reviewer_note, last_request_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'changes_requested', 1, ?, ?
    WHERE ${guard}
    ON CONFLICT(progress_entry_id, revision_number, item_kind) DO NOTHING RETURNING id`;
}
export const insertResolutionEventSql = `INSERT INTO progress_resolution_events
  (resolution_id, actor_user_id, action, from_status, to_status, version, note, request_id, request_hash)
  SELECT id, ?, ?, ?, status, version, ?, ?, ? FROM progress_resolutions
  WHERE progress_entry_id = ? AND revision_number = ? AND item_kind = ?
    AND last_request_id = ? AND version = ? RETURNING id`;
export const insertResolutionAuditSql = `INSERT INTO progress_audit_events
  (progress_entry_id, actor_user_id, actor_type, action, from_status, to_status, note)
  SELECT pr.progress_entry_id, e.actor_user_id, 'user', 'resolution_' || e.action,
    e.from_status, e.to_status, pr.item_kind || ': ' || e.note
  FROM progress_resolution_events e JOIN progress_resolutions pr ON pr.id = e.resolution_id
  WHERE e.actor_user_id = ? AND e.request_id = ? AND pr.last_request_id = ? AND pr.version = e.version`;
