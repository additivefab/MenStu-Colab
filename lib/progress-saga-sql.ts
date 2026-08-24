export const claimScopedStaleProgressSql = `DELETE FROM progress_entries
  WHERE id = ? AND submitted_by_user_id = ? AND idempotency_key = ?
    AND idempotency_key <> ''
    AND submitted_at <= datetime('now', '-30 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM progress_file_cleanup_queue fresh_intent
      WHERE fresh_intent.progress_entry_id = progress_entries.id
        AND fresh_intent.reason = 'upload_intent'
        AND fresh_intent.updated_at > datetime('now', '-30 minutes')
    )
    AND NOT EXISTS (
      SELECT 1 FROM progress_revisions current_revision
      WHERE current_revision.progress_entry_id = progress_entries.id
        AND current_revision.revision_number = progress_entries.current_revision
    )
  RETURNING id`;

export const claimOwnedIncompleteProgressSql = `DELETE FROM progress_entries
  WHERE id = ? AND submitted_by_user_id = ? AND idempotency_key = ? AND request_hash = ?
    AND idempotency_key <> ''
    AND NOT EXISTS (
      SELECT 1 FROM progress_revisions current_revision
      WHERE current_revision.progress_entry_id = progress_entries.id
        AND current_revision.revision_number = progress_entries.current_revision
    )
  RETURNING id`;

export const claimQueuedStaleProgressSql = `DELETE FROM progress_entries
  WHERE id = ? AND idempotency_key <> ''
    AND submitted_at <= datetime('now', '-30 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM progress_file_cleanup_queue fresh_intent
      WHERE fresh_intent.progress_entry_id = progress_entries.id
        AND fresh_intent.reason = 'upload_intent'
        AND fresh_intent.updated_at > datetime('now', '-30 minutes')
    )
    AND NOT EXISTS (
      SELECT 1 FROM progress_revisions current_revision
      WHERE current_revision.progress_entry_id = progress_entries.id
        AND current_revision.revision_number = progress_entries.current_revision
    )
  RETURNING id`;

export const claimCleanupObjectSql = `UPDATE progress_file_cleanup_queue
  SET reason = ?, updated_at = CURRENT_TIMESTAMP
  WHERE storage_key = ? AND reason = ?
    AND (reason NOT LIKE 'cleanup_claimed:%'
      OR updated_at <= datetime('now', '-30 minutes'))
    AND NOT EXISTS (
      SELECT 1 FROM progress_attachments finalized_attachment
      WHERE finalized_attachment.storage_key = progress_file_cleanup_queue.storage_key
    )
  RETURNING storage_key, progress_entry_id, student_id, revision_number`;

export const discardFinalizedCleanupSql = `DELETE FROM progress_file_cleanup_queue
  WHERE storage_key = ? AND EXISTS (
    SELECT 1 FROM progress_attachments finalized_attachment
    WHERE finalized_attachment.storage_key = progress_file_cleanup_queue.storage_key
  )`;

export const claimStaleResubmissionUploadSql = `UPDATE progress_file_cleanup_queue
  SET reason = ?, updated_at = CURRENT_TIMESTAMP
  WHERE storage_key = ? AND reason = 'upload_intent'
    AND updated_at <= datetime('now', '-30 minutes')
    AND EXISTS (
      SELECT 1 FROM progress_entries completed_parent
      JOIN progress_revisions current_revision
        ON current_revision.progress_entry_id = completed_parent.id
       AND current_revision.revision_number = completed_parent.current_revision
      WHERE completed_parent.id = progress_file_cleanup_queue.progress_entry_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM progress_attachments finalized_attachment
      WHERE finalized_attachment.storage_key = progress_file_cleanup_queue.storage_key
    )
  RETURNING storage_key, progress_entry_id, student_id, revision_number`;

export const queuedProgressCleanupCandidatesSql = `SELECT
    storage_key, progress_entry_id, student_id, revision_number, reason
  FROM progress_file_cleanup_queue
  WHERE (reason != 'upload_intent' AND reason NOT LIKE 'cleanup_claimed:%')
    OR updated_at <= datetime('now', '-30 minutes')
  ORDER BY updated_at, storage_key LIMIT ?`;

function placeholders(count: number) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("storage key count must be a positive integer");
  }
  return Array.from({ length: count }, () => "?").join(",");
}

export function progressUploadIntentGuardSql(storageKeyCount: number) {
  const keys = placeholders(storageKeyCount);
  return ` AND (SELECT COUNT(*) FROM progress_file_cleanup_queue guarded_intent
    WHERE guarded_intent.progress_entry_id = progress_entries.id
      AND guarded_intent.revision_number = ? AND guarded_intent.reason = 'upload_intent'
      AND guarded_intent.storage_key IN (${keys})) = ?`;
}

export function claimProgressUploadIntentsSql(storageKeyCount: number) {
  const keys = placeholders(storageKeyCount);
  return `UPDATE progress_file_cleanup_queue SET
      reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE progress_entry_id = ? AND revision_number = ? AND reason = 'upload_intent'
      AND storage_key IN (${keys})
      AND (SELECT COUNT(*) FROM progress_file_cleanup_queue intent_guard
        WHERE intent_guard.progress_entry_id = ? AND intent_guard.revision_number = ?
          AND intent_guard.reason = 'upload_intent'
          AND intent_guard.storage_key IN (${keys})) = ?
    RETURNING storage_key, progress_entry_id, student_id, revision_number`;
}
