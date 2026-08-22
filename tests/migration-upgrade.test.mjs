import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("0010 upgrades roles before 0011 adds safe, constrained student identity bindings", async () => {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");

  for (const name of names.filter((item) => !["0006_", "0007_", "0008_", "0009_", "0010_", "0011_"].some((prefix) => item.startsWith(prefix)))) {
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
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
