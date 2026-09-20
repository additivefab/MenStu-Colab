import assert from "node:assert/strict";
import test from "node:test";
import { progressFollowUpNotice } from "../lib/progress-follow-up.ts";

const plan = { next_action: "按照意见修改", next_action_due_date: "2026-08-31" };
const accepted = { review_status: "accepted", paper: plan, project: null };

test("the overdue notice separates an accepted record from its historical plan", () => {
  const message = progressFollowUpNotice(accepted, "2026-09-20T08:00:00Z");
  assert.match(message, /本次进展已通过/);
  assert.match(message, /记录中的下一步期限已过/);
  assert.match(message, /最新安排以学生后续提交的进展为准/);
  assert.doesNotMatch(message, /阻塞|审核失败/);
  assert.equal(progressFollowUpNotice({ ...accepted, paper: null, project: plan }, "2026-09-20"), message);
});

test("pending, returned, missing and not-yet-overdue plans do not get an approval follow-up notice", () => {
  for (const review_status of ["submitted", "in_review", "changes_requested", "rejected"]) {
    assert.equal(progressFollowUpNotice({ ...accepted, review_status }, "2026-09-20"), null);
  }
  assert.equal(progressFollowUpNotice(accepted, "2026-08-31T15:59:59Z"), null);
  assert.ok(progressFollowUpNotice(accepted, "2026-08-31T16:00:00Z"));
  assert.equal(progressFollowUpNotice({ ...accepted, paper: { ...plan, next_action_due_date: "" } }, "2026-09-20"), null);
  assert.equal(progressFollowUpNotice({ ...accepted, paper: { ...plan, next_action: " " } }, "2026-09-20"), null);
  assert.equal(progressFollowUpNotice({ ...accepted, paper: null }, "2026-09-20"), null);
});


test("confirmed or pending completion results suppress the historical overdue notice", () => {
  for (const status of ["pending", "resolved"]) {
    assert.equal(progressFollowUpNotice({ review_status: "accepted", paper: { next_action: "整理结果", next_action_due_date: "2026-08-01" }, project: null, follow_up_states: { next_action: status } }, new Date("2026-09-20T08:00:00Z")), null);
  }
});
