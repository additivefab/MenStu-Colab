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
  guidanceOverviewSql,
  latestSubmittedSql,
  milestoneOverviewSql,
  outstandingProgressSql,
  paperPositionSql,
  proposalOverviewSql,
  reviewableStudentSql,
  substantiveProgressSql,
} from "../lib/dashboard-overview/query-sql.ts";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE progress_deletions (progress_entry_id INTEGER PRIMARY KEY);
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
      reviewed_by_user_id INTEGER,
      reviewed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE student_papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '测试论文',
      current_stage TEXT NOT NULL DEFAULT 'drafting',
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE paper_progress_details (
      progress_entry_id INTEGER PRIMARY KEY,
      paper_id INTEGER NOT NULL,
      next_action TEXT NOT NULL,
      next_action_due_date TEXT NOT NULL,
      blocker TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE research_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '测试方案',
      status TEXT NOT NULL,
      current_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE research_proposal_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      submitted_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE research_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '测试节点',
      target_date TEXT,
      status TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE project_progress_details (
      progress_entry_id INTEGER PRIMARY KEY,
      milestone_id INTEGER,
      proposal_version INTEGER,
      next_action TEXT NOT NULL,
      next_action_due_date TEXT NOT NULL,
      blocker TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE student_guidance_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      mentor_user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      verification_mode TEXT NOT NULL DEFAULT 'self_report',
      student_reported_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE mentor_student_assignments (
      mentor_user_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      can_review INTEGER NOT NULL DEFAULT 1
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
  const studentARows = rows.filter((row) => row.student_id === "student-a");
  assert.equal(studentARows.length, 3);
  assert.deepEqual(studentARows.map((row) => row.title), ["student-a-979", "student-a-951", "student-a-923"]);
  assert.equal(studentARows.every((row) => row.confirmed_at === "2026-07-28 00:00:00"), true);
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
  const paper = db.prepare("INSERT INTO student_papers (student_id, status) VALUES ('student-d', 'active') RETURNING id").get();
  const acceptedId = insertAccepted(db, "student-d", 1);
  db.prepare(`INSERT INTO paper_progress_details
    (progress_entry_id, paper_id, next_action, next_action_due_date, blocker)
    VALUES (?, ?, '旧的论文下一步', '2026-09-01', '')`).run(acceptedId, paper.id);

  const pending = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, current_revision)
    VALUES ('student-d', '论文', '新的论文版本', '2026-08-24 00:00:00',
      'pending', 'submitted', NULL, 1) RETURNING id`).get();
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'submitted', NULL, NULL, '2026-08-24 00:00:00')`).run(pending.id);
  db.prepare(`INSERT INTO paper_progress_details
    (progress_entry_id, paper_id, next_action, next_action_due_date, blocker)
    VALUES (?, ?, '新的论文下一步', '2026-09-05', '')`).run(pending.id, paper.id);

  const accepted = db.prepare(acceptedTrackProgressSql(1)).all("student-d");
  const outstanding = db.prepare(outstandingProgressSql(1)).all("student-d");
  assert.equal(accepted.length, 0);
  assert.equal(outstanding[0].track_type, "paper");
  assert.deepEqual(filterCurrentAcceptedTracks(accepted, outstanding), []);
  db.close();
});

test("closed papers and stale or completed proposal milestones cannot revive accepted actions", () => {
  const db = database();
  const closedPaper = db.prepare("INSERT INTO student_papers (student_id, status) VALUES ('student-e', 'closed') RETURNING id").get();
  const closedProgress = insertAccepted(db, "student-e", 1);
  db.prepare(`INSERT INTO paper_progress_details
    (progress_entry_id, paper_id, next_action, next_action_due_date, blocker)
    VALUES (?, ?, '已经关闭的论文动作', '2026-08-01', '旧阻塞')`).run(closedProgress, closedPaper.id);

  const proposal = db.prepare("INSERT INTO research_proposals (student_id, status, current_version) VALUES ('student-e', 'approved', 2) RETURNING id").get();
  const staleMilestone = db.prepare("INSERT INTO research_milestones (proposal_id, status, archived_at) VALUES (?, 'in_progress', '2026-08-20') RETURNING id").get(proposal.id);
  const staleProject = insertAccepted(db, "student-e", 2);
  db.prepare(`INSERT INTO project_progress_details
    (progress_entry_id, milestone_id, proposal_version, next_action, next_action_due_date, blocker)
    VALUES (?, ?, 1, '旧方案动作', '2026-08-02', '旧方案阻塞')`).run(staleProject, staleMilestone.id);

  assert.deepEqual(db.prepare(acceptedTrackProgressSql(1)).all("student-e"), []);

  const currentMilestone = db.prepare("INSERT INTO research_milestones (proposal_id, status, archived_at) VALUES (?, 'in_progress', NULL) RETURNING id").get(proposal.id);
  const currentProject = insertAccepted(db, "student-e", 3);
  db.prepare(`INSERT INTO project_progress_details
    (progress_entry_id, milestone_id, proposal_version, next_action, next_action_due_date, blocker)
    VALUES (?, ?, 2, '当前方案动作', '2026-09-02', '')`).run(currentProject, currentMilestone.id);
  const currentRows = db.prepare(acceptedTrackProgressSql(1)).all("student-e");
  assert.equal(currentRows.length, 1);
  assert.equal(currentRows[0].next_action, "当前方案动作");

  db.prepare("UPDATE research_milestones SET status = 'completed' WHERE id = ?").run(currentMilestone.id);
  assert.deepEqual(db.prepare(acceptedTrackProgressSql(1)).all("student-e"), []);
  db.close();
});

