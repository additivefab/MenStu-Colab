import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  claimCleanupObjectSql,
  claimProgressUploadIntentsSql,
  claimQueuedStaleProgressSql,
  claimScopedStaleProgressSql,
  claimStaleResubmissionUploadSql,
  discardFinalizedCleanupSql,
  progressUploadIntentGuardSql,
  queuedProgressCleanupCandidatesSql,
} from "../lib/progress-saga-sql.ts";

async function databaseAtV19() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
  for (const name of names) database.exec(await readFile(new URL(name, directory), "utf8"));
  database.exec(`
    INSERT INTO students
      (id, display_name, degree, grade_year, stage, cadence_days, current_focus, active)
      VALUES ('saga-student', 'Saga 测试', '博士', 2025, '实验', 14, '并发恢复', 1);
    INSERT INTO app_users (id, feishu_open_id, display_name, role, student_id)
      VALUES (1, 'open-saga-student', 'Saga 学生', 'student', 'saga-student');
  `);
  return database;
}

function insertStaleParent(database, id, key) {
  database.prepare(`INSERT INTO progress_entries
    (id, student_id, kind, title, summary, evidence, review_status, submitted_by_user_id,
     idempotency_key, request_hash, submitted_at)
    VALUES (?, 'saga-student', '项目', '上传中', '等待 finalize', '附件', 'submitted', 1,
      ?, 'same-request', datetime('now', '-31 minutes'))`).run(id, key);
  database.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, reason)
    VALUES (?, ?, 'saga-student', 1, 'upload_intent')`).run(`progress/saga/${id}.pdf`, id);
}

function expireUploadIntents(database, progressId) {
  database.prepare(`UPDATE progress_file_cleanup_queue
    SET updated_at = datetime('now', '-31 minutes') WHERE progress_entry_id = ?`).run(progressId);
}

test("a current revision and the stale reaper claim are mutually exclusive", async () => {
  const database = await databaseAtV19();

  insertStaleParent(database, 10, "saga_finalize_wins");
  expireUploadIntents(database, 10);
  database.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
    VALUES (10, 1, '{}', 1)`).run();
  assert.equal(database.prepare(claimQueuedStaleProgressSql).get(10), undefined);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_entries WHERE id = 10").get().count, 1);
  assert.equal(database.prepare(`SELECT progress_entry_id FROM progress_file_cleanup_queue
    WHERE storage_key = 'progress/saga/10.pdf'`).get().progress_entry_id, 10);

  insertStaleParent(database, 11, "saga_reaper_wins");
  expireUploadIntents(database, 11);
  assert.deepEqual({ ...database.prepare(claimQueuedStaleProgressSql).get(11) }, { id: 11 });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_entries WHERE id = 11").get().count, 0);
  assert.equal(database.prepare(`SELECT progress_entry_id FROM progress_file_cleanup_queue
    WHERE storage_key = 'progress/saga/11.pdf'`).get().progress_entry_id, null);
  assert.throws(
    () => database.prepare(`INSERT INTO progress_revisions
      (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
      VALUES (11, 1, '{}', 1)`).run(),
    /FOREIGN KEY constraint failed/u,
  );
  database.close();
});

test("scoped stale recovery cannot claim another submitter or idempotency key", async () => {
  const database = await databaseAtV19();
  insertStaleParent(database, 20, "saga_scoped_owner");
  expireUploadIntents(database, 20);
  assert.equal(database.prepare(claimScopedStaleProgressSql).get(20, 999, "saga_scoped_owner"), undefined);
  assert.equal(database.prepare(claimScopedStaleProgressSql).get(20, 1, "wrong_key"), undefined);
  assert.deepEqual(
    { ...database.prepare(claimScopedStaleProgressSql).get(20, 1, "saga_scoped_owner") },
    { id: 20 },
  );
  database.close();
});

