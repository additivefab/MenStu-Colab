import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canActOnProgressReview,
  canActOnProposalReview,
  canVerifyGuidance,
  filterCurrentAcceptedTracks,
  reviewLeaseExpired,
} from "../lib/dashboard-overview/authority.ts";
import {
  acceptedTrackProgressSql,
  latestSubmittedSql,
  outstandingProgressSql,
  substantiveProgressSql,
} from "../lib/dashboard-overview/query-sql.ts";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE progress_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      status TEXT NOT NULL,
      review_status TEXT NOT NULL,
      assessment TEXT,
      submitted_by_user_id INTEGER,
      reviewed_by_user_id INTEGER,
      review_claimed_at TEXT,
      reviewed_at TEXT,
      current_revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE progress_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      progress_entry_id INTEGER NOT NULL,
      revision_number INTEGER NOT NULL,
      review_status TEXT NOT NULL,
      assessment TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE paper_progress_details (
      progress_entry_id INTEGER PRIMARY KEY,
      next_action TEXT NOT NULL,
      next_action_due_date TEXT NOT NULL,
      blocker TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE project_progress_details (
      progress_entry_id INTEGER PRIMARY KEY,
      next_action TEXT NOT NULL,
      next_action_due_date TEXT NOT NULL,
      blocker TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

function insertAccepted(db, studentId, index) {
  const submittedAt = `2026-07-${String((index % 28) + 1).padStart(2, "0")} 00:00:00`;
  const entry = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, reviewed_at)
    VALUES (?, '实验', ?, ?, 'substantive', 'accepted', 'substantive', ?)
    RETURNING id`).get(studentId, `${studentId}-${index}`, submittedAt, submittedAt);
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'accepted', 'substantive', ?, ?)`)
    .run(entry.id, submittedAt, submittedAt);
  return Number(entry.id);
}

test("database-side substantive summary remains correct beyond 1001 history rows", () => {
  const db = database();
  for (let index = 1; index <= 1001; index += 1) insertAccepted(db, "student-a", index);
  insertAccepted(db, "student-b", 1);

  const rows = db.prepare(substantiveProgressSql(2)).all("student-a", "student-b");
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((row) => row.student_id === "student-a").length, 3);
  assert.equal(rows.filter((row) => row.student_id === "student-b").length, 1);
  assert.equal(rows.some((row) => row.student_id === "student-b" && row.title === "student-b-1"), true);
  assert.doesNotMatch(substantiveProgressSql(2), /LIMIT\s+1000/i);
  db.close();
});

