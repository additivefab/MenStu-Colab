import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("mentor decision inbox, leased reviews, guidance verification, agendas, and reminders stay wired", async () => {
  const [dashboard, studentOverview, dashboardRoute, reviewsRoute, guidanceRoute, meetingAgendaRoute, reminderRoute, database, feishuAuth, manualImport, automaticImport] = await Promise.all([
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/students/[id]/student-overview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reviews/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/student-guidance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/meeting-agendas/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feishu/reminders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/database.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feishu/meeting-imports/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu-message-import.ts", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /id: "inbox", label: "待我处理"/);
  assert.match(dashboard, /id: "research", label: "研究台账"/);
  assert.match(dashboard, /id: "cohort", label: "课题组"/);
  assert.match(dashboard, /MentorDecisionInbox/);
  assert.match(dashboard, /NEXT ACTION/);
  assert.match(dashboard, /AI 纪要候选/);
  assert.match(dashboard, /确认进展/);
  assert.match(dashboard, /需要指导/);
  assert.match(dashboard, /退回并发送指导/);
  assert.match(dashboard, /guidance\?: ReviewGuidance/);
  assert.match(dashboard, /return entry\.ai_summary_origin/);
  assert.match(dashboardRoute, /ai_summary_origin/);
  assert.match(studentOverview, /student-formal-binary/);
  assert.match(studentOverview, /reviewProgress\(entry, "supplement", \{ nextAction: draft\.nextAction/);
  assert.match(dashboard, /记录指导/);
  assert.match(dashboard, /mentorViewFromUrl/);
  assert.match(dashboard, /window\.history\[replace \|\| sameDestination \? "replaceState" : "pushState"\]/);
  assert.match(dashboard, /currentViewer\.role === "superadmin"\s*\? navItems/);
  assert.match(dashboard, /categoryPriority: Record<MentorTaskCategory, number>/);
  assert.match(dashboard, /meetingRequests=\{meetingRequests\}/);
  assert.match(dashboard, /function StaffMeetingRequests\(\{ requests, loadError, onChanged \}/);
  assert.match(dashboard, /mentorResearchTabFromUrl/);
  assert.match(dashboard, /url\.searchParams\.set\("proposal", String\(id\)\)/);
  assert.match(dashboardRoute, /can_decide/);
  assert.match(dashboardRoute, /claim_stale/);
  assert.match(dashboardRoute, /actionablePendingCount/);

  assert.match(reviewsRoute, /REVIEW_LEASE_MINUTES = 30/);
  assert.match(reviewsRoute, /release_review/);
  assert.match(reviewsRoute, /reclaim_review/);
  assert.match(reviewsRoute, /review_claimed_at = CURRENT_TIMESTAMP/);
  assert.match(reviewsRoute, /synchronizeCurrentRevision/);
  assert.match(reviewsRoute, /INSERT INTO student_guidance_notes/);
  assert.match(reviewsRoute, /source_progress_entry_id/);
  assert.match(reviewsRoute, /verification_mode\)\s*SELECT[\s\S]*'mentor_verify'/);
  assert.match(reviewsRoute, /WHERE changes\(\) > 0 AND EXISTS/);
  assert.match(reviewsRoute, /id = last_insert_rowid\(\)/);
  assert.match(reviewsRoute, /guidanceCreated: Boolean\(guidance\)/);

  assert.match(guidanceRoute, /acceptance_criteria/);
  assert.match(guidanceRoute, /verification_mode/);
  assert.match(guidanceRoute, /student_reported_at = CURRENT_TIMESTAMP/);
  assert.match(guidanceRoute, /mentor_verified_at/);
  assert.match(guidanceRoute, /学生尚未提交完成说明/);
  assert.match(dashboardRoute, /guidance_verification/);
  assert.match(dashboardRoute, /n\.content, n\.next_action, n\.acceptance_criteria/);
  assert.match(dashboard, /selected\.task\.acceptanceCriteria \? <button/);
  assert.match(database, /previousVersion === null \|\| previousVersion < 18/);
  assert.match(database, /SET verification_mode = 'self_report'/);
  assert.match(database, /verification_mode IN \('self_report', 'mentor_verify'\)/);
  assert.match(dashboard, /提交完成说明/);
  assert.match(studentOverview, /确认验收/);

  assert.match(meetingAgendaRoute, /INSERT INTO meeting_agendas/);
  assert.match(meetingAgendaRoute, /INSERT INTO meeting_agenda_items/);
  assert.match(meetingAgendaRoute, /expectedUpdatedAt/);
  assert.match(meetingAgendaRoute, /确认排期前请先选择组会日期/);
  assert.match(reminderRoute, /notification_deliveries/);
  assert.match(reminderRoute, /idempotencyKey/);
  assert.match(reminderRoute, /attempt_token/);
  assert.match(reminderRoute, /stableMessageUuid/);
  assert.match(feishuAuth, /messageUuid \? \{ uuid: messageUuid \}/);
  assert.match(reminderRoute, /status = 'failed'/);
  assert.match(dashboard, /daysSinceSubstantiveProgress/);
  assert.match(reminderRoute, /今日已提醒/);

  for (const source of [manualImport, automaticImport]) {
    assert.match(source, /INSERT INTO progress_revisions/);
    assert.match(source, /revision_number/);
    assert.match(source, /removeImportedProgress/);
  }
  assert.match(dashboard, /请明确选择学生/);
  assert.doesNotMatch(dashboard, /studentId: choices\[item\.id\] \|\| students\[0\]/);
});

test("quick guidance transaction creates one linked instruction and rolls back as a unit", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE progress_entries (id INTEGER PRIMARY KEY, review_status TEXT NOT NULL, reviewer_note TEXT NOT NULL DEFAULT '');
    CREATE TABLE progress_audit_events (id INTEGER PRIMARY KEY, progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id));
    CREATE TABLE student_guidance_notes (id INTEGER PRIMARY KEY, source_progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id));
    CREATE TABLE student_guidance_events (id INTEGER PRIMARY KEY, guidance_note_id INTEGER NOT NULL REFERENCES student_guidance_notes(id), action TEXT NOT NULL CHECK (action = 'created'));
    INSERT INTO progress_entries (id, review_status) VALUES (1, 'submitted'), (2, 'submitted');`);

  function decide(entryId, eventAction = "created") {
    database.exec("BEGIN");
    try {
      database.prepare("UPDATE progress_entries SET review_status = 'changes_requested', reviewer_note = '补对照实验' WHERE id = ? AND review_status = 'submitted'").run(entryId);
      database.prepare("INSERT INTO progress_audit_events (progress_entry_id) SELECT ? WHERE changes() > 0").run(entryId);
      database.prepare("INSERT INTO student_guidance_notes (source_progress_entry_id) SELECT ? WHERE changes() > 0 AND EXISTS (SELECT 1 FROM progress_entries WHERE id = ? AND review_status = 'changes_requested')").run(entryId, entryId);
      database.prepare("INSERT INTO student_guidance_events (guidance_note_id, action) SELECT id, ? FROM student_guidance_notes WHERE changes() > 0 AND id = last_insert_rowid()").run(eventAction);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  decide(1);
  decide(1);
  assert.deepEqual({
    audits: database.prepare("SELECT COUNT(*) AS count FROM progress_audit_events WHERE progress_entry_id = 1").get().count,
    notes: database.prepare("SELECT COUNT(*) AS count FROM student_guidance_notes WHERE source_progress_entry_id = 1").get().count,
    events: database.prepare("SELECT COUNT(*) AS count FROM student_guidance_events").get().count,
  }, { audits: 1, notes: 1, events: 1 });

  assert.throws(() => decide(2, "invalid"));
  assert.deepEqual({ ...database.prepare("SELECT review_status, reviewer_note FROM progress_entries WHERE id = 2").get() }, {
    review_status: "submitted",
    reviewer_note: "",
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM student_guidance_notes WHERE source_progress_entry_id = 2").get().count, 0);
});