test("a fresh upload intent leases a stale parent against retry and worker recovery", async () => {
  const database = await databaseAtV19();
  insertStaleParent(database, 22, "saga_fresh_upload_lease");
  assert.equal(database.prepare(claimQueuedStaleProgressSql).get(22), undefined);
  assert.equal(
    database.prepare(claimScopedStaleProgressSql).get(22, 1, "saga_fresh_upload_lease"),
    undefined,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_entries WHERE id = 22").get().count, 1);

  expireUploadIntents(database, 22);
  assert.deepEqual(
    { ...database.prepare(claimScopedStaleProgressSql).get(22, 1, "saga_fresh_upload_lease") },
    { id: 22 },
  );
  database.close();
});

test("a fresh sibling lease cannot turn stale POST cleanup into an attachment-first delete", async () => {
  const database = await databaseAtV19();
  insertStaleParent(database, 23, "saga_mixed_upload_lease");
  expireUploadIntents(database, 23);
  database.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, reason)
    VALUES ('progress/saga/23-fresh.pdf', 23, 'saga-student', 1, 'upload_intent')`).run();

  assert.equal(database.prepare(claimQueuedStaleProgressSql).get(23), undefined);
  assert.equal(
    database.prepare(claimStaleResubmissionUploadSql)
      .get("cleanup_claimed:forbidden-post", "progress/saga/23.pdf"),
    undefined,
  );
  assert.equal(
    database.prepare(`SELECT reason FROM progress_file_cleanup_queue
      WHERE storage_key = 'progress/saga/23.pdf'`).get().reason,
    "upload_intent",
  );
  database.close();
});

test("cleanup row claim is single-winner and refuses a finalized attachment", async () => {
  const database = await databaseAtV19();
  database.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, reason)
    VALUES ('progress/saga/orphan.pdf', NULL, 'saga-student', 1, 'cleanup_retry')`).run();
  const firstClaim = database.prepare(claimCleanupObjectSql)
    .get("cleanup_claimed:first", "progress/saga/orphan.pdf", "cleanup_retry");
  assert.equal(firstClaim.storage_key, "progress/saga/orphan.pdf");
  assert.equal(
    database.prepare(claimCleanupObjectSql)
      .get("cleanup_claimed:second", "progress/saga/orphan.pdf", "cleanup_retry"),
    undefined,
  );
  assert.equal(
    database.prepare(claimCleanupObjectSql)
      .get("cleanup_claimed:stolen", "progress/saga/orphan.pdf", "cleanup_claimed:first"),
    undefined,
  );
  database.prepare(`UPDATE progress_file_cleanup_queue SET updated_at = datetime('now', '-31 minutes')
    WHERE storage_key = 'progress/saga/orphan.pdf'`).run();
  assert.equal(
    database.prepare(claimCleanupObjectSql)
      .get("cleanup_claimed:recovered", "progress/saga/orphan.pdf", "cleanup_claimed:first").storage_key,
    "progress/saga/orphan.pdf",
  );

  insertStaleParent(database, 21, "saga_finalized_guard");
  database.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
    VALUES (21, 1, '{}', 1)`).run();
  database.prepare(`INSERT INTO progress_attachments
    (progress_entry_id, storage_key, file_name, size_bytes, content_sha256, uploaded_by_user_id)
    VALUES (21, 'progress/saga/21.pdf', 'final.pdf', 10, 'sha', 1)`).run();
  assert.equal(
    database.prepare(claimCleanupObjectSql)
      .get("cleanup_claimed:forbidden", "progress/saga/21.pdf", "upload_intent"),
    undefined,
  );
  assert.equal(database.prepare(discardFinalizedCleanupSql).run("progress/saga/21.pdf").changes, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM progress_attachments
    WHERE storage_key = 'progress/saga/21.pdf'`).get().count, 1);
  database.close();
});

