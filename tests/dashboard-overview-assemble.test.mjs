import assert from "node:assert/strict";
import test from "node:test";

import { assembleMentorOverview } from "../lib/dashboard-overview/assemble.ts";
import { assertMentorOverviewResponse, mentorOverviewResponseJsonBytes } from "../lib/dashboard-overview/contract.ts";
import { overviewActionHref, overviewActionLabel } from "../components/dashboard-overview/overview-actions.ts";

const NOW = "2026-08-24T08:00:00.000Z";

function student(index = 1) {
  return {
    id: `student-${index}`,
    display_name: `学生${index}`,
    degree: index % 2 ? "博士" : "硕士",
    grade_year: 2024,
    stage: "研究执行期",
    cadence_days: 30,
    current_focus: "完成当前实验",
    tracking_started_at: null,
  };
}

function inputOf(count = 1) {
  return {
    students: Array.from({ length: count }, (_, index) => student(index + 1)),
    reviewableStudentIds: [],
    substantive: [],
    acceptedTracks: [],
    latestSubmitted: [],
    outstanding: [],
    proposals: [],
    milestones: [],
    guidance: [],
    papers: [],
  };
}

function pending(overrides = {}) {
  return {
    id: 51,
    student_id: "student-1",
    title: "待审核进展",
    review_status: "submitted",
    submitted_by_user_id: 20,
    reviewed_by_user_id: null,
    review_claimed_at: null,
    revision_review_status: "submitted",
    revision_reviewed_by_user_id: null,
    current_revision_created_at: "2026-08-24T00:00:00.000Z",
    track_type: null,
    ...overrides,
  };
}

const admin = { id: 10, role: "admin" };

test("approval keeps the confirmed progress and follows up an overdue plan without inventing a blocker", () => {
  const input = inputOf();
  const confirmedAt = "2026-09-12T08:00:00.000Z";
  const now = "2026-09-20T08:00:00.000Z";
  input.reviewableStudentIds = ["student-1"];
  input.outstanding = [pending({ id: 12, track_type: "paper" })];
  const before = assembleMentorOverview(input, admin, now).students[0];
  assert.equal(before.primaryAction, "review_progress");
  assert.equal(before.counters.actionableByMentor, 1);

  input.outstanding = [];
  input.substantive = [{ id: 12, student_id: "student-1", kind: "论文", title: "讨论完修改意见", confirmed_at: confirmedAt }];
  input.acceptedTracks = [{
    id: 12, student_id: "student-1", track_type: "paper", next_action: "按照意见修改",
    next_action_due_date: "2026-08-31", blocker: "",
    current_revision_created_at: "2026-08-24T00:00:00.000Z", confirmed_at: confirmedAt,
  }];
  const response = assembleMentorOverview(input, admin, now);
  const after = response.students[0];
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
  assert.equal(after.primaryReasonCode, "NEXT_ACTION_OVERDUE");
  assert.equal(after.primaryAction, "follow_up");
  assert.equal(overviewActionLabel(after), "跟进下一步");
  assert.equal(overviewActionHref(after), "/students/student-1#progress-12");
  assert.deepEqual(after.counters, { actionableByMentor: 0, waitingForStudent: 0, blocked: 0, overdue: 1 });
  assert.equal(after.latestSubstantiveAt, confirmedAt);
  assert.equal(after.nextActionDueDate, "2026-08-31");

  input.acceptedTracks[0].blocker = "缺少实验设备";
  const blocked = assembleMentorOverview(input, admin, now).students[0];
  assert.equal(blocked.primaryAction, "resolve_blocker");
  assert.equal(overviewActionLabel(blocked), "处理阻塞");
  assert.equal(blocked.counters.blocked, 1);
  assert.equal(blocked.counters.overdue, 1);
});

test("overdue milestones and guidance keep their own follow-up destinations", () => {
  const input = inputOf();
  input.milestones = [{ id: 31, student_id: "student-1", proposal_title: "研究方案", title: "实验验证", target_date: "2026-08-20", status: "in_progress", sort_order: 1, updated_at: NOW }];
  const milestone = assembleMentorOverview(input, admin, NOW).students[0];
  assert.equal(milestone.primaryAction, "follow_up");
  assert.equal(milestone.counters.blocked, 0);
  assert.equal(overviewActionLabel(milestone), "跟进节点");
  assert.equal(overviewActionHref(milestone), "/students/student-1#milestone-31");

  input.milestones = [];
  input.guidance = [{ id: 41, student_id: "student-1", mentor_user_id: 10, title: "实验建议", next_action: "补充实验", due_date: "2026-08-20", verification_mode: "mentor_verify", student_reported_at: null, created_at: NOW, updated_at: NOW }];
  const guidance = assembleMentorOverview(input, admin, NOW).students[0];
  assert.equal(guidance.primaryAction, "follow_up");
  assert.equal(overviewActionLabel(guidance), "跟进指导");
  assert.equal(overviewActionHref(guidance), "/students/student-1#guidance-41");
});

