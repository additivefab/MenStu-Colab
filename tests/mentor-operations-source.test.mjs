import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(dashboard, /记录指导/);
  assert.match(dashboard, /mentorViewFromUrl/);
  assert.match(dashboard, /window\.history\[replace \|\| sameDestination \? "replaceState" : "pushState"\]/);
  assert.match(dashboard, /data\?\.viewer\.role === "superadmin"\s*\? navItems/);
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