test("cleanup worker skips fresh upload leases and fresh object claims", async () => {
  const database = await databaseAtV19();
  database.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, reason)
    VALUES ('progress/saga/fresh-upload.pdf', NULL, 'saga-student', 1, 'upload_intent'),
           ('progress/saga/fresh-claim.pdf', NULL, 'saga-student', 1, 'cleanup_claimed:active'),
           ('progress/saga/retry.pdf', NULL, 'saga-student', 1, 'cleanup_retry')`).run();
  const candidates = () => database.prepare(queuedProgressCleanupCandidatesSql).all(10)
    .map((row) => row.storage_key);
  assert.deepEqual(candidates(), ["progress/saga/retry.pdf"]);
  database.prepare(`UPDATE progress_file_cleanup_queue SET updated_at = datetime('now', '-31 minutes')
    WHERE storage_key IN ('progress/saga/fresh-upload.pdf', 'progress/saga/fresh-claim.pdf')`).run();
  assert.deepEqual(candidates(), [
    "progress/saga/fresh-claim.pdf",
    "progress/saga/fresh-upload.pdf",
    "progress/saga/retry.pdf",
  ]);
  database.close();
});

function insertResubmissionParent(database, id) {
  database.prepare(`INSERT INTO progress_entries
    (id, student_id, kind, title, summary, evidence, review_status, submitted_by_user_id)
    VALUES (?, 'saga-student', '项目', 'V1', 'V1', 'V1', 'changes_requested', 1)`).run(id);
  database.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id, review_status)
    VALUES (?, 1, '{}', 1, 'changes_requested')`).run(id);
}

function insertUploadIntents(database, progressId, storageKeys) {
  const insert = database.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, reason)
    VALUES (?, ?, 'saga-student', 2, 'upload_intent')`);
  for (const storageKey of storageKeys) insert.run(storageKey, progressId);
}

function claimUploadIntents(database, progressId, storageKeys, token) {
  return database.prepare(claimProgressUploadIntentsSql(storageKeys.length)).all(
    token,
    progressId,
    2,
    ...storageKeys,
    progressId,
    2,
    ...storageKeys,
    storageKeys.length,
  );
}

function finalizeResubmission(database, progressId, storageKeys, token) {
  const result = database.prepare(`UPDATE progress_entries SET
      current_revision = 2, review_status = 'submitted'
    WHERE id = ? AND current_revision = 1 AND review_status = 'changes_requested'
      ${progressUploadIntentGuardSql(storageKeys.length)}`).run(
    progressId,
    2,
    ...storageKeys,
    storageKeys.length,
  );
  database.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
    SELECT ?, 2, ?, 1 WHERE changes() > 0`).run(
    progressId,
    JSON.stringify({ _operationToken: token }),
  );
  if (result.changes) {
    const deleteIntent = database.prepare("DELETE FROM progress_file_cleanup_queue WHERE storage_key = ?");
    for (const storageKey of storageKeys) deleteIntent.run(storageKey);
  }
  return result.changes;
}