test("only the current revision can become trusted while latest submission stays separate", () => {
  const db = database();
  const entry = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, current_revision)
    VALUES ('student-c', '组会', 'AI 候选进展', '2026-08-01 00:00:00',
      'supplement', 'changes_requested', NULL, 2) RETURNING id`).get();
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'accepted', 'substantive', '2026-08-10 00:00:00', '2026-08-01 00:00:00')`).run(entry.id);
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 2, 'changes_requested', NULL, NULL, '2026-08-23 16:30:00')`).run(entry.id);

  assert.deepEqual(db.prepare(substantiveProgressSql(1)).all("student-c"), []);
  assert.equal(
    db.prepare(latestSubmittedSql(1)).get("student-c").current_revision_created_at,
    "2026-08-23 16:30:00",
  );
  db.close();
});

test("a newer outstanding track prevents an older accepted next action from resurfacing", () => {
  const db = database();
  const acceptedId = insertAccepted(db, "student-d", 1);
  db.prepare(`INSERT INTO paper_progress_details
    (progress_entry_id, next_action, next_action_due_date, blocker)
    VALUES (?, '旧的论文下一步', '2026-09-01', '')`).run(acceptedId);

  const pending = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, current_revision)
    VALUES ('student-d', '论文', '新的论文版本', '2026-08-24 00:00:00',
      'pending', 'submitted', NULL, 1) RETURNING id`).get();
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'submitted', NULL, NULL, '2026-08-24 00:00:00')`).run(pending.id);
  db.prepare(`INSERT INTO paper_progress_details
    (progress_entry_id, next_action, next_action_due_date, blocker)
    VALUES (?, '新的论文下一步', '2026-09-05', '')`).run(pending.id);

  const accepted = db.prepare(acceptedTrackProgressSql(1)).all("student-d");
  const outstanding = db.prepare(outstandingProgressSql(1)).all("student-d");
  assert.equal(accepted.length, 1);
  assert.equal(outstanding[0].track_type, "paper");
  assert.deepEqual(filterCurrentAcceptedTracks(accepted, outstanding), []);
  db.close();
});

test("overview SQL enforces the supported 100-student request bound", () => {
  assert.throws(() => substantiveProgressSql(0), /1 至 100/);
  assert.throws(() => substantiveProgressSql(101), /1 至 100/);
  assert.equal((substantiveProgressSql(100).match(/\?/g) ?? []).length, 100);
});

test("review authority preserves can_review, self-review, lease, and creator boundaries", () => {
  const now = "2026-08-24T08:00:00Z";
  const submitted = {
    review_status: "submitted",
    submitted_by_user_id: 10,
    reviewed_by_user_id: null,
    review_claimed_at: null,
  };
  assert.equal(canActOnProgressReview(submitted, 20, false, now), false);
  assert.equal(canActOnProgressReview(submitted, 10, true, now), false);
  assert.equal(canActOnProgressReview(submitted, 20, true, now), true);

  const leased = {
    ...submitted,
    review_status: "in_review",
    reviewed_by_user_id: 30,
    review_claimed_at: "2026-08-24T07:45:00Z",
  };
  assert.equal(canActOnProgressReview(leased, 20, true, now), false);
  assert.equal(canActOnProgressReview({ ...leased, reviewed_by_user_id: 20 }, 20, true, now), true);
  assert.equal(reviewLeaseExpired("2026-08-24T07:29:59Z", now), true);
  assert.equal(canActOnProgressReview({ ...leased, review_claimed_at: "2026-08-24T07:29:59Z" }, 20, true, now), true);

  assert.equal(canActOnProposalReview("submitted", 20, 20, true), false);
  assert.equal(canActOnProposalReview("submitted", 30, 20, false), false);
  assert.equal(canActOnProposalReview("submitted", 30, 20, true), true);

  const guidance = { verification_mode: "mentor_verify", student_reported_at: "2026-08-24T00:00:00Z", mentor_user_id: 20 };
  assert.equal(canVerifyGuidance(guidance, 20, false), true);
  assert.equal(canVerifyGuidance({ ...guidance, mentor_user_id: 30 }, 20, false), false);
  assert.equal(canVerifyGuidance({ ...guidance, mentor_user_id: 30 }, 20, true), true);
});

test("the overview route is scoped, read-only, non-cacheable, and excludes deep payload fields", async () => {
  const [route, query] = await Promise.all([
    readFile(new URL("../app/api/dashboard/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/dashboard-overview/query.ts", import.meta.url), "utf8"),
  ]);
  const sql = [
    substantiveProgressSql(1),
    acceptedTrackProgressSql(1),
    latestSubmittedSql(1),
    outstandingProgressSql(1),
  ].join("\n");

  assert.match(route, /requireAppUser\(request, \["superadmin", "admin"\]\)/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route, /export async function (POST|PATCH|DELETE)/);
  assert.match(query, /getStudentScope\(viewer\)/);
  assert.match(query, /scopeSql\(scope, "s\.id"\)/);
  assert.match(query, /Promise\.all/);
  assert.doesNotMatch(query, /LIMIT\s+1000/i);
  assert.doesNotMatch(sql, /attachment|audit|open_id|email|summary|evidence/i);
});