test("empty admin scope assembles a non-leaking zero response", () => {
  const response = assembleMentorOverview(inputOf(0), admin, NOW);
  assert.deepEqual(response.students, []);
  assert.equal(response.total, 0);
  assert.deepEqual(Object.values(response.counts), [0, 0, 0, 0, 0]);
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
});

test("can_review, self-review, active lease, and expired lease change the executable action only at assembly", () => {
  const cases = [
    { name: "can_review=0", reviewable: [], row: pending(), expected: "insufficient" },
    { name: "self review", reviewable: ["student-1"], row: pending({ submitted_by_user_id: 10 }), expected: "insufficient" },
    {
      name: "active other lease",
      reviewable: ["student-1"],
      row: pending({
        review_status: "in_review",
        revision_review_status: "in_review",
        reviewed_by_user_id: 30,
        revision_reviewed_by_user_id: 30,
        review_claimed_at: "2026-08-24T07:45:00.000Z",
      }),
      expected: "insufficient",
    },
    {
      name: "expired other lease",
      reviewable: ["student-1"],
      row: pending({
        review_status: "in_review",
        revision_review_status: "in_review",
        reviewed_by_user_id: 30,
        revision_reviewed_by_user_id: 30,
        review_claimed_at: "2026-08-24T07:20:00.000Z",
      }),
      expected: "mentor",
    },
    { name: "reviewable submission", reviewable: ["student-1"], row: pending(), expected: "mentor" },
  ];

  for (const scenario of cases) {
    const input = inputOf();
    input.reviewableStudentIds = scenario.reviewable;
    input.outstanding = [scenario.row];
    input.latestSubmitted = [{ id: 51, student_id: "student-1", current_revision_created_at: scenario.row.current_revision_created_at }];
    const response = assembleMentorOverview(input, admin, NOW);
    assert.equal(response.students[0].primaryState, scenario.expected, scenario.name);
    assert.equal(response.students[0].counters.actionableByMentor, scenario.expected === "mentor" ? 1 : 0, scenario.name);
    assert.doesNotThrow(() => assertMentorOverviewResponse(response), scenario.name);
  }
});

test("a returned record remains a student wait even when the viewer cannot review it", () => {
  const input = inputOf();
  input.outstanding = [pending({ review_status: "changes_requested", revision_review_status: "changes_requested" })];
  const response = assembleMentorOverview(input, admin, NOW);
  assert.equal(response.students[0].primaryState, "student");
  assert.equal(response.students[0].primaryAction, "view_progress");
  assert.equal(response.students[0].counters.actionableByMentor, 0);
});

test("facts outside the scoped base-student list never enter names, counts, or summaries", () => {
  const input = inputOf();
  input.substantive = [{ id: 99, student_id: "outside-scope", kind: "实验", title: "不应泄露", confirmed_at: NOW }];
  input.guidance = [{
    id: 98,
    student_id: "outside-scope",
    mentor_user_id: 10,
    title: "越权指导",
    next_action: "不应泄露",
    due_date: null,
    verification_mode: "mentor_verify",
    student_reported_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  }];
  const response = assembleMentorOverview(input, admin, NOW);
  assert.equal(response.total, 1);
  assert.equal(JSON.stringify(response).includes("不应泄露"), false);
  assert.equal(JSON.stringify(response).includes("越权指导"), false);
});

test("100 scoped students assemble one valid compact response", () => {
  const response = assembleMentorOverview(inputOf(100), { id: 1, role: "superadmin" }, NOW);
  assert.equal(response.total, 100);
  assert.equal(Object.values(response.counts).reduce((sum, count) => sum + count, 0), 100);
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
  assert.ok(mentorOverviewResponseJsonBytes(response) < 250 * 1024);
});

test("a blocker never borrows the separate next-action deadline", () => {
  const input = inputOf();
  input.acceptedTracks = [{
    id: 71,
    student_id: "student-1",
    track_type: "project",
    next_action: "补充第三组实验",
    next_action_due_date: "2026-09-02",
    blocker: "设备尚未到位",
    current_revision_created_at: "2026-08-20T00:00:00.000Z",
    confirmed_at: "2026-08-21T00:00:00.000Z",
  }];
  const response = assembleMentorOverview(input, admin, NOW);
  const row = response.students[0];
  assert.equal(row.primaryState, "intervene");
  assert.equal(row.issues[0].dueDate, null);
  assert.equal(row.issues.find((issue) => issue.code === "ON_TRACK_NEXT_ACTION")?.dueDate, "2026-09-02");
  assert.equal(row.nextActionDueDate, "2026-09-02");
});
