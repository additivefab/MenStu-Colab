import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [progressRoute, reviewsRoute, guidanceRoute, meetingRoute, dashboardRoute, databaseSource, cleanupSource, sagaSqlSource] = await Promise.all([
  readFile(new URL("../app/api/progress/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/reviews/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/student-guidance/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/meeting-requests/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/database.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/progress-file-cleanup.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/progress-saga-sql.ts", import.meta.url), "utf8"),
]);

test("new paper candidates do not enter the authoritative paper register before acceptance", () => {
  assert.doesNotMatch(progressRoute, /INSERT INTO student_papers/u);
  assert.match(reviewsRoute, /INSERT INTO student_papers/u);
  assert.match(reviewsRoute, /review_status = 'accepted'/u);
});

test("initial progress and meeting creates enforce idempotency", () => {
  assert.match(progressRoute, /Idempotency-Key/iu);
  assert.match(progressRoute, /request_hash/u);
  assert.match(meetingRoute, /Idempotency-Key/iu);
  assert.match(meetingRoute, /request_hash/u);
});

test("guidance updates use version CAS and preserve event history", () => {
  assert.match(guidanceRoute, /expectedVersion/u);
  assert.match(guidanceRoute, /version = version \+ 1/u);
  assert.match(guidanceRoute, /AND version = \?/u);
  assert.ok(guidanceRoute.match(/if \(!updated\.meta\.changes\) return guidanceConflictResponse\(\)/gu)?.length >= 4);
});

test("failed object cleanup has a persistent observable queue", () => {
  assert.match(progressRoute, /deleteProgressFilesOrQueue/u);
  assert.match(cleanupSource, /progress_file_cleanup_queue/u);
  assert.match(databaseSource, /progress_file_cleanup_queue/u);
});

test("R2 upload intent is durable before object creation and incomplete parents stay private", () => {
  const intent = progressRoute.indexOf("'upload_intent'");
  const objectWrite = progressRoute.indexOf("await bucket.put");
  assert.ok(intent > 0 && objectWrite > intent);
  assert.match(progressRoute, /DELETE FROM progress_file_cleanup_queue WHERE storage_key/u);
  assert.match(progressRoute, /submitted_at <= datetime\('now', '-30 minutes'\)/u);
  assert.match(dashboardRoute, /EXISTS \(SELECT 1 FROM progress_revisions current_revision/u);
});

test("ambiguous progress commits are verified before R2 compensation", () => {
  const postStart = progressRoute.indexOf("export async function POST");
  const postCatch = progressRoute.slice(
    progressRoute.indexOf("  } catch (error) {", postStart),
    progressRoute.indexOf("export async function PATCH", postStart),
  );
  assert.ok(postCatch.indexOf("findIdempotentProgress") < postCatch.indexOf("recoverOwnedIncompleteProgressSubmission"));
  assert.match(postCatch, /previous\?\.request_hash === requestHash && previous\.complete/u);
  assert.match(postCatch, /recoverOwnedIncompleteProgressSubmission/u);
  assert.match(postCatch, /status: 503/u);

  const patchStart = progressRoute.indexOf("export async function PATCH");
  const patchCatch = progressRoute.slice(progressRoute.indexOf("  } catch (error) {", patchStart));
  assert.ok(patchCatch.indexOf("findCommittedResubmission") < patchCatch.indexOf("abortProgressUploadIntents"));
  assert.match(patchCatch, /abortProgressUploadIntents/u);
  assert.match(progressRoute, /json_extract\(snapshot_json, '\$\._operationToken'\)/u);
  assert.match(patchCatch, /附件不会被清理/u);
  assert.match(patchCatch, /Without an upload-intent row[\s\S]*status: 503/u);
});

test("resubmission finalizer and compensation share the exact multi-file intent lease", () => {
  assert.match(progressRoute, /progressUploadIntentGuardSql\(staged\.length\)/u);
  assert.match(cleanupSource, /claimProgressUploadIntentsSql\(storageKeys\.length\)/u);
  assert.match(sagaSqlSource, /guarded_intent\.storage_key IN/u);
  assert.match(sagaSqlSource, /intent_guard\.storage_key IN/u);
  assert.match(sagaSqlSource, /reason NOT LIKE 'cleanup_claimed:%'/u);
  assert.ok(sagaSqlSource.match(/fresh_intent\.updated_at > datetime\('now', '-30 minutes'\)/gu)?.length >= 2);
  assert.match(cleanupSource, /if \(!claimedParent\) \{[\s\S]*claimStaleResubmissionUpload\(item\)/u);
  assert.match(sagaSqlSource, /claimStaleResubmissionUploadSql[\s\S]*JOIN progress_revisions current_revision/u);
});

test("meeting races recheck the idempotency key and mentor confirmations reject overlap", () => {
  assert.ok(meetingRoute.match(/WHERE requested_by_user_id = \? AND idempotency_key = \?/gu)?.length >= 3);
  assert.match(meetingRoute, /mentorScheduleGuard/u);
  assert.match(meetingRoute, /mentor_existing\.handled_by_user_id = \?/u);
});
