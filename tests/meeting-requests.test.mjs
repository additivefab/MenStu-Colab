import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const routeUrl = new URL("../app/api/meeting-requests/route.ts", import.meta.url);
const migrationUrl = new URL("../drizzle/0009_high_black_widow.sql", import.meta.url);

test("meeting request route enforces ownership, reviewer scope, transitions, origin, and concurrency", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.equal((source.match(/assertSameOrigin\(request\)/g) ?? []).length, 2);
  assert.match(source, /requireAppUser\(request, \["student"\]\)/);
  assert.match(source, /m\.student_id = \? AND m\.requested_by_user_id = \?/);
  assert.match(source, /assignment\.active = 1 AND assignment\.can_review = 1/);
  assert.match(source, /user\.role === "admin"/);
  assert.doesNotMatch(source, /user\.role === "mentor"/);
  assert.match(source, /action !== "cancel"/);
  assert.match(source, /action !== "confirm" && action !== "decline"/);
  assert.match(source, /existing\.status !== "requested" && existing\.status !== "confirmed"/);
  assert.match(source, /existing\.status !== "requested"/);
  assert.match(source, /拒绝预约时必须填写回复意见/);
  assert.match(source, /预约时间必须晚于当前时间/);
  assert.match(source, /未来 180 天/);
  assert.match(source, /同一时间已有待处理或已确认的预约/);
  assert.match(source, /已有 5 条有效预约/);
  assert.match(source, /new Set\(\[15, 30, 45, 60\]\)/);
  assert.match(source, /expectedVersion/);
  assert.match(source, /version = version \+ 1/);
  assert.match(source, /WHERE id = \? AND version = \? AND status = \?/);
  assert.match(source, /handled_by_user_id = \?/);
});

test("0009 meeting request migration constrains records and supports non-leaking scope queries", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE students (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    );
    CREATE TABLE app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL
    );
    CREATE TABLE mentor_student_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      student_id TEXT NOT NULL REFERENCES students(id),
      can_review INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
  database.exec(await readFile(migrationUrl, "utf8"));
  database.exec(`
    INSERT INTO students (id, display_name)
      VALUES ('student-a', '学生甲'), ('student-b', '学生乙');
    INSERT INTO app_users (id, display_name)
      VALUES (1, '学生甲账号'), (2, '学生乙账号'), (3, '管理员（导师）账号'), (4, '超级管理员账号');
    INSERT INTO mentor_student_assignments
      (mentor_user_id, student_id, can_review, active)
      VALUES (3, 'student-a', 1, 1), (3, 'student-b', 0, 1);
    INSERT INTO meeting_requests
      (student_id, requested_by_user_id, preferred_date, preferred_time,
       duration_minutes, topic, note)
      VALUES
      ('student-a', 1, '2027-09-01', '09:00', 30, '甲的议题', ''),
      ('student-b', 2, '2027-09-02', '10:00', 45, '乙的议题', '仅乙可见');
  `);

  const studentRows = database.prepare(`SELECT id FROM meeting_requests
    WHERE student_id = ? AND requested_by_user_id = ? ORDER BY id`).all("student-a", 1);
  assert.deepEqual(studentRows.map((row) => row.id), [1]);

  const adminRows = database.prepare(`SELECT m.id FROM meeting_requests m
    WHERE EXISTS (
      SELECT 1 FROM mentor_student_assignments assignment
      WHERE assignment.mentor_user_id = ?
        AND assignment.student_id = m.student_id
        AND assignment.active = 1 AND assignment.can_review = 1
    ) ORDER BY m.id`).all(3);
  assert.deepEqual(adminRows.map((row) => row.id), [1]);

  const update = database.prepare(`UPDATE meeting_requests SET
    status = 'confirmed', handled_by_user_id = 4, response_note = '时间可行',
    handled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, version = version + 1
    WHERE id = 1 AND version = 1 AND status = 'requested'`);
  assert.equal(update.run().changes, 1);
  assert.equal(update.run().changes, 0);
  assert.deepEqual(
    { ...database.prepare("SELECT status, version, handled_by_user_id FROM meeting_requests WHERE id = 1").get() },
    { status: "confirmed", version: 2, handled_by_user_id: 4 },
  );

  assert.throws(
    () => database.prepare(`INSERT INTO meeting_requests
      (student_id, requested_by_user_id, preferred_date, preferred_time, duration_minutes, topic)
      VALUES ('student-a', 1, '2027-09-03', '11:00', 20, '非法时长')`).run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => database.prepare(`INSERT INTO meeting_requests
      (student_id, requested_by_user_id, preferred_date, preferred_time, duration_minutes, topic, status)
      VALUES ('student-a', 1, '2027-09-03', '11:00', 30, '非法状态', 'approved')`).run(),
    /CHECK constraint failed/,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
