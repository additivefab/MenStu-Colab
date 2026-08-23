import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project progress keeps stable milestone identities and immutable evidence revisions", async () => {
  const [schema, migration, proposalsRoute, progressRoute, dashboardRoute] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0017_loud_iron_lad.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/proposals/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/progress/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /export const progressRevisions/);
  assert.match(schema, /export const projectProgressDetails/);
  assert.match(schema, /currentRevision: integer\("current_revision"\)/);
  assert.match(schema, /revisionNumber: integer\("revision_number"\)/);
  assert.match(schema, /archivedAt: text\("archived_at"\)/);
  assert.match(schema, /idx_progress_revisions_entry_number/);
  assert.match(schema, /project_progress_completion_requested/);

  assert.match(migration, /INSERT INTO `progress_revisions`/);
  assert.match(migration, /json_object\(/);
  assert.match(migration, /WHERE NOT EXISTS \(/);
  assert.match(migration, /idx_progress_attachments_entry_revision/);
  assert.match(migration, /idx_progress_evidence_entry_revision/);

  assert.match(proposalsRoute, /UPDATE research_milestones SET archived_at = CURRENT_TIMESTAMP/);
  assert.match(proposalsRoute, /archived_at = NULL/);
  assert.match(proposalsRoute, /milestone\.id/);
  assert.match(proposalsRoute, /不能直接修改为已完成/);
  assert.doesNotMatch(proposalsRoute, /UPDATE research_milestones SET status = 'completed'/);
  assert.doesNotMatch(proposalsRoute, /DELETE FROM research_milestones/);

  assert.match(progressRoute, /project_progress_details/);
  assert.match(progressRoute, /progress_revisions/);
  assert.match(progressRoute, /current_revision/);
  assert.match(progressRoute, /revision_number/);
  assert.match(progressRoute, /completion_requested/);
  assert.doesNotMatch(progressRoute, /UPDATE research_milestones SET status = 'completed'/);
  assert.doesNotMatch(progressRoute, /kind:\s*body\.kind \?\? existing\.kind/);

  assert.match(dashboardRoute, /progress_revisions/);
  assert.match(dashboardRoute, /project_progress_details/);
  assert.match(dashboardRoute, /revision_number/);
  assert.match(dashboardRoute, /rp\.status = 'approved'/);
  assert.match(dashboardRoute, /archived_at IS NULL/);
  assert.match(dashboardRoute, /source\.revision_number === entry\.current_revision/);
  assert.match(dashboardRoute, /attachment\.revision_number === entry\.current_revision/);
  assert.match(dashboardRoute, /paperSnapshotValue\(currentSnapshot, "submissionIdentifier"\) \?\? entry\.submission_identifier/);
});

test("review acceptance is the only authority that closes research milestones and advances paper state", async () => {
  const [progressRoute, reviewsRoute] = await Promise.all([
    readFile(new URL("../app/api/progress/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reviews/route.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(progressRoute, /UPDATE student_papers SET current_stage/);
  assert.match(reviewsRoute, /UPDATE progress_revisions SET\s+review_status/);
  assert.match(reviewsRoute, /current_revision/);
  assert.match(reviewsRoute, /completion_requested/);
  assert.match(reviewsRoute, /UPDATE research_milestones SET status = 'completed'/);
  assert.match(reviewsRoute, /assessment === "substantive"/);
  assert.match(reviewsRoute, /UPDATE student_papers SET\s+current_stage/);
  assert.match(reviewsRoute, /milestone_completed/);
});
