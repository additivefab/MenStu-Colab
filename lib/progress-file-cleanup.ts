import { getD1 } from "./database";
import { getProgressFileBucket } from "./progress-file-storage";
import {
  claimCleanupObjectSql,
  claimOwnedIncompleteProgressSql,
  claimProgressUploadIntentsSql,
  claimQueuedStaleProgressSql,
  claimScopedStaleProgressSql,
  claimStaleResubmissionUploadSql,
  discardFinalizedCleanupSql,
  queuedProgressCleanupCandidatesSql,
} from "./progress-saga-sql";

export type ProgressFileCleanupItem = {
  storageKey: string;
  progressEntryId: number | null;
  studentId: string;
  revisionNumber: number;
};

type ProgressFileCleanupRow = {
  storage_key: string;
  progress_entry_id: number | null;
  student_id: string;
  revision_number: number;
  reason: string;
};

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error || "R2 delete failed")).slice(0, 1000);
}

async function queueFailedCleanup(items: ProgressFileCleanupItem[], reason: string, errors: unknown[]) {
  if (!items.length) return;
  const d1 = getD1();
  await d1.batch(items.map((item, index) => d1.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, reason, attempts, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(storage_key) DO UPDATE SET
      progress_entry_id = COALESCE(excluded.progress_entry_id, progress_entry_id),
      student_id = excluded.student_id,
      revision_number = excluded.revision_number,
      reason = excluded.reason,
      attempts = attempts + 1,
      last_error = excluded.last_error,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(
      item.storageKey,
      item.progressEntryId,
      item.studentId,
      item.revisionNumber,
      reason.slice(0, 120),
      errorMessage(errors[index]),
    )));
}

export async function deleteProgressFilesOrQueue(items: ProgressFileCleanupItem[], reason: string) {
  if (!items.length) return { deleted: 0, queued: 0 };
  const bucket = getProgressFileBucket();
  const results = await Promise.allSettled(items.map((item) => bucket.delete(item.storageKey)));
  const failedItems: ProgressFileCleanupItem[] = [];
  const errors: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failedItems.push(items[index]);
      errors.push(result.reason);
    }
  });
  const deletedItems = items.filter((_, index) => results[index]?.status === "fulfilled");
  if (deletedItems.length) {
    await getD1().batch(deletedItems.map((item) => (
      getD1().prepare("DELETE FROM progress_file_cleanup_queue WHERE storage_key = ?")
        .bind(item.storageKey)
    )));
  }
  await queueFailedCleanup(failedItems, reason, errors);
  return { deleted: items.length - failedItems.length, queued: failedItems.length };
}

async function cleanupRowsForProgress(progressEntryId: number) {
  return getD1().prepare(`SELECT storage_key, progress_entry_id, student_id, revision_number, reason
    FROM progress_file_cleanup_queue WHERE progress_entry_id = ? ORDER BY storage_key`)
    .bind(progressEntryId).all<ProgressFileCleanupRow>();
}

async function claimCleanupObject(row: ProgressFileCleanupRow) {
  const claimToken = `cleanup_claimed:${crypto.randomUUID()}`;
  const claimed = await getD1().prepare(claimCleanupObjectSql)
    .bind(claimToken, row.storage_key, row.reason)
    .first<Omit<ProgressFileCleanupRow, "reason"> & { storage_key: string }>();
  if (!claimed) {
    await getD1().prepare(discardFinalizedCleanupSql).bind(row.storage_key).run();
    return null;
  }
  return { ...claimed, reason: claimToken } satisfies ProgressFileCleanupRow;
}

async function deleteClaimedCleanupObject(row: ProgressFileCleanupRow) {
  const d1 = getD1();
  try {
    await getProgressFileBucket().delete(row.storage_key);
    await d1.prepare("DELETE FROM progress_file_cleanup_queue WHERE storage_key = ? AND reason = ?")
      .bind(row.storage_key, row.reason).run();
    return true;
  } catch (error) {
    await d1.prepare(`UPDATE progress_file_cleanup_queue SET
      reason = 'cleanup_retry', attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE storage_key = ? AND reason = ?`)
      .bind(errorMessage(error), row.storage_key, row.reason).run();
    return false;
  }
}

async function claimStaleResubmissionUpload(row: ProgressFileCleanupRow) {
  const claimToken = `cleanup_claimed:${crypto.randomUUID()}`;
  const claimed = await getD1().prepare(claimStaleResubmissionUploadSql)
    .bind(claimToken, row.storage_key)
    .first<Omit<ProgressFileCleanupRow, "reason"> & { storage_key: string }>();
  return claimed ? { ...claimed, reason: claimToken } satisfies ProgressFileCleanupRow : null;
}

async function cleanupClaimedRows(rows: ProgressFileCleanupRow[]) {
  let deleted = 0;
  for (const row of rows) {
    const claimed = await claimCleanupObject(row);
    if (claimed && await deleteClaimedCleanupObject(claimed)) deleted += 1;
  }
  return deleted;
}

