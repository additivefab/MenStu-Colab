import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function databaseAtV19() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
  for (const name of names) database.exec(await readFile(new URL(name, directory), "utf8"));
  database.exec(`
    INSERT INTO students
      (id, display_name, degree, grade_year, stage, cadence_days, current_focus, active)
      VALUES ('student-pro', '工作流测试', '博士', 2025, '实验', 14, '验证权威边界', 1);
    INSERT INTO app_users (id, feishu_open_id, display_name, role, student_id)
      VALUES (1, 'open-student-pro', '工作流学生', 'student', 'student-pro'),
        (2, 'open-mentor-pro', '工作流导师', 'mentor', NULL);
  `);
  return database;
}

function inTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

test("a new-paper submission stays a candidate until one accepted review promotes it", async () => {
  const database = await databaseAtV19();
  database.exec(`
    INSERT INTO progress_entries
      (id, student_id, kind, title, summary, evidence, review_status,
       submitted_by_user_id, idempotency_key, request_hash)
      VALUES (1, 'student-pro', '论文', '候选论文进展', '完成初稿', '稿件附件',
        'submitted', 1, 'candidate_submit_key', 'hash-candidate');
    INSERT INTO progress_revisions
      (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
      VALUES (1, 1, '{"kind":"论文"}', 1);
    INSERT INTO paper_submission_candidates
      (progress_entry_id, title, paper_type, target_venue, planned_submission_date,
       stage, manuscript_version, next_action, next_action_due_date, blocker)
      VALUES (1, '候选论文', '期刊论文', 'Test Journal', '2026-12-01',
        'drafting', 'v0.2', '完成讨论', '2026-09-01', '');
  `);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM student_papers").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM paper_progress_details").get().count, 0);

  const promote = () => inTransaction(database, () => {
    const reviewed = database.prepare(`UPDATE progress_entries SET
      review_status = 'accepted', assessment = 'supporting', reviewed_by_user_id = 2
      WHERE id = 1 AND review_status = 'submitted' AND current_revision = 1`).run();
    const inserted = database.prepare(`INSERT INTO student_papers
      (student_id, title, paper_type, target_venue, planned_submission_date,
       current_stage, submission_identifier, status, latest_progress_at,
       created_by_user_id, updated_at)
      SELECT p.student_id, candidate.title, candidate.paper_type, candidate.target_venue,
        candidate.planned_submission_date, candidate.stage, candidate.submission_identifier,
        'active', p.submitted_at, p.submitted_by_user_id, CURRENT_TIMESTAMP
      FROM paper_submission_candidates candidate
      JOIN progress_entries p ON p.id = candidate.progress_entry_id
      WHERE candidate.progress_entry_id = 1 AND candidate.promoted_paper_id IS NULL
        AND p.current_revision = 1 AND p.review_status = 'accepted'
        AND p.reviewed_by_user_id = 2`).run();
    const linked = database.prepare(`UPDATE paper_submission_candidates SET
      promoted_paper_id = last_insert_rowid(), updated_at = CURRENT_TIMESTAMP
      WHERE progress_entry_id = 1 AND promoted_paper_id IS NULL AND changes() > 0`).run();
    const detailed = database.prepare(`INSERT INTO paper_progress_details
      (progress_entry_id, paper_id, stage, manuscript_version, next_action,
       next_action_due_date, blocker)
      SELECT progress_entry_id, promoted_paper_id, stage, manuscript_version,
        next_action, next_action_due_date, blocker
      FROM paper_submission_candidates
      WHERE progress_entry_id = 1 AND promoted_paper_id IS NOT NULL AND changes() > 0`).run();
    return { reviewed: reviewed.changes, inserted: inserted.changes, linked: linked.changes, detailed: detailed.changes };
  });
  assert.deepEqual(promote(), { reviewed: 1, inserted: 1, linked: 1, detailed: 1 });
  assert.deepEqual(promote(), { reviewed: 0, inserted: 0, linked: 0, detailed: 0 });
  assert.deepEqual(
    { ...database.prepare(`SELECT p.title, p.status, detail.progress_entry_id
      FROM student_papers p JOIN paper_progress_details detail ON detail.paper_id = p.id`).get() },
    { title: "候选论文", status: "active", progress_entry_id: 1 },
  );
  assert.equal(database.prepare("SELECT promoted_paper_id FROM paper_submission_candidates WHERE progress_entry_id = 1").get().promoted_paper_id, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("guidance CAS creates one event and rejects a stale second-tab update", async () => {
  const database = await databaseAtV19();
  database.exec(`INSERT INTO student_guidance_notes
    (id, student_id, mentor_user_id, guidance_type, title, content, next_action, verification_mode)
    VALUES (1, 'student-pro', 2, 'general', '补实验', '补充低温组', '运行低温组', 'mentor_verify')`);
  const submitFromTab = (note) => inTransaction(database, () => {
    const updated = database.prepare(`UPDATE student_guidance_notes SET
      acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
      student_reported_at = CURRENT_TIMESTAMP, completion_note = ?,
      updated_at = CURRENT_TIMESTAMP, version = version + 1
      WHERE id = 1 AND status = 'open' AND version = 1`).run(note);
    database.prepare(`INSERT INTO student_guidance_events
      (guidance_note_id, actor_user_id, actor_type, action, note)
      SELECT 1, 1, 'student', 'completed', ? WHERE changes() > 0`).run(note);
    return updated.changes;
  });
  assert.equal(submitFromTab("第一标签页完成说明"), 1);
  assert.equal(submitFromTab("第二标签页覆盖尝试"), 0);
  assert.equal(database.prepare("SELECT version FROM student_guidance_notes WHERE id = 1").get().version, 2);
  assert.deepEqual(
    database.prepare("SELECT note FROM student_guidance_events ORDER BY id").all().map((event) => event.note),
    ["第一标签页完成说明"],
  );
  database.close();
});

test("atomic meeting insert rejects overlap but accepts a back-to-back slot", async () => {
  const database = await databaseAtV19();
  const insert = database.prepare(`INSERT INTO meeting_requests
    (student_id, requested_by_user_id, preferred_date, preferred_time,
     duration_minutes, topic, status, version, idempotency_key, request_hash)
    SELECT 'student-pro', 1, ?, ?, ?, ?, 'requested', 1, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM meeting_requests existing
      WHERE existing.student_id = 'student-pro' AND existing.status IN ('requested', 'confirmed')
        AND datetime(existing.preferred_date || 'T' || existing.preferred_time || ':00+08:00')
          < datetime(? || 'T' || ? || ':00+08:00', '+' || ? || ' minutes')
        AND datetime(? || 'T' || ? || ':00+08:00')
          < datetime(existing.preferred_date || 'T' || existing.preferred_time || ':00+08:00',
            '+' || existing.duration_minutes || ' minutes')
    )`);
  const run = (time, duration, key) => insert.run(
    "2026-09-01", time, duration, key, key, "hash", "2026-09-01", time, duration, "2026-09-01", time,
  ).changes;
  assert.equal(run("10:00", 30, "meeting_key_1000"), 1);
  assert.equal(run("10:00", 30, "meeting_key_1000"), 0);
  assert.deepEqual(
    { ...database.prepare(`SELECT idempotency_key, request_hash FROM meeting_requests
      WHERE requested_by_user_id = 1 AND idempotency_key = 'meeting_key_1000'`).get() },
    { idempotency_key: "meeting_key_1000", request_hash: "hash" },
  );
  assert.equal(run("10:15", 30, "meeting_key_1015"), 0);
  assert.equal(run("10:30", 30, "meeting_key_1030"), 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM meeting_requests").get().count, 2);
  database.close();
});

test("an upload intent is recoverable after a hard stop and is not retried while fresh", async () => {
  const database = await databaseAtV19();
  database.exec(`INSERT INTO progress_entries
    (id, student_id, kind, title, summary, evidence, review_status, submitted_by_user_id)
    VALUES (7, 'student-pro', '项目', '上传中的进展', '等待对象写入', '附件', 'submitted', 1)`);
  database.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, reason, attempts, last_error)
    VALUES (?, 7, 'student-pro', 1, 'upload_intent', 0, '')`).run("progress/student-pro/7/object.pdf");
  const dashboardVisible = () => database.prepare(`SELECT COUNT(*) AS count FROM progress_entries p
    WHERE p.id = 7 AND EXISTS (SELECT 1 FROM progress_revisions current_revision
      WHERE current_revision.progress_entry_id = p.id
        AND current_revision.revision_number = p.current_revision)`).get().count;
  assert.equal(dashboardVisible(), 0);
  const actionable = () => database.prepare(`SELECT COUNT(*) AS count FROM progress_file_cleanup_queue
    WHERE reason != 'upload_intent' OR updated_at <= datetime('now', '-30 minutes')`).get().count;
  assert.equal(actionable(), 0);
  database.exec(`UPDATE progress_file_cleanup_queue
    SET updated_at = datetime('now', '-31 minutes') WHERE storage_key = 'progress/student-pro/7/object.pdf'`);
  assert.equal(actionable(), 1);
  database.exec(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
    VALUES (7, 1, '{}', 1)`);
  assert.equal(dashboardVisible(), 1);
  database.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, reason, attempts, last_error)
    VALUES (?, 7, 'student-pro', 1, 'hard_stop_recovery', 1, 'delete failed')
    ON CONFLICT(storage_key) DO UPDATE SET reason = excluded.reason,
      attempts = attempts + 1, last_error = excluded.last_error`).run("progress/student-pro/7/object.pdf");
  assert.deepEqual(
    { ...database.prepare("SELECT reason, attempts FROM progress_file_cleanup_queue").get() },
    { reason: "hard_stop_recovery", attempts: 1 },
  );
  database.exec("DELETE FROM progress_file_cleanup_queue; DELETE FROM progress_revisions WHERE progress_entry_id = 7; DELETE FROM progress_entries WHERE id = 7;");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_file_cleanup_queue").get().count, 0);
  database.close();
});

test("ambiguous D1 commits preserve committed R2 objects and only compensate rolled-back writes", async () => {
  const database = await databaseAtV19();
  const objects = new Set();
  const postKey = "progress/student-pro/20/post.pdf";
  objects.add(postKey);
  database.exec(`
    INSERT INTO progress_entries
      (id, student_id, kind, title, summary, evidence, review_status,
       submitted_by_user_id, idempotency_key, request_hash)
      VALUES (20, 'student-pro', '项目', '模糊提交', 'D1 已提交但响应丢失', '附件',
        'submitted', 1, 'ambiguous_post_key', 'ambiguous-post-hash');
    INSERT INTO progress_file_cleanup_queue
      (storage_key, progress_entry_id, student_id, revision_number, reason)
      VALUES ('${postKey}', 20, 'student-pro', 1, 'upload_intent');
  `);
  assert.throws(() => {
    inTransaction(database, () => database.exec(`
      INSERT INTO progress_revisions
        (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
        VALUES (20, 1, '{}', 1);
      INSERT INTO progress_attachments
        (progress_entry_id, storage_key, file_name, content_type, size_bytes,
         content_sha256, revision_number, uploaded_by_user_id)
        VALUES (20, '${postKey}', 'post.pdf', 'application/pdf', 10, 'post-sha', 1, 1);
      DELETE FROM progress_file_cleanup_queue WHERE storage_key = '${postKey}';
    `));
    throw new Error("injected response loss after commit");
  }, /injected response loss/u);
  const committedPost = database.prepare(`SELECT p.id FROM progress_entries p
    WHERE p.submitted_by_user_id = 1 AND p.idempotency_key = 'ambiguous_post_key'
      AND p.request_hash = 'ambiguous-post-hash'
      AND EXISTS (SELECT 1 FROM progress_revisions r
        WHERE r.progress_entry_id = p.id AND r.revision_number = p.current_revision)`).get();
  if (!committedPost) objects.delete(postKey);
  assert.ok(committedPost);
  assert.equal(objects.has(postKey), true);

  const patchKey = "progress/student-pro/21/patch.pdf";
  const operationToken = "operation-token-patch-21";
  objects.add(patchKey);
  database.exec(`
    INSERT INTO progress_entries
      (id, student_id, kind, title, summary, evidence, review_status,
       submitted_by_user_id, current_revision)
      VALUES (21, 'student-pro', '项目', '补证提交', '旧说明', '旧证据',
        'changes_requested', 1, 1);
    INSERT INTO progress_revisions
      (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id, review_status)
      VALUES (21, 1, '{}', 1, 'changes_requested');
    INSERT INTO progress_file_cleanup_queue
      (storage_key, progress_entry_id, student_id, revision_number, reason)
      VALUES ('${patchKey}', 21, 'student-pro', 2, 'upload_intent');
  `);
  assert.throws(() => {
    inTransaction(database, () => {
      database.prepare(`UPDATE progress_entries SET current_revision = 2, review_status = 'submitted'
        WHERE id = 21 AND current_revision = 1 AND review_status = 'changes_requested'`).run();
      database.prepare(`INSERT INTO progress_revisions
        (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
        VALUES (21, 2, ?, 1)`).run(JSON.stringify({ _operationToken: operationToken }));
      database.prepare(`INSERT INTO progress_attachments
        (progress_entry_id, storage_key, file_name, content_type, size_bytes,
         content_sha256, revision_number, uploaded_by_user_id)
        VALUES (21, ?, 'patch.pdf', 'application/pdf', 10, 'patch-sha', 2, 1)`).run(patchKey);
      database.prepare("DELETE FROM progress_file_cleanup_queue WHERE storage_key = ?").run(patchKey);
    });
    throw new Error("injected patch response loss after commit");
  }, /injected patch response loss/u);
  const committedPatch = database.prepare(`SELECT 1 AS committed FROM progress_revisions
    WHERE progress_entry_id = 21 AND revision_number = 2
      AND json_extract(snapshot_json, '$._operationToken') = ?`).get(operationToken);
  if (!committedPatch) objects.delete(patchKey);
  assert.ok(committedPatch);
  assert.equal(objects.has(patchKey), true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_attachments WHERE progress_entry_id = 21 AND revision_number = 2").get().count, 1);

  const rolledBackKey = "progress/student-pro/22/rolled-back.pdf";
  objects.add(rolledBackKey);
  assert.throws(() => inTransaction(database, () => {
    database.prepare(`INSERT INTO progress_revisions
      (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
      VALUES (21, 3, ?, 1)`).run(JSON.stringify({ _operationToken: "rolled-back-token" }));
    throw new Error("injected rollback before commit");
  }), /injected rollback/u);
  const rolledBack = database.prepare(`SELECT 1 AS committed FROM progress_revisions
    WHERE progress_entry_id = 21 AND revision_number = 3
      AND json_extract(snapshot_json, '$._operationToken') = 'rolled-back-token'`).get();
  if (!rolledBack) objects.delete(rolledBackKey);
  assert.equal(rolledBack, undefined);
  assert.equal(objects.has(rolledBackKey), false);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("one mentor cannot confirm overlapping meetings for different students", async () => {
  const database = await databaseAtV19();
  database.exec(`
    INSERT INTO students
      (id, display_name, degree, grade_year, stage, cadence_days, current_focus, active)
      VALUES ('student-other', '另一学生', '硕士', 2025, '实验', 14, '并发预约', 1);
    INSERT INTO app_users (id, feishu_open_id, display_name, role, student_id)
      VALUES (3, 'open-student-other', '另一学生账号', 'student', 'student-other');
    INSERT INTO meeting_requests
      (id, student_id, requested_by_user_id, preferred_date, preferred_time,
       duration_minutes, topic, status, handled_by_user_id, version)
      VALUES
      (10, 'student-pro', 1, '2026-09-01', '10:00', 30, '已确认会议', 'confirmed', 2, 2),
      (11, 'student-other', 3, '2026-09-01', '10:15', 30, '重叠候选', 'requested', NULL, 1),
      (12, 'student-other', 3, '2026-09-01', '10:30', 30, '相邻候选', 'requested', NULL, 1);
  `);
  const confirm = database.prepare(`UPDATE meeting_requests SET status = 'confirmed',
    handled_by_user_id = 2, version = version + 1
    WHERE id = ? AND status = 'requested' AND NOT EXISTS (
      SELECT 1 FROM meeting_requests mentor_existing
      WHERE mentor_existing.handled_by_user_id = 2 AND mentor_existing.status = 'confirmed'
        AND mentor_existing.id != meeting_requests.id
        AND datetime(mentor_existing.preferred_date || 'T' || mentor_existing.preferred_time || ':00+08:00')
          < datetime(meeting_requests.preferred_date || 'T' || meeting_requests.preferred_time || ':00+08:00',
            '+' || meeting_requests.duration_minutes || ' minutes')
        AND datetime(meeting_requests.preferred_date || 'T' || meeting_requests.preferred_time || ':00+08:00')
          < datetime(mentor_existing.preferred_date || 'T' || mentor_existing.preferred_time || ':00+08:00',
            '+' || mentor_existing.duration_minutes || ' minutes')
    )`);
  assert.equal(confirm.run(11).changes, 0);
  assert.equal(confirm.run(12).changes, 1);
  assert.deepEqual(
    database.prepare("SELECT id, status FROM meeting_requests WHERE id IN (11, 12) ORDER BY id").all().map((row) => ({ ...row })),
    [{ id: 11, status: "requested" }, { id: 12, status: "confirmed" }],
  );
  database.close();
});