test("closed papers and obsolete proposal versions cannot revive outstanding waits or suppress current tracks", () => {
  const db = database();
  const closedPaper = db.prepare("INSERT INTO student_papers (student_id, status) VALUES ('student-g', 'closed') RETURNING id").get();
  const closedPending = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, current_revision)
    VALUES ('student-g', '论文', '已关闭论文的历史补交', '2026-08-20 00:00:00',
      'pending', 'changes_requested', NULL, 1) RETURNING id`).get();
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'changes_requested', NULL, NULL, '2026-08-20 00:00:00')`).run(closedPending.id);
  db.prepare(`INSERT INTO paper_progress_details
    (progress_entry_id, paper_id, next_action, next_action_due_date, blocker)
    VALUES (?, ?, '历史动作', '2026-08-21', '')`).run(closedPending.id, closedPaper.id);

  const proposal = db.prepare("INSERT INTO research_proposals (student_id, status, current_version) VALUES ('student-g', 'approved', 2) RETURNING id").get();
  const obsoleteMilestone = db.prepare("INSERT INTO research_milestones (proposal_id, status, archived_at) VALUES (?, 'in_progress', NULL) RETURNING id").get(proposal.id);
  const obsoletePending = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, current_revision)
    VALUES ('student-g', '课题', '旧方案版本的历史补交', '2026-08-21 00:00:00',
      'pending', 'changes_requested', NULL, 1) RETURNING id`).get();
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'changes_requested', NULL, NULL, '2026-08-21 00:00:00')`).run(obsoletePending.id);
  db.prepare(`INSERT INTO project_progress_details
    (progress_entry_id, milestone_id, proposal_version, next_action, next_action_due_date, blocker)
    VALUES (?, ?, 1, '历史方案动作', '2026-08-22', '')`).run(obsoletePending.id, obsoleteMilestone.id);

  assert.deepEqual(db.prepare(outstandingProgressSql(1)).all("student-g"), []);
  db.close();
});

test("unlinked project progress remains a valid current track and review fact", () => {
  const db = database();
  const accepted = insertAccepted(db, "student-h", 1);
  db.prepare(`INSERT INTO project_progress_details
    (progress_entry_id, milestone_id, proposal_version, next_action, next_action_due_date, blocker)
    VALUES (?, NULL, NULL, '整理当前课题实验', '2026-09-03', '')`).run(accepted);
  const acceptedRows = db.prepare(acceptedTrackProgressSql(1)).all("student-h");
  assert.equal(acceptedRows.length, 1);
  assert.equal(acceptedRows[0].track_type, "project");

  const pending = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, current_revision)
    VALUES ('student-h', '课题', '未关联节点的课题进展', '2026-08-24 00:00:00',
      'pending', 'submitted', NULL, 1) RETURNING id`).get();
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'submitted', NULL, NULL, '2026-08-24 00:00:00')`).run(pending.id);
  db.prepare(`INSERT INTO project_progress_details
    (progress_entry_id, milestone_id, proposal_version, next_action, next_action_due_date, blocker)
    VALUES (?, NULL, NULL, '待审核课题动作', '2026-09-05', '')`).run(pending.id);
  const outstanding = db.prepare(outstandingProgressSql(1)).all("student-h");
  assert.equal(outstanding.length, 1);
  assert.equal(outstanding[0].track_type, "project");
  db.close();
});