async function cleanupAlreadyClaimedRows(rows: ProgressFileCleanupRow[]) {
  let deleted = 0;
  for (const row of rows) {
    if (await deleteClaimedCleanupObject(row)) deleted += 1;
  }
  return deleted;
}

export async function recoverStaleProgressSubmission(input: {
  progressId: number;
  submittedByUserId: number;
  idempotencyKey: string;
}) {
  const d1 = getD1();
  const cleanupRows = await cleanupRowsForProgress(input.progressId);
  const claimed = await d1.prepare(claimScopedStaleProgressSql)
    .bind(input.progressId, input.submittedByUserId, input.idempotencyKey)
    .first<{ id: number }>();
  if (!claimed) return { claimed: false, deletedObjects: 0 };

  // ON DELETE SET NULL keeps every upload intent durable after the parent becomes
  // the D1 claim. Only the winner of that delete may touch the corresponding R2 objects.
  const rows = cleanupRows.results.map((row) => ({ ...row, progress_entry_id: null }));
  const deletedObjects = await cleanupClaimedRows(rows).catch(() => 0);
  return { claimed: true, deletedObjects };
}

export async function recoverOwnedIncompleteProgressSubmission(input: {
  progressId: number;
  submittedByUserId: number;
  idempotencyKey: string;
  requestHash: string;
}) {
  const d1 = getD1();
  const cleanupRows = await cleanupRowsForProgress(input.progressId);
  const claimed = await d1.prepare(claimOwnedIncompleteProgressSql)
    .bind(input.progressId, input.submittedByUserId, input.idempotencyKey, input.requestHash)
    .first<{ id: number }>();
  if (!claimed) return { claimed: false, deletedObjects: 0 };
  const deletedObjects = await cleanupClaimedRows(
    cleanupRows.results.map((row) => ({ ...row, progress_entry_id: null })),
  ).catch(() => 0);
  return { claimed: true, deletedObjects };
}

export async function abortProgressUploadIntents(input: {
  progressId: number;
  revisionNumber: number;
  storageKeys: string[];
}) {
  const storageKeys = [...new Set(input.storageKeys)];
  if (!storageKeys.length) return { claimed: true, deletedObjects: 0 };
  const claimToken = `cleanup_claimed:${crypto.randomUUID()}`;
  const claimed = await getD1().prepare(claimProgressUploadIntentsSql(storageKeys.length))
    .bind(
      claimToken,
      input.progressId,
      input.revisionNumber,
      ...storageKeys,
      input.progressId,
      input.revisionNumber,
      ...storageKeys,
      storageKeys.length,
    )
    .all<Omit<ProgressFileCleanupRow, "reason">>();
  if (claimed.results.length !== storageKeys.length) {
    return { claimed: false, deletedObjects: 0 };
  }
  const rows = claimed.results.map((row) => ({ ...row, reason: claimToken }));
  const deletedObjects = await cleanupAlreadyClaimedRows(rows).catch(() => 0);
  return { claimed: true, deletedObjects };
}

export async function retryQueuedProgressFileCleanup(limit = 10) {
  const d1 = getD1();
  const queued = await d1.prepare(queuedProgressCleanupCandidatesSql)
    .bind(Math.max(1, Math.min(50, Math.floor(limit))))
    .all<ProgressFileCleanupRow>();
  if (!queued.results.length) {
    const remaining = await d1.prepare("SELECT COUNT(*) AS count FROM progress_file_cleanup_queue")
      .first<{ count: number }>();
    return { deleted: 0, remaining: Number(remaining?.count ?? 0) };
  }

  let deleted = 0;
  const handledKeys = new Set<string>();
  for (const item of queued.results) {
    if (handledKeys.has(item.storage_key)) continue;
    if (item.reason === "upload_intent" && item.progress_entry_id !== null) {
      const siblingRows = await cleanupRowsForProgress(item.progress_entry_id);
      const claimedParent = await d1.prepare(claimQueuedStaleProgressSql)
        .bind(item.progress_entry_id).first<{ id: number }>();
      if (!claimedParent) {
        // An incomplete POST can also be protected by a fresh sibling upload
        // intent, so a failed parent claim alone does not authorize R2 cleanup.
        // Atomically require a completed current revision: this selects an
        // abandoned PATCH upload, whose finalizer uses this row as its D1 lease.
        handledKeys.add(item.storage_key);
        const claimedUpload = await claimStaleResubmissionUpload(item);
        if (claimedUpload && await deleteClaimedCleanupObject(claimedUpload)) deleted += 1;
        continue;
      }
      siblingRows.results.forEach((row) => handledKeys.add(row.storage_key));
      deleted += await cleanupClaimedRows(siblingRows.results.map((row) => ({
        ...row,
        progress_entry_id: null,
      })));
      continue;
    }
    handledKeys.add(item.storage_key);
    deleted += await cleanupClaimedRows([item]);
  }
  const remaining = await d1.prepare("SELECT COUNT(*) AS count FROM progress_file_cleanup_queue")
    .first<{ count: number }>();
  return { deleted, remaining: Number(remaining?.count ?? 0) };
}
