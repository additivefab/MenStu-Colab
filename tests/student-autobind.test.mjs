import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { confirmedRoster, getConfirmedRosterStudent } from "../lib/confirmed-roster.ts";
import { isValidFeishuContact, normalizeFeishuContact } from "../lib/feishu-contact.ts";
import { areStudentIdentityBindingsExact } from "../lib/student-identity-binding.ts";

test("confirmed roster is unique and is addressed only by stable student ID", () => {
  assert.equal(confirmedRoster.length, 26);
  assert.equal(new Set(confirmedRoster.map((student) => student.id)).size, 26);
  assert.equal(new Set(confirmedRoster.map((student) => student.name)).size, 26);
  assert.equal(getConfirmedRosterStudent("student-010")?.name, "邵华阳");
  assert.equal(getConfirmedRosterStudent("邵华阳"), null);
});

test("contact inputs normalize without being persisted and reject malformed values", () => {
  assert.equal(normalizeFeishuContact("email", " Student@Example.COM "), "student@example.com");
  assert.equal(normalizeFeishuContact("mobile", "+86 (138) 0013-8000"), "+8613800138000");
  assert.equal(isValidFeishuContact("email", "student@example.com"), true);
  assert.equal(isValidFeishuContact("mobile", "+8613800138000"), true);
  assert.equal(isValidFeishuContact("email", "not-an-email"), false);
  assert.equal(isValidFeishuContact("mobile", "138abc"), false);
});

test("concurrent binding reconciliation accepts only the exact active identity set", () => {
  const expected = confirmedRoster.map((student, index) => ({
    studentId: student.id,
    openId: `ou_verified_${String(index).padStart(2, "0")}`,
  }));
  const stored = expected.map((binding) => ({
    student_id: binding.studentId,
    feishu_open_id: binding.openId,
    active: 1,
  })).reverse();

  assert.equal(areStudentIdentityBindingsExact(stored, expected), true);
  assert.equal(areStudentIdentityBindingsExact(stored.slice(1), expected), false);
  assert.equal(areStudentIdentityBindingsExact([
    { ...stored[0], active: 0 },
    ...stored.slice(1),
  ], expected), false);
  assert.equal(areStudentIdentityBindingsExact([
    { ...stored[0], feishu_open_id: "ou_different" },
    ...stored.slice(1),
  ], expected), false);
  assert.equal(areStudentIdentityBindingsExact(stored, [
    { ...expected[0], openId: expected[1].openId },
    ...expected.slice(1),
  ]), false);
});