test("accepted and published papers keep legitimate pending reviews while closed papers do not", () => {
  const db = database();
  for (const [index, status] of ["accepted", "published", "closed"].entries()) {
    const paper = db.prepare("INSERT INTO student_papers (student_id, status) VALUES ('student-i', ?) RETURNING id").get(status);
    const entry = db.prepare(`INSERT INTO progress_entries
      (student_id, kind, title, submitted_at, status, review_status, assessment, current_revision)
      VALUES ('student-i', '论文', ?, '2026-08-24 00:00:00', 'pending', 'submitted', NULL, 1)
      RETURNING id`).get(`${status}-paper`);
    db.prepare(`INSERT INTO progress_revisions
      (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
      VALUES (?, 1, 'submitted', NULL, NULL, ?)`).run(entry.id, `2026-08-24 0${index}:00:00`);
    db.prepare(`INSERT INTO paper_progress_details
      (progress_entry_id, paper_id, next_action, next_action_due_date, blocker)
      VALUES (?, ?, '更新论文状态', '2026-09-06', '')`).run(entry.id, paper.id);
  }
  const rows = db.prepare(outstandingProgressSql(1)).all("student-i");
  assert.deepEqual(rows.map((row) => row.title), ["accepted-paper", "published-paper"]);
  assert.equal(rows.every((row) => row.track_type === "paper"), true);
  db.close();
});

test("accepted records without a mentor review timestamp never become trusted", () => {
  const db = database();
  const entry = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, reviewed_at)
    VALUES ('student-f', '实验', '缺少当前修订确认时间', '2026-08-20 00:00:00', 'substantive', 'accepted', 'substantive', '2026-08-19 00:00:00')
    RETURNING id`).get();
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'accepted', 'substantive', NULL, '2026-08-20 00:00:00')`).run(entry.id);
  assert.deepEqual(db.prepare(substantiveProgressSql(1)).all("student-f"), []);
  db.close();
});

test("latest submission requires parent and current revision review states to agree", () => {
  const db = database();
  const entry = db.prepare(`INSERT INTO progress_entries
    (student_id, kind, title, submitted_at, status, review_status, assessment, current_revision)
    VALUES ('student-j', '实验', '状态不一致的提交', '2026-08-24 00:00:00',
      'pending', 'submitted', NULL, 1) RETURNING id`).get();
  db.prepare(`INSERT INTO progress_revisions
    (progress_entry_id, revision_number, review_status, assessment, reviewed_at, created_at)
    VALUES (?, 1, 'changes_requested', NULL, NULL, '2026-08-24 00:00:00')`).run(entry.id);
  assert.deepEqual(db.prepare(latestSubmittedSql(1)).all("student-j"), []);
  db.close();
});

test("accepted and outstanding track authority compares revision creation time, not late review time", () => {
  const accepted = [{ id: 10, track_type: "paper", track_key: "paper:1", current_revision_created_at: "2026-08-01T00:00:00Z", confirmed_at: "2026-08-10T00:00:00Z" }];
  const outstanding = [{ id: 11, track_type: "paper", track_key: "paper:1", current_revision_created_at: "2026-08-02T00:00:00Z" }];
  assert.deepEqual(filterCurrentAcceptedTracks(accepted, outstanding), []);
});

test("retiring the latest project baseline cannot resurrect a superseded general-project blocker", () => {
  const db = database();
  const old = insertAccepted(db, "student-retired", 1);
  db.prepare("INSERT INTO project_progress_details VALUES (?, NULL, NULL, '旧行动', '2026-08-01', '旧困难')").run(old);
  const proposal = db.prepare("INSERT INTO research_proposals (student_id, status, current_version) VALUES ('student-retired', 'approved', 1) RETURNING id").get();
  const milestone = db.prepare("INSERT INTO research_milestones (proposal_id, status) VALUES (?, 'in_progress') RETURNING id").get(proposal.id);
  const latest = insertAccepted(db, "student-retired", 2);
  db.prepare("INSERT INTO project_progress_details VALUES (?, ?, 1, '最新安排', '2026-09-30', '')").run(latest, milestone.id);
  const rows = () => db.prepare(acceptedTrackProgressSql(1)).all("student-retired");
  assert.equal(rows()[0].id, latest);
  for (const change of [
    "UPDATE research_milestones SET status = 'completed'",
    "UPDATE research_milestones SET status = 'in_progress', archived_at = '2026-09-20'",
    "UPDATE research_milestones SET archived_at = NULL; UPDATE research_proposals SET current_version = 2",
    "UPDATE research_proposals SET current_version = 1, status = 'draft'",
  ]) {
    db.exec(change);
    assert.deepEqual(rows(), [], change);
  }
  db.exec("UPDATE research_proposals SET status = 'approved'; UPDATE project_progress_details SET next_action = '', blocker = '' WHERE milestone_id IS NOT NULL");
  assert.equal(rows()[0].id, latest);
  assert.equal(rows()[0].next_action, "");
  assert.equal(rows()[0].blocker, "");
  db.close();
});