test("multi-file resubmission finalization and abort claim are mutually exclusive", async () => {
  const database = await databaseAtV19();
  const winnerKeys = ["progress/saga/40-a.pdf", "progress/saga/40-b.pdf"];
  insertResubmissionParent(database, 40);
  insertUploadIntents(database, 40, winnerKeys);
  assert.equal(finalizeResubmission(database, 40, winnerKeys, "finalizer-wins"), 1);
  assert.deepEqual(claimUploadIntents(database, 40, winnerKeys, "cleanup_claimed:late-abort"), []);
  assert.equal(database.prepare("SELECT current_revision FROM progress_entries WHERE id = 40").get().current_revision, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_revisions WHERE progress_entry_id = 40 AND revision_number = 2").get().count, 1);

  const abortKeys = ["progress/saga/41-a.pdf", "progress/saga/41-b.pdf"];
  insertResubmissionParent(database, 41);
  insertUploadIntents(database, 41, abortKeys);
  assert.equal(claimUploadIntents(database, 41, abortKeys, "cleanup_claimed:abort-wins").length, 2);
  assert.equal(finalizeResubmission(database, 41, abortKeys, "late-finalizer"), 0);
  assert.equal(database.prepare("SELECT current_revision FROM progress_entries WHERE id = 41").get().current_revision, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_revisions WHERE progress_entry_id = 41 AND revision_number = 2").get().count, 0);

  insertResubmissionParent(database, 42);
  insertUploadIntents(database, 42, ["progress/saga/42-a.pdf"]);
  assert.deepEqual(
    claimUploadIntents(
      database,
      42,
      ["progress/saga/42-a.pdf", "progress/saga/42-missing.pdf"],
      "cleanup_claimed:partial-forbidden",
    ),
    [],
  );
  assert.equal(database.prepare(`SELECT reason FROM progress_file_cleanup_queue
    WHERE storage_key = 'progress/saga/42-a.pdf'`).get().reason, "upload_intent");
  database.close();
});

test("stale PATCH intent claim blocks its late finalizer without deleting the completed parent", async () => {
  const database = await databaseAtV19();
  const storageKey = "progress/saga/43-abandoned.pdf";
  insertResubmissionParent(database, 43);
  insertUploadIntents(database, 43, [storageKey]);
  database.prepare(`UPDATE progress_file_cleanup_queue SET updated_at = datetime('now', '-31 minutes')
    WHERE storage_key = ?`).run(storageKey);

  assert.equal(database.prepare(claimQueuedStaleProgressSql).get(43), undefined);
  assert.equal(
    database.prepare(claimStaleResubmissionUploadSql)
      .get("cleanup_claimed:patch-reaper", storageKey).storage_key,
    storageKey,
  );
  assert.equal(finalizeResubmission(database, 43, [storageKey], "late-patch-finalizer"), 0);
  assert.equal(database.prepare("SELECT current_revision FROM progress_entries WHERE id = 43").get().current_revision, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_entries WHERE id = 43").get().count, 1);
  database.close();
});

test("a losing resubmission token cannot revive candidate, attachment, or audit writes", async () => {
  const database = await databaseAtV19();
  database.prepare(`INSERT INTO progress_entries
    (id, student_id, kind, title, summary, evidence, review_status, submitted_by_user_id)
    VALUES (30, 'saga-student', '论文', 'A', 'A', 'A', 'submitted', 1)`).run();
  database.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
    VALUES (30, 2, '{"_operationToken":"winner-A"}', 1)`).run();
  database.prepare("UPDATE progress_entries SET current_revision = 2 WHERE id = 30").run();
  database.prepare(`INSERT INTO paper_submission_candidates
    (progress_entry_id, title, paper_type, planned_submission_date, stage, next_action, next_action_due_date)
    VALUES (30, 'A candidate', '期刊论文', '2026-10-01', 'drafting', 'A next', '2026-09-01')`).run();

  const losingCandidate = database.prepare(`UPDATE paper_submission_candidates SET title = 'B candidate'
    WHERE progress_entry_id = 30 AND EXISTS (
      SELECT 1 FROM progress_revisions operation_revision
      WHERE operation_revision.progress_entry_id = 30 AND operation_revision.revision_number = 2
        AND json_extract(operation_revision.snapshot_json, '$._operationToken') = 'loser-B'
    )`).run();
  const losingAttachment = database.prepare(`INSERT INTO progress_attachments
    (progress_entry_id, storage_key, file_name, size_bytes, content_sha256, revision_number, uploaded_by_user_id)
    SELECT 30, 'progress/saga/loser.pdf', 'loser.pdf', 10, 'sha', 2, 1 WHERE EXISTS (
      SELECT 1 FROM progress_revisions operation_revision
      WHERE operation_revision.progress_entry_id = 30 AND operation_revision.revision_number = 2
        AND json_extract(operation_revision.snapshot_json, '$._operationToken') = 'loser-B'
    )`).run();
  const losingAudit = database.prepare(`INSERT INTO progress_audit_events
    (progress_entry_id, actor_user_id, action)
    SELECT 30, 1, 'resubmit' WHERE EXISTS (
      SELECT 1 FROM progress_revisions operation_revision
      WHERE operation_revision.progress_entry_id = 30 AND operation_revision.revision_number = 2
        AND json_extract(operation_revision.snapshot_json, '$._operationToken') = 'loser-B'
    )`).run();
  assert.deepEqual(
    [losingCandidate.changes, losingAttachment.changes, losingAudit.changes],
    [0, 0, 0],
  );
  assert.equal(database.prepare("SELECT title FROM paper_submission_candidates WHERE progress_entry_id = 30").get().title, "A candidate");
  database.close();
});
