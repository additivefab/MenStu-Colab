import assert from "node:assert/strict";
import test from "node:test";

import { assembleMentorOverview } from "../lib/dashboard-overview/assemble.ts";
import { assertMentorOverviewResponse, mentorOverviewResponseJsonBytes } from "../lib/dashboard-overview/contract.ts";

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