test("each paper retains its own baseline and a pending revision only supersedes its matching paper", () => {
  const db = database();
  const paperIds = [];
  for (let index = 1; index <= 2; index++) {
    const paper = db.prepare("INSERT INTO student_papers (student_id, status) VALUES ('student-papers', 'active') RETURNING id").get();
    paperIds.push(paper.id);
    const progressId = insertAccepted(db, "student-papers", index);
    db.prepare("INSERT INTO paper_progress_details VALUES (?, ?, ?, '2026-08-01', '')").run(progressId, paper.id, `论文${index}`);
  }
  const rows = db.prepare(acceptedTrackProgressSql(1)).all("student-papers");
  assert.equal(rows.length, 2);
  const pending = [{ id: 100, track_type: "paper", track_key: `paper:${paperIds[1]}`, current_revision_created_at: "2026-08-20T00:00:00Z" }];
  assert.deepEqual(filterCurrentAcceptedTracks(rows, pending).map((row) => row.track_key), [`paper:${paperIds[0]}`]);
  db.prepare("UPDATE student_papers SET status = 'closed' WHERE id = ?").run(paperIds[1]);
  assert.deepEqual(db.prepare(acceptedTrackProgressSql(1)).all("student-papers").map((row) => row.track_key), [`paper:${paperIds[0]}`]);
  db.close();
});

test("same-instant submissions follow the ID ordering and never suppress another track", () => {
  const accepted = [{ id: 20, track_type: "paper", track_key: "paper:1", current_revision_created_at: "2026-09-12 08:00:00" }];
  const pending = { id: 21, track_type: "paper", track_key: "paper:1", current_revision_created_at: "2026-09-12T08:00:00Z" };
  assert.deepEqual(filterCurrentAcceptedTracks(accepted, [pending]), []);
  assert.deepEqual(filterCurrentAcceptedTracks(accepted, [{ ...pending, id: 19 }]), accepted);
  assert.deepEqual(filterCurrentAcceptedTracks(accepted, [{ ...pending, track_key: "paper:2" }]), accepted);
  assert.deepEqual(filterCurrentAcceptedTracks(accepted, [{ ...pending, track_type: "project", track_key: "project" }]), accepted);
});

test("a retired newer submission remains a barrier to older accepted project work without staying in the inbox", () => {
  const db = database();
  const old = insertAccepted(db, "student-barrier", 1);
  db.prepare("INSERT INTO project_progress_details VALUES (?, NULL, NULL, '过时的行动', '2026-08-01', '旧困难')").run(old);
  const proposal = db.prepare("INSERT INTO research_proposals (student_id, status, current_version) VALUES ('student-barrier', 'approved', 1) RETURNING id").get();
  const milestone = db.prepare("INSERT INTO research_milestones (proposal_id, status) VALUES (?, 'in_progress') RETURNING id").get(proposal.id);
  const newer = insertAccepted(db, "student-barrier", 2);
  db.prepare("INSERT INTO project_progress_details VALUES (?, ?, 1, '新方案的安排', '2026-09-30', '')").run(newer, milestone.id);
  db.prepare("UPDATE progress_entries SET review_status = 'submitted', status = 'pending', assessment = NULL WHERE id = ?").run(newer);
  db.prepare("UPDATE progress_revisions SET review_status = 'submitted', assessment = NULL, reviewed_at = NULL WHERE progress_entry_id = ?").run(newer);
  assert.deepEqual(db.prepare(acceptedTrackProgressSql(1)).all("student-barrier"), []);
  assert.equal(db.prepare(outstandingProgressSql(1)).all("student-barrier").length, 1);
  db.exec("UPDATE research_proposals SET status = 'draft'");
  assert.deepEqual(db.prepare(acceptedTrackProgressSql(1)).all("student-barrier"), []);
  assert.deepEqual(db.prepare(outstandingProgressSql(1)).all("student-barrier"), []);
  db.close();
});

test("overview SQL enforces the supported 100-student request bound", () => {
  assert.throws(() => substantiveProgressSql(0), /1 至 100/);
  assert.throws(() => substantiveProgressSql(101), /1 至 100/);
  assert.equal((substantiveProgressSql(100).match(/\?/g) ?? []).length, 100);
  assert.equal((reviewableStudentSql.match(/\?/g) ?? []).length, 1);
});

