import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const reviewsRoute = await readFile(new URL("../app/api/reviews/route.ts", import.meta.url), "utf8");
const synchronizeSqlMatch = reviewsRoute.match(/const SYNCHRONIZE_CURRENT_REVISION_SQL = `([\s\S]*?)`;/u);
assert.ok(synchronizeSqlMatch, "review revision repair SQL must remain directly testable");
const synchronizeSql = synchronizeSqlMatch[1];

function reviewDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE progress_entries (
      id INTEGER PRIMARY KEY,
      current_revision INTEGER NOT NULL,
      review_status TEXT NOT NULL,
      assessment TEXT,
      reviewer_note TEXT NOT NULL DEFAULT '',
      reviewed_by_user_id INTEGER,
      reviewed_at TEXT
    );
    CREATE TABLE progress_revisions (
      progress_entry_id INTEGER NOT NULL,
      revision_number INTEGER NOT NULL,
      review_status TEXT NOT NULL,
      assessment TEXT,
      reviewer_note TEXT NOT NULL DEFAULT '',
      reviewed_by_user_id INTEGER,
      reviewed_at TEXT,
      PRIMARY KEY (progress_entry_id, revision_number)
    );
  `);
  return database;
}

function synchronize(database, entryId, expectedRevision) {
  return database.prepare(synchronizeSql).run(
    entryId,
    entryId,
    entryId,
    entryId,
    entryId,
    entryId,
    expectedRevision,
    entryId,
    expectedRevision,
  );
}

test("a stale V1 review repair cannot rewrite history after the parent advances to V2", () => {
  const database = reviewDatabase();
  database.exec(`
    INSERT INTO progress_entries
      (id, current_revision, review_status, assessment, reviewer_note, reviewed_by_user_id, reviewed_at)
      VALUES (21, 2, 'submitted', NULL, '', NULL, NULL);
    INSERT INTO progress_revisions
      (progress_entry_id, revision_number, review_status, assessment, reviewer_note, reviewed_by_user_id, reviewed_at)
      VALUES
      (21, 1, 'changes_requested', NULL, '请补充原始数据', 9, '2026-08-24 09:00:00'),
      (21, 2, 'submitted', NULL, '', NULL, NULL);
  `);

  const result = synchronize(database, 21, 1);
  assert.equal(result.changes, 0);
  assert.deepEqual(
    { ...database.prepare(`SELECT current_revision, review_status, reviewer_note, reviewed_by_user_id
      FROM progress_entries WHERE id = 21`).get() },
    { current_revision: 2, review_status: "submitted", reviewer_note: "", reviewed_by_user_id: null },
  );
  assert.deepEqual(
    database.prepare(`SELECT revision_number, review_status, reviewer_note, reviewed_by_user_id
      FROM progress_revisions WHERE progress_entry_id = 21 ORDER BY revision_number`).all().map((row) => ({ ...row })),
    [
      { revision_number: 1, review_status: "changes_requested", reviewer_note: "请补充原始数据", reviewed_by_user_id: 9 },
      { revision_number: 2, review_status: "submitted", reviewer_note: "", reviewed_by_user_id: null },
    ],
  );
  database.close();
});

test("revision repair still restores a partial write while the expected revision remains current", () => {
  const database = reviewDatabase();
  database.exec(`
    INSERT INTO progress_entries
      (id, current_revision, review_status, assessment, reviewer_note, reviewed_by_user_id, reviewed_at)
      VALUES (22, 1, 'in_review', NULL, '', 7, '2026-08-24 10:00:00');
    INSERT INTO progress_revisions
      (progress_entry_id, revision_number, review_status, assessment, reviewer_note, reviewed_by_user_id, reviewed_at)
      VALUES (22, 1, 'accepted', 'supporting', '部分写入', 8, '2026-08-24 10:01:00');
  `);

  const result = synchronize(database, 22, 1);
  assert.equal(result.changes, 1);
  assert.deepEqual(
    { ...database.prepare(`SELECT review_status, assessment, reviewer_note, reviewed_by_user_id, reviewed_at
      FROM progress_revisions WHERE progress_entry_id = 22 AND revision_number = 1`).get() },
    {
      review_status: "in_review",
      assessment: null,
      reviewer_note: "",
      reviewed_by_user_id: 7,
      reviewed_at: "2026-08-24 10:00:00",
    },
  );
  database.close();
});

test("review route binds the captured revision as both target and parent CAS", () => {
  assert.match(synchronizeSql, /revision_number = \?[\s\S]*current_parent\.current_revision = \?/u);
  assert.match(
    reviewsRoute,
    /\.bind\(id, id, id, id, id, id, entry\.current_revision, id, entry\.current_revision\)\.run\(\)/u,
  );
});
