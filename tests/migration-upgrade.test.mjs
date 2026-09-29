import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("0010-0021 preserve existing data while adding identity, evidence, concurrency, and recovery gates", async () => {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");

  for (const name of names.filter((item) => !["0006_", "0007_", "0008_", "0009_", "0010_", "0011_", "0012_", "0013_", "0014_", "0015_", "0016_", "0017_", "0018_", "0019_", "0020_", "0021_", "0022_", "0023_", "0024_"].some((prefix) => item.startsWith(prefix)))) {
    database.exec(await readFile(new URL(name, migrationDirectory), "utf8"));
  }
  database.exec(`
    INSERT INTO students (id, display_name, degree, grade_year, stage, cadence_days, current_focus, active)
      VALUES ('student-upgrade', '迁移测试', '博士', 2024, '实验', 14, '验证升级', 1);
    INSERT INTO progress_entries (student_id, kind, title, summary, evidence, status)
      VALUES ('student-upgrade', '实验', '历史实质性进展', '历史结论', '历史证据', 'substantive');
    INSERT INTO feishu_meeting_summary_imports
      (event_id, message_id, chat_id, raw_content, extracted_text, message_created_at, status)
      VALUES ('event-upgrade', 'message-upgrade', '', '', '飞书智能纪要 AI 文档：历史科研段落',
        '2026-08-21T12:00:00.000Z', 'confirmed');
    INSERT INTO feishu_meeting_summary_links (import_id, student_id, progress_entry_id)
      VALUES (1, 'student-upgrade', 1);
  `);

  const businessMigration = await readFile(new URL(names.find((item) => item.startsWith("0006_")), migrationDirectory), "utf8");
  const roleMigration = await readFile(new URL(names.find((item) => item.startsWith("0007_")), migrationDirectory), "utf8");
  const roleIndexMigration = await readFile(new URL(names.find((item) => item.startsWith("0008_")), migrationDirectory), "utf8");
  const meetingMigration = await readFile(new URL(names.find((item) => item.startsWith("0009_")), migrationDirectory), "utf8");
  const roleMergeMigration = await readFile(new URL(names.find((item) => item.startsWith("0010_")), migrationDirectory), "utf8");
  const identityBindingMigration = await readFile(new URL(names.find((item) => item.startsWith("0011_")), migrationDirectory), "utf8");
  const attachmentMigration = await readFile(new URL(names.find((item) => item.startsWith("0012_")), migrationDirectory), "utf8");
  const paperMigration = await readFile(new URL(names.find((item) => item.startsWith("0013_")), migrationDirectory), "utf8");
  const guidanceMigration = await readFile(new URL(names.find((item) => item.startsWith("0014_")), migrationDirectory), "utf8");
  const freeGuidanceMigration = await readFile(new URL(names.find((item) => item.startsWith("0015_")), migrationDirectory), "utf8");
  const productionMigration = await readFile(new URL(names.find((item) => item.startsWith("0016_")), migrationDirectory), "utf8");
  const revisionMigration = await readFile(new URL(names.find((item) => item.startsWith("0017_")), migrationDirectory), "utf8");
  const mentorOperationsMigration = await readFile(new URL(names.find((item) => item.startsWith("0018_")), migrationDirectory), "utf8");
  const studentProMigration = await readFile(new URL(names.find((item) => item.startsWith("0019_")), migrationDirectory), "utf8");
  database.exec(businessMigration);
  database.exec(roleMigration);
  database.exec(roleIndexMigration);
  database.exec(meetingMigration);
  const progress = database.prepare(`SELECT status, review_status, assessment, updated_at
    FROM progress_entries WHERE student_id = ?`).get("student-upgrade");
  assert.equal(progress.status, "substantive");
  assert.equal(progress.review_status, "accepted");
  assert.equal(progress.assessment, "substantive");
  assert.ok(progress.updated_at);

  const source = database.prepare(`SELECT source_type, label, source_ref, source_import_id
    FROM progress_evidence_sources WHERE progress_entry_id = 1`).get();
  assert.equal(source.source_type, "feishu_docx");
  assert.equal(source.label, "飞书智能纪要文档导入");
  assert.equal(source.source_ref, "");
  assert.equal(source.source_import_id, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_audit_events").get().count, 1);
  database.exec(`
    INSERT INTO app_users (id, feishu_open_id, display_name, role)
      VALUES (9001, 'open-admin', '现有管理员', 'admin'),
        (9002, 'open-superadmin', '超级管理员', 'superadmin'),
        (9003, 'open-mentor', '旧导师账号', 'mentor');
    INSERT INTO mentor_student_assignments
      (mentor_user_id, student_id, relationship, can_review, active)
      VALUES (9003, 'student-upgrade', 'primary', 0, 1);
    INSERT INTO app_user_role_events (target_user_id, actor_user_id, request_id, from_role, to_role, detail)
      VALUES (9002, 9001, 'migration-test', 'pending', 'superadmin', '迁移测试');
  `);
  database.exec(roleMergeMigration);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_user_role_events").get().count, 1);
  assert.equal(database.prepare("SELECT role FROM app_users WHERE id = 9001").get().role, "mentor");
  assert.equal(database.prepare("SELECT role FROM app_users WHERE id = 9003").get().role, "mentor");
  assert.deepEqual(
    { ...database.prepare(`SELECT mentor_user_id, student_id, can_review, active
      FROM mentor_student_assignments WHERE mentor_user_id = 9003`).get() },
    { mentor_user_id: 9003, student_id: "student-upgrade", can_review: 0, active: 1 },
  );
  database.exec(`
    INSERT INTO mentor_student_assignments
      (mentor_user_id, student_id, relationship, can_review, active)
      SELECT 9003, 'student-upgrade', 'primary', 1, 1 WHERE 1 = 1
      ON CONFLICT(mentor_user_id, student_id) DO UPDATE SET active = 1;
  `);
  assert.equal(database.prepare(`SELECT can_review FROM mentor_student_assignments
    WHERE mentor_user_id = 9003 AND student_id = 'student-upgrade'`).get().can_review, 0);
  database.exec(roleMigration);
  database.exec(roleIndexMigration);
  database.exec(meetingMigration);
  database.exec(roleMergeMigration);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'admin'").get().count, 0);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'student_identity_binding_batches',
      'student_feishu_identity_bindings'
    )`).get().count, 0);

  database.exec(identityBindingMigration);
  assert.deepEqual(
    database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'student_identity_binding_batches',
        'student_feishu_identity_bindings'
      ) ORDER BY name`).all().map((row) => row.name),
    ["student_feishu_identity_bindings", "student_identity_binding_batches"],
  );

  const batchColumns = database.prepare("PRAGMA table_info('student_identity_binding_batches')")
    .all().map((column) => column.name);
  assert.deepEqual(batchColumns, [
    "id",
    "actor_user_id",
    "request_id",
    "record_count",
    "detail",
    "created_at",
  ]);
  const bindingColumns = database.prepare("PRAGMA table_info('student_feishu_identity_bindings')")
    .all().map((column) => column.name);
  assert.deepEqual(bindingColumns, [
    "student_id",
    "feishu_open_id",
    "batch_id",
    "verified_by_user_id",
    "verification_method",
    "contact_kind",
    "active",
    "created_at",
  ]);
  const forbiddenContactColumns = /^(?:contact_value|email|mobile|phone|telephone)$/i;
  assert.deepEqual(
    [...batchColumns, ...bindingColumns].filter((column) => forbiddenContactColumns.test(column)),
    [],
  );

  assert.throws(
    () => database.exec(`INSERT INTO student_identity_binding_batches
      (actor_user_id, request_id, record_count, detail)
      VALUES (9002, 'invalid-record-count', 25, 'must be rejected')`),
    /CHECK constraint failed: student_identity_binding_batches_record_count/,
  );
  database.exec(`INSERT INTO student_identity_binding_batches
    (actor_user_id, request_id, record_count, detail)
    VALUES (9002, 'identity-upgrade-test', 26, 'valid batch')`);
  assert.throws(
    () => database.exec(`INSERT INTO student_identity_binding_batches
      (actor_user_id, request_id, record_count, detail)
      VALUES (9002, 'identity-upgrade-test', 26, 'duplicate request')`),
    /UNIQUE constraint failed: student_identity_binding_batches\.request_id/,
  );

  database.exec(`
    INSERT INTO students (id, display_name, degree, grade_year, stage, cadence_days, current_focus, active)
      VALUES ('student-upgrade-2', '迁移测试二号', '博士', 2025, '实验', 14, '验证唯一约束', 1);
    INSERT INTO student_feishu_identity_bindings
      (student_id, feishu_open_id, batch_id, verified_by_user_id, contact_kind)
      VALUES ('student-upgrade', 'open-student-shared', 1, 9002, 'email');
  `);
  assert.throws(
    () => database.exec(`INSERT INTO student_feishu_identity_bindings
      (student_id, feishu_open_id, batch_id, verified_by_user_id, contact_kind)
      VALUES ('student-upgrade-2', 'open-student-shared', 1, 9002, 'mobile')`),
    /UNIQUE constraint failed: student_feishu_identity_bindings\.feishu_open_id/,
  );
  assert.throws(
    () => database.exec(`INSERT INTO student_feishu_identity_bindings
      (student_id, feishu_open_id, batch_id, verified_by_user_id, contact_kind)
      VALUES ('student-upgrade', 'open-student-second', 1, 9002, 'mobile')`),
    /UNIQUE constraint failed: student_feishu_identity_bindings\.student_id/,
  );
  database.exec(attachmentMigration);
  assert.deepEqual(
    database.prepare("PRAGMA table_info('progress_attachments')").all().map((column) => column.name),
    ["id", "progress_entry_id", "storage_key", "file_name", "content_type", "size_bytes", "content_sha256", "uploaded_by_user_id", "created_at"],
  );
  database.exec(`INSERT INTO progress_attachments
    (progress_entry_id, storage_key, file_name, content_type, size_bytes, content_sha256, uploaded_by_user_id)
    VALUES (1, 'progress/test/file.pdf', '论文初稿.pdf', 'application/pdf', 128, 'abc123', 9002)`);
  assert.equal(database.prepare("SELECT file_name FROM progress_attachments WHERE progress_entry_id = 1").get().file_name, "论文初稿.pdf");

  database.exec(paperMigration);
  assert.deepEqual(
    database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('student_papers', 'paper_progress_details')
      ORDER BY name`).all().map((row) => row.name),
    ["paper_progress_details", "student_papers"],
  );
  database.exec(`
    INSERT INTO student_papers
      (student_id, title, paper_type, planned_submission_date, current_stage, created_by_user_id)
      VALUES ('student-upgrade', '迁移后的论文台账', '期刊论文', '2026-12-31', 'drafting', 9002);
    INSERT INTO paper_progress_details
      (progress_entry_id, paper_id, stage, manuscript_version, next_action, next_action_due_date, blocker)
      VALUES (1, 1, 'drafting', 'v0.3', '完成讨论章节', '2026-09-15', '等待补充实验');
  `);
  assert.deepEqual(
    { ...database.prepare(`SELECT p.title, d.stage, d.manuscript_version, d.next_action
      FROM student_papers p JOIN paper_progress_details d ON d.paper_id = p.id`).get() },
    { title: "迁移后的论文台账", stage: "drafting", manuscript_version: "v0.3", next_action: "完成讨论章节" },
  );
  database.exec(guidanceMigration);
  database.exec(freeGuidanceMigration);
  database.exec(`INSERT INTO student_guidance_notes
    (student_id, mentor_user_id, source_progress_entry_id, guidance_type, title, content, next_action, due_date)
    VALUES ('student-upgrade', 9002, 1, 'general', '下一轮实验设计', '优先核对历史实验的可重复性', '补充对照实验', '2026-09-20')`);
  assert.deepEqual(
    { ...database.prepare(`SELECT guidance_type, title, content, next_action, status
      FROM student_guidance_notes WHERE student_id = 'student-upgrade'`).get() },
    { guidance_type: "general", title: "下一轮实验设计", content: "优先核对历史实验的可重复性", next_action: "补充对照实验", status: "open" },
  );
  database.exec("UPDATE app_users SET email = 'must-not-persist@example.com' WHERE id = 9002");
  database.exec(productionMigration);
  assert.deepEqual(
    database.prepare("PRAGMA table_info('student_guidance_notes')").all().map((column) => column.name).slice(-6),
    ["updated_at", "title", "acknowledged_at", "completed_at", "completed_by_user_id", "completion_note"],
  );
  assert.deepEqual(
    database.prepare("PRAGMA table_info('student_guidance_events')").all().map((column) => column.name),
    ["id", "guidance_note_id", "actor_user_id", "actor_type", "action", "note", "created_at"],
  );
  assert.equal(database.prepare("SELECT version FROM app_schema_meta WHERE id = 1").get().version, 16);
  assert.equal(database.prepare("SELECT email FROM app_users WHERE id = 9002").get().email, "");
  assert.throws(
    () => database.exec("INSERT INTO app_schema_meta (id, version) VALUES (2, 16)"),
    /CHECK constraint failed: app_schema_meta_singleton/,
  );

  database.exec(`
    UPDATE progress_entries
      SET submitted_by_user_id = 9002, reviewed_by_user_id = 9003
      WHERE id = 1;
    INSERT INTO progress_entries
      (student_id, kind, title, summary, evidence, status, review_status, assessment,
       submitted_by_user_id, reviewed_by_user_id)
      VALUES ('student-upgrade', '实验', '遗留孤儿账号进展', '旧账号已被删除', '历史证据',
       'supporting', 'accepted', 'supporting', 991001, 991002);
  `);
  database.exec(revisionMigration);
  assert.equal(database.prepare("SELECT version FROM app_schema_meta WHERE id = 1").get().version, 17);
  assert.deepEqual(
    database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('progress_revisions', 'project_progress_details')
      ORDER BY name`).all().map((row) => row.name),
    ["progress_revisions", "project_progress_details"],
  );
  assert.equal(database.prepare("SELECT current_revision FROM progress_entries WHERE id = 1").get().current_revision, 1);
  const historicalRevision = database.prepare(`SELECT revision_number, snapshot_json, review_status, assessment,
    submitted_by_user_id, reviewed_by_user_id
    FROM progress_revisions WHERE progress_entry_id = 1`).get();
  assert.equal(historicalRevision.revision_number, 1);
  assert.equal(historicalRevision.review_status, "accepted");
  assert.equal(historicalRevision.assessment, "substantive");
  assert.equal(historicalRevision.submitted_by_user_id, 9002);
  assert.equal(historicalRevision.reviewed_by_user_id, 9003);
  assert.deepEqual(
    Object.fromEntries(Object.entries(JSON.parse(historicalRevision.snapshot_json)).filter(([key]) => ["kind", "title", "summary", "evidence"].includes(key))),
    {
      kind: "实验",
      title: "历史实质性进展",
      summary: "历史结论",
      evidence: "历史证据",
    },
  );
  assert.equal(
    database.prepare("SELECT revision_number FROM progress_attachments WHERE progress_entry_id = 1").get().revision_number,
    1,
  );
  assert.equal(
    database.prepare("SELECT MIN(revision_number) AS revision_number FROM progress_evidence_sources WHERE progress_entry_id = 1").get().revision_number,
    1,
  );
  assert.deepEqual(
    { ...database.prepare(`SELECT submitted_by_user_id, reviewed_by_user_id
      FROM progress_revisions WHERE progress_entry_id = 2`).get() },
    { submitted_by_user_id: null, reviewed_by_user_id: null },
  );

  database.exec(`
    INSERT INTO research_proposals
      (student_id, title, status, current_version, created_by_user_id)
      VALUES ('student-upgrade', '稳定节点方案', 'approved', 3, 9002);
    INSERT INTO research_milestones
      (proposal_id, title, target_date, evidence_target, status, sort_order)
      VALUES (1, '完成可复现实验', '2026-10-01', '实验日志与代码提交', 'in_progress', 0);
    INSERT INTO progress_entries
      (student_id, kind, title, summary, evidence, status, review_status, submitted_by_user_id, current_revision)
      VALUES ('student-upgrade', '项目', '课题节点进展', '完成第一轮复现', '日志哈希', 'pending', 'submitted', 9002, 1);
    INSERT INTO project_progress_details
      (progress_entry_id, milestone_id, milestone_title, milestone_target_date, evidence_target,
       proposal_version, next_action, next_action_due_date, blocker, completion_requested)
      VALUES (3, 1, '完成可复现实验', '2026-10-01', '实验日志与代码提交',
       3, '运行第二个随机种子', '2026-09-10', '', 1);
    INSERT INTO progress_revisions
      (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
      VALUES (3, 1, '{"kind":"项目","project":{"milestoneId":1}}', 9002);
    UPDATE research_milestones SET archived_at = CURRENT_TIMESTAMP WHERE id = 1;
  `);
  assert.deepEqual(
    { ...database.prepare(`SELECT d.milestone_id, d.milestone_title, d.proposal_version,
      m.archived_at IS NOT NULL AS milestone_archived
      FROM project_progress_details d JOIN research_milestones m ON m.id = d.milestone_id
      WHERE d.progress_entry_id = 3`).get() },
    {
      milestone_id: 1,
      milestone_title: "完成可复现实验",
      proposal_version: 3,
      milestone_archived: 1,
    },
  );
  database.exec(`
    UPDATE progress_entries SET current_revision = 2 WHERE id = 3;
    INSERT INTO progress_revisions
      (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
      VALUES (3, 2, '{"kind":"项目","project":{"milestoneId":1,"completionRequested":true}}', 9002);
    INSERT INTO progress_attachments
      (progress_entry_id, storage_key, file_name, content_type, size_bytes, content_sha256,
       revision_number, uploaded_by_user_id)
      VALUES (3, 'progress/revision-2/log.csv', '复现实验.csv', 'text/csv', 256, 'def456', 2, 9002);
    INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, content_sha256, revision_number, created_by_user_id)
      VALUES (3, 'attachment', '复现实验.csv', 'progress/revision-2/log.csv', 'def456', 2, 9002);
  `);
  assert.deepEqual(
    database.prepare("SELECT revision_number FROM progress_revisions WHERE progress_entry_id = 3 ORDER BY revision_number").all().map((row) => row.revision_number),
    [1, 2],
  );
  assert.equal(
    database.prepare("SELECT revision_number FROM progress_attachments WHERE progress_entry_id = 3").get().revision_number,
    2,
  );
  assert.equal(
    database.prepare("SELECT revision_number FROM progress_evidence_sources WHERE progress_entry_id = 3").get().revision_number,
    2,
  );
  assert.throws(
    () => database.exec(`INSERT INTO progress_revisions
      (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
      VALUES (3, 2, '{}', 9002)`),
    /UNIQUE constraint failed: progress_revisions\.progress_entry_id, progress_revisions\.revision_number/,
  );
  assert.throws(
    () => database.exec(`INSERT INTO project_progress_details
      (progress_entry_id, next_action, next_action_due_date, completion_requested)
      VALUES (1, '非法完成值', '2026-09-11', 2)`),
    /CHECK constraint failed: project_progress_completion_requested/,
  );
  database.exec(`INSERT INTO student_guidance_events
    (guidance_note_id, actor_user_id, actor_type, action, note)
    VALUES (1, 9002, 'staff', 'created', '迁移前已存在的指导事件')`);
  database.exec("BEGIN");
  try {
    database.exec(mentorOperationsMigration);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const guidanceAfterUpgrade = database.prepare(`SELECT title, acceptance_criteria, verification_mode,
    student_reported_at, mentor_verified_at FROM student_guidance_notes WHERE student_id = ?`).get("student-upgrade");
  assert.deepEqual({ ...guidanceAfterUpgrade }, {
    title: "下一轮实验设计",
    acceptance_criteria: "",
    verification_mode: "self_report",
    student_reported_at: null,
    mentor_verified_at: null,
  });
  assert.deepEqual(
    { ...database.prepare(`SELECT guidance_note_id, action, note
      FROM student_guidance_events WHERE guidance_note_id = 1`).get() },
    { guidance_note_id: 1, action: "created", note: "迁移前已存在的指导事件" },
  );
  assert.equal(database.prepare("SELECT version FROM app_schema_meta WHERE id = 1").get().version, 18);
  database.exec(`INSERT INTO student_guidance_notes
    (student_id, mentor_user_id, guidance_type, content)
    VALUES ('student-upgrade', 9002, 'general', '迁移后新增指导')`);
  assert.equal(
    database.prepare("SELECT verification_mode FROM student_guidance_notes WHERE id = 2").get().verification_mode,
    "mentor_verify",
  );
  assert.ok(database.prepare("PRAGMA table_info('progress_entries')").all().some((column) => column.name === "review_claimed_at"));
  assert.deepEqual(
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('meeting_agendas', 'meeting_agenda_items', 'notification_deliveries')
      ORDER BY name`).all().map((row) => row.name),
    ["meeting_agenda_items", "meeting_agendas", "notification_deliveries"],
  );
  assert.ok(database.prepare("PRAGMA table_info('notification_deliveries')").all().some((column) => column.name === "attempt_token"));
  assert.ok(database.prepare("PRAGMA table_info('notification_deliveries')").all().some((column) => column.name === "provider_message_id"));
  database.exec(`
    INSERT INTO meeting_agendas (mentor_user_id, title, meeting_date)
      VALUES (9002, '迁移后组会议程', '2026-09-21');
    INSERT INTO meeting_agenda_items
      (agenda_id, student_id, topic, reason, duration_minutes, sort_order)
      VALUES (1, 'student-upgrade', '确认复现实验节点', '节点受阻，需要导师决策', 15, 0);
    INSERT INTO notification_deliveries
      (student_id, triggered_by_user_id, reason, idempotency_key, status, sent_at)
      VALUES ('student-upgrade', 9002, '进入个人更新周期', 'migration-reminder-1', 'sent', CURRENT_TIMESTAMP);
  `);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM meeting_agenda_items").get().count, 1);
  assert.throws(
    () => database.exec(`INSERT INTO meeting_agenda_items
      (agenda_id, student_id, topic, duration_minutes) VALUES (1, 'student-upgrade', '非法时长', 12)`),
    /CHECK constraint failed: meeting_agenda_items_duration_check/,
  );
  assert.throws(
    () => database.exec(`INSERT INTO notification_deliveries
      (student_id, triggered_by_user_id, reason, idempotency_key, status)
      VALUES ('student-upgrade', 9002, '重复提醒', 'migration-reminder-1', 'sent')`),
    /UNIQUE constraint failed: notification_deliveries\.idempotency_key/,
  );
  database.exec(studentProMigration);
  assert.equal(database.prepare("SELECT version FROM app_schema_meta WHERE id = 1").get().version, 19);
  assert.deepEqual(
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('paper_submission_candidates', 'progress_file_cleanup_queue')
      ORDER BY name`).all().map((row) => row.name),
    ["paper_submission_candidates", "progress_file_cleanup_queue"],
  );
  assert.equal(database.prepare("SELECT version FROM student_guidance_notes WHERE id = 1").get().version, 1);
  assert.throws(
    () => database.exec("UPDATE student_guidance_notes SET version = 0 WHERE id = 1"),
    /CHECK constraint failed/,
  );
  const progressIndex = database.prepare("PRAGMA index_list('progress_entries')").all()
    .find((index) => index.name === "idx_progress_submitter_idempotency");
  const meetingIndex = database.prepare("PRAGMA index_list('meeting_requests')").all()
    .find((index) => index.name === "idx_meeting_requester_idempotency");
  assert.deepEqual({ unique: progressIndex.unique, partial: progressIndex.partial }, { unique: 1, partial: 1 });
  assert.deepEqual({ unique: meetingIndex.unique, partial: meetingIndex.partial }, { unique: 1, partial: 1 });
  database.exec("UPDATE progress_entries SET idempotency_key = 'migration_same_key', request_hash = 'hash-a' WHERE id = 1");
  assert.throws(
    () => database.exec(`INSERT INTO progress_entries
      (student_id, kind, title, summary, evidence, submitted_by_user_id, idempotency_key, request_hash)
      VALUES ('student-upgrade', '项目', '重复请求', '不应写入', '证据', 9002, 'migration_same_key', 'hash-a')`),
    /UNIQUE constraint failed/,
  );
  database.exec(`INSERT INTO progress_entries
    (student_id, kind, title, summary, evidence, submitted_by_user_id, idempotency_key, request_hash)
    VALUES ('student-upgrade', '项目', '不同提交人可复用', '合法', '证据', 9003, 'migration_same_key', 'hash-a')`);
  database.exec(`INSERT INTO progress_entries
    (student_id, kind, title, summary, evidence, submitted_by_user_id)
    VALUES ('student-upgrade', '项目', '清理队列关联', '临时', '证据', 9002)`);
  const cleanupProgressId = database.prepare("SELECT last_insert_rowid() AS id").get().id;
  database.prepare(`INSERT INTO progress_file_cleanup_queue
    (storage_key, progress_entry_id, student_id, revision_number, last_error)
    VALUES (?, ?, 'student-upgrade', 1, 'fault injection')`).run("progress/test/orphan.bin", cleanupProgressId);
  database.prepare("DELETE FROM progress_entries WHERE id = ?").run(cleanupProgressId);
  assert.equal(database.prepare("SELECT progress_entry_id FROM progress_file_cleanup_queue").get().progress_entry_id, null);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.exec(await readFile(new URL(names.find((item) => item.startsWith("0020_")), migrationDirectory), "utf8"));
  assert.equal(database.prepare("SELECT version FROM app_schema_meta WHERE id = 1").get().version, 20);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM progress_deletions").get().count, 0);
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'protect_deleted_progress'").get());
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.exec(await readFile(new URL(names.find((item) => item.startsWith("0021_")), migrationDirectory), "utf8"));
  assert.equal(database.prepare("SELECT version FROM app_schema_meta WHERE id = 1").get().version, 21);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  const originalUsers = database.prepare("SELECT * FROM app_users ORDER BY id").all();
  const originalProgress = database.prepare("SELECT * FROM progress_entries ORDER BY id").all();
  database.exec(await readFile(new URL(names.find((item) => item.startsWith("0022_")), migrationDirectory), "utf8"));
  assert.equal(database.prepare("SELECT version FROM app_schema_meta WHERE id = 1").get().version, 22);
  assert.deepEqual(database.prepare("SELECT * FROM app_users ORDER BY id").all(), originalUsers);
  assert.deepEqual(database.prepare("SELECT * FROM progress_entries ORDER BY id").all(), originalProgress);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
