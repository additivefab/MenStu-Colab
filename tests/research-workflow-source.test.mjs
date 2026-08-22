import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mentor scope, evidence provenance, outputs, and upgrade backfill remain wired together", async () => {
  const [schema, migration, roleMigration, roleRequestMigration, dashboardRoute, reviewsRoute, outputsRoute, usersRoute, progressRoute, proposalsRoute, feishuAuth, studentPage, feishuImport] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0006_boring_nehzno.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0007_magical_hobgoblin.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0008_dear_steve_rogers.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reviews/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/research-outputs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/users/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/progress/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/proposals/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/students/[id]/student-overview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu-message-import.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /mentorStudentAssignments/);
  assert.match(schema, /progressEvidenceSources/);
  assert.match(schema, /researchOutputs/);
  assert.match(migration, /migration_backfill/);
  assert.match(migration, /WHEN 'substantive' THEN 'substantive'/);
  assert.match(migration, /ALTER TABLE `progress_entries` ADD `updated_at` text;/);
  assert.doesNotMatch(migration, /ADD `updated_at` text DEFAULT CURRENT_TIMESTAMP/);
  assert.match(roleMigration, /CREATE TABLE IF NOT EXISTS `app_user_role_events`/);
  assert.match(roleMigration, /`request_id` text NOT NULL/);
  assert.match(roleRequestMigration, /idx_app_user_role_events_request/);
  assert.match(dashboardRoute, /getStudentScope/);
  assert.match(dashboardRoute, /scopeSql/);
  assert.match(dashboardRoute, /if \(viewer\.role === "student"\)/);
  assert.match(dashboardRoute, /workflowTasks: \[\]/);
  assert.match(reviewsRoute, /canReviewStudent/);
  assert.match(reviewsRoute, /requireAppUser\(request, \["superadmin", "mentor"\]\)/);
  assert.match(reviewsRoute, /不能审核由自己提交或代录的进展/);
  assert.match(reviewsRoute, /review_status = \?/);
  assert.match(outputsRoute, /validateHttpsUrl/);
  assert.match(outputsRoute, /research_output_events/);
  assert.doesNotMatch(outputsRoute, /requireAppUser\(request, \["admin", "student"\]\)/);
  assert.match(usersRoute, /mentor_student_assignments/);
  assert.match(usersRoute, /首次超级管理员授予/);
  assert.match(usersRoute, /app_user_role_events/);
  assert.match(usersRoute, /feishu_open_id = \?/);
  assert.match(usersRoute, /NOT EXISTS \(SELECT 1 FROM app_users WHERE role = 'superadmin'/);
  assert.match(usersRoute, /COUNT\(\*\) FROM app_users WHERE role = 'superadmin'.*\) > 1/);
  assert.match(usersRoute, /actor\.active = 1 AND actor\.role = \?/);
  assert.match(progressRoute, /submitted_by_user_id = \?/);
  assert.match(progressRoute, /studentId: auth\.user\.role === "student" \? auth\.user\.studentId : body\.studentId/);
  assert.match(proposalsRoute, /can_review:/);
  assert.doesNotMatch(proposalsRoute, /requireAppUser\(request, \["superadmin", "admin", "mentor", "student"\]\)/);
  assert.doesNotMatch(feishuAuth, /isConfiguredSuperAdmin/);
  assert.match(studentPage, /科研成果与资产/);
  assert.match(studentPage, /个人进展与证据链/);
  assert.doesNotMatch(feishuImport, /messageId\.slice/);
  assert.match(feishuImport, /review_status, updated_at/);
});
