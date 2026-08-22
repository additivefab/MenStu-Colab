import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mentor scope, evidence provenance, outputs, and upgrade backfill remain wired together", async () => {
  const [schema, migration, dashboardRoute, reviewsRoute, outputsRoute, usersRoute, studentPage, feishuImport] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0006_boring_nehzno.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reviews/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/research-outputs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/users/route.ts", import.meta.url), "utf8"),
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
  assert.match(dashboardRoute, /getStudentScope/);
  assert.match(dashboardRoute, /scopeSql/);
  assert.match(reviewsRoute, /canReviewStudent/);
  assert.match(reviewsRoute, /review_status = \?/);
  assert.match(outputsRoute, /validateHttpsUrl/);
  assert.match(outputsRoute, /research_output_events/);
  assert.match(usersRoute, /mentor_student_assignments/);
  assert.match(studentPage, /科研成果与资产/);
  assert.match(studentPage, /个人进展与证据链/);
  assert.doesNotMatch(feishuImport, /messageId\.slice/);
  assert.match(feishuImport, /review_status, updated_at/);
});