test("all nine scoped summary queries execute at the 100-student boundary without N+1 binds", () => {
  const db = database();
  const ids = Array.from({ length: 100 }, (_, index) => `scope-${String(index + 1).padStart(3, "0")}`);
  ids.forEach((studentId) => db.prepare(`INSERT INTO mentor_student_assignments
    (mentor_user_id, student_id, active, can_review) VALUES (77, ?, 1, 1)`).run(studentId));
  const batchQueries = [
    substantiveProgressSql,
    acceptedTrackProgressSql,
    latestSubmittedSql,
    outstandingProgressSql,
    proposalOverviewSql,
    milestoneOverviewSql,
    guidanceOverviewSql,
    paperPositionSql,
  ];
  for (const buildSql of batchQueries) {
    const sql = buildSql(ids.length);
    assert.equal((sql.match(/\?/g) ?? []).length, 100);
    assert.doesNotThrow(() => db.prepare(sql).all(...ids));
  }
  const reviewable = db.prepare(reviewableStudentSql).all(77);
  assert.equal(reviewable.length, 100);
  db.close();
});

test("review authority preserves can_review, self-review, lease, and creator boundaries", () => {
  const now = "2026-08-24T08:00:00Z";
  const submitted = {
    review_status: "submitted",
    submitted_by_user_id: 10,
    reviewed_by_user_id: null,
    review_claimed_at: null,
    revision_review_status: "submitted",
    revision_reviewed_by_user_id: null,
  };
  assert.equal(canActOnProgressReview(submitted, 20, false, now), false);
  assert.equal(canActOnProgressReview(submitted, 10, true, now), false);
  assert.equal(canActOnProgressReview(submitted, 20, true, now), true);

  const leased = {
    ...submitted,
    review_status: "in_review",
    reviewed_by_user_id: 30,
    revision_review_status: "in_review",
    revision_reviewed_by_user_id: 30,
    review_claimed_at: "2026-08-24T07:45:00Z",
  };
  assert.equal(canActOnProgressReview(leased, 20, true, now), false);
  assert.equal(canActOnProgressReview({ ...leased, reviewed_by_user_id: 20, revision_reviewed_by_user_id: 20 }, 20, true, now), true);
  assert.equal(reviewLeaseExpired("2026-08-24T07:29:59Z", now), true);
  assert.equal(canActOnProgressReview({ ...leased, review_claimed_at: "2026-08-24T07:29:59Z" }, 20, true, now), true);
  assert.equal(canActOnProgressReview({ ...leased, revision_reviewed_by_user_id: 31, review_claimed_at: "2026-08-24T07:29:59Z" }, 20, true, now), false);

  assert.equal(canActOnProposalReview("submitted", 20, 20, true), false);
  assert.equal(canActOnProposalReview("submitted", 30, 20, false), false);
  assert.equal(canActOnProposalReview("submitted", 30, 20, true), true);

  const guidance = { verification_mode: "mentor_verify", student_reported_at: "2026-08-24T00:00:00Z", mentor_user_id: 20 };
  assert.equal(canVerifyGuidance(guidance, 20, false), true);
  assert.equal(canVerifyGuidance({ ...guidance, mentor_user_id: 30 }, 20, false), false);
  assert.equal(canVerifyGuidance({ ...guidance, mentor_user_id: 30 }, 20, true), true);
});

test("the overview route is scoped, read-only, non-cacheable, and excludes deep payload fields", async () => {
  const [route, query, assemble] = await Promise.all([
    readFile(new URL("../app/api/dashboard/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/dashboard-overview/query.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/dashboard-overview/assemble.ts", import.meta.url), "utf8"),
  ]);
  const sql = [
    substantiveProgressSql(1),
    acceptedTrackProgressSql(1),
    latestSubmittedSql(1),
    outstandingProgressSql(1),
  ].join("\n");

  assert.match(route, /requireAppUser\(request, \["superadmin", "admin"\]\)/);
  assert.match(route, /assertMentorOverviewResponse\(overview\)/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route, /export async function (POST|PATCH|DELETE)/);
  assert.match(query, /getStudentScope\(viewer\)/);
  assert.match(query, /scopeSql\(scope, "s\.id"\)/);
  assert.match(query, /Promise\.all/);
  assert.match(assemble, /blockers:[\s\S]*?dueDate: null/);
  assert.doesNotMatch(query, /LIMIT\s+1000/i);
  assert.doesNotMatch(sql, /attachment|audit|open_id|email|summary|evidence/i);
});