test("verified Open ID binding is pending-only, exact, occupied-safe and audited once", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE students (id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE app_users (
      id INTEGER PRIMARY KEY,
      feishu_open_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'pending',
      student_id TEXT REFERENCES students(id),
      last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_app_users_student_id_unique ON app_users(student_id);
    CREATE TABLE student_feishu_identity_bindings (
      student_id TEXT PRIMARY KEY REFERENCES students(id),
      feishu_open_id TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE app_user_role_events (
      id INTEGER PRIMARY KEY,
      target_user_id INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    INSERT INTO students (id) VALUES ('student-010');
    INSERT INTO student_feishu_identity_bindings (student_id, feishu_open_id)
      VALUES ('student-010', 'ou_verified_010');
    INSERT INTO app_users (id, feishu_open_id, display_name, role) VALUES
      (1, 'ou_verified_010', '任意显示名', 'pending'),
      (2, 'ou_different', '邵华阳', 'pending'),
      (3, 'ou_admin', '管理员', 'mentor');
  `);

  const update = database.prepare(`UPDATE OR IGNORE app_users
    SET role = 'student', student_id = ?
    WHERE id = ? AND role = 'pending' AND student_id IS NULL
      AND EXISTS (SELECT 1 FROM students WHERE id = ? AND active = 1)
      AND EXISTS (
        SELECT 1 FROM student_feishu_identity_bindings
        WHERE student_id = ? AND feishu_open_id = ? AND active = 1
      )
      AND NOT EXISTS (SELECT 1 FROM app_users WHERE student_id = ? AND id <> ?)`);
  const audit = database.prepare(`INSERT INTO app_user_role_events
    (target_user_id, actor_user_id, request_id, from_role, to_role, detail)
    SELECT ?, ?, ?, 'pending', 'student', 'Open ID 预绑定' WHERE changes() > 0`);

  update.run("student-010", 1, "student-010", "student-010", "ou_verified_010", "student-010", 1);
  audit.run(1, 1, "bind-1");
  update.run("student-010", 1, "student-010", "student-010", "ou_verified_010", "student-010", 1);
  audit.run(1, 1, "bind-1-retry");
  assert.deepEqual(
    { ...database.prepare("SELECT role, student_id FROM app_users WHERE id = 1").get() },
    { role: "student", student_id: "student-010" },
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_user_role_events").get().count, 1);

  update.run("student-010", 2, "student-010", "student-010", "ou_different", "student-010", 2);
  audit.run(2, 2, "bind-2");
  assert.equal(database.prepare("SELECT role FROM app_users WHERE id = 2").get().role, "pending");

  update.run("student-010", 3, "student-010", "student-010", "ou_admin", "student-010", 3);
  audit.run(3, 3, "bind-3");
  assert.equal(database.prepare("SELECT role FROM app_users WHERE id = 3").get().role, "mentor");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_user_role_events").get().count, 1);
  database.close();
});

test("concurrent first-login upsert preserves an established role and student binding", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feishu_open_id TEXT NOT NULL UNIQUE,
      feishu_union_id TEXT NOT NULL DEFAULT '',
      feishu_user_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'pending',
      student_id TEXT,
      last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO app_users (feishu_open_id, display_name, role, student_id)
      VALUES ('ou_same', '首次资料', 'student', 'student-010');
  `);
  const upsert = database.prepare(`INSERT INTO app_users
    (feishu_open_id, feishu_union_id, feishu_user_id, display_name, avatar_url, email, role)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(feishu_open_id) DO UPDATE SET
      feishu_union_id = excluded.feishu_union_id,
      feishu_user_id = excluded.feishu_user_id,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      email = excluded.email,
      last_login_at = CURRENT_TIMESTAMP`);
  upsert.run("ou_same", "union", "user", "更新资料", "avatar", "mail@example.com");
  assert.deepEqual(
    { ...database.prepare("SELECT role, student_id, display_name FROM app_users WHERE feishu_open_id = 'ou_same'").get() },
    { role: "student", student_id: "student-010", display_name: "更新资料" },
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_users").get().count, 1);
  database.close();
});

test("source enforces superadmin-only all-or-nothing prebinding without contact persistence", async () => {
  const [authSource, routeSource, schemaSource, migrationSource] = await Promise.all([
    readFile(new URL("../lib/feishu-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/student-access/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0011_awesome_jane_foster.sql", import.meta.url), "utf8"),
  ]);
  assert.match(authSource, /student_feishu_identity_bindings/);
  assert.match(authSource, /ON CONFLICT\(feishu_open_id\) DO UPDATE/);
  assert.doesNotMatch(authSource, /findConfirmedRosterStudent/);
  assert.match(routeSource, /requireAppUser\(request, \["superadmin"\]\)/);
  assert.match(routeSource, /prepared\.length !== confirmedRoster\.length/);
  assert.match(routeSource, /new Set\(prepared\.map\(\(item\) => item\.openId\)\)\.size/);
  assert.match(routeSource, /await d1\.batch\(statements\)/);
  assert.match(routeSource, /catch \{[\s\S]*readStoredBindings\(d1\)[\s\S]*areStudentIdentityBindingsExact\(reconciled\.results, prepared\)/);
  assert.match(routeSource, /本次未覆盖现有绑定[\s\S]*status: 409/);
  assert.doesNotMatch(routeSource, /error instanceof Error \? error\.message/);
  assert.doesNotMatch(routeSource + schemaSource + migrationSource, /contact_digest|contact_value/);
  assert.match(migrationSource, /record_count" = 26/);
  assert.match(migrationSource, /contact_kind" IN \('email', 'mobile', 'existing_login'\)/);
});
