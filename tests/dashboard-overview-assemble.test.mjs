import assert from "node:assert/strict";
import test from "node:test";

import { assembleMentorOverview, overviewLoopPending } from "../lib/dashboard-overview/assemble.ts";
import { assertMentorOverviewResponse, mentorOverviewResponseJsonBytes } from "../lib/dashboard-overview/contract.ts";
import { overviewActionHref, overviewActionLabel } from "../components/dashboard-overview/overview-actions.ts";
import { overviewStates } from "../lib/dashboard-overview/types.ts";

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

test("assembly carries complete monthly counts independently of latest progress and open problems", () => {
  const input = inputOf(2);
  const monthly = { month: "2026-08", phase: "submitted", total: 5, confirmed: 4, pending: 1, needsChanges: 0, candidates: 2 };
  input.monthlyDeliveries = new Map([["student-1", monthly]]);
  const response = assembleMentorOverview(input, { id: 1, role: "superadmin", studentId: null }, NOW);
  assert.deepEqual(response.students.find((student) => student.studentId === "student-1").monthlyDelivery, monthly);
  assert.deepEqual(response.students.find((student) => student.studentId === "student-2").monthlyDelivery, {
    month: "2026-08", phase: "preparing", total: 0, confirmed: 0, pending: 0, needsChanges: 0, candidates: 0,
  });
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
});

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
  assert.equal(overviewActionHref(after), "/students/student-1#progress-resolution-12-next_action");
  assert.deepEqual(after.counters, { actionableByMentor: 0, waitingForStudent: 0, blocked: 0, overdue: 1 });
  assert.equal(after.latestSubstantiveAt, confirmedAt);
  assert.equal(after.nextActionDueDate, "2026-08-31");

  input.acceptedTracks[0].blocker = "缺少实验设备";
  const blocked = assembleMentorOverview(input, admin, now).students[0];
  assert.equal(blocked.primaryReasonCode, "NEXT_ACTION_OVERDUE");
  assert.equal(blocked.primaryAction, "follow_up");
  assert.equal(overviewActionLabel(blocked), "跟进下一步");
  assert.equal(blocked.issues.find((issue) => issue.code === "MILESTONE_BLOCKED")?.state, "follow_up");
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
  assert.deepEqual(response.counts, Object.fromEntries(overviewStates.map((state) => [state, 0])));
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
  assert.equal(row.primaryState, "on_track");
  assert.equal(overviewActionLabel(row), "查看进展");
  assert.equal(overviewActionHref(row), "/students/student-1#progress-71");
  assert.equal(row.issues.find((issue) => issue.state === "follow_up")?.dueDate, null);
  assert.equal(row.issues.find((issue) => issue.code === "ON_TRACK_NEXT_ACTION")?.dueDate, "2026-09-02");
  assert.equal(row.nextActionDueDate, "2026-09-02");
});

function currentTrack(overrides = {}) {
  return {
    id: 18, student_id: "student-1", current_revision: 2,
    track_type: "project", track_key: "project",
    next_action: "完成部署", next_action_due_date: "2026-08-20", blocker: "缺少测试设备",
    current_revision_created_at: "2026-08-21T00:00:00Z", confirmed_at: "2026-08-22T00:00:00Z",
    ...overrides,
  };
}

function resolution(overrides = {}) {
  return {
    id: 1, student_id: "student-1", progress_entry_id: 18, revision_number: 2,
    item_kind: "blocker", status: "pending", version: 1,
    submitted_by_user_id: 20, submitted_at: "2026-08-23T00:00:00Z",
    resolved_at: null, submission_note: "附件中包含处理说明", reviewer_note: "",
    ...overrides,
  };
}

function inputWithResolution(overrides = {}) {
  return {
    ...inputOf(),
    reviewableStudentIds: ["student-1"],
    acceptedTracks: [currentTrack()],
    resolutions: [resolution()],
    ...overrides,
  };
}

test("reported outcomes replace only their original reminders with one review per reported item", () => {
  const response = assembleMentorOverview(inputWithResolution({ resolutions: [
    resolution(), resolution({ id: 2, item_kind: "next_action" }),
  ] }), admin, NOW);
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
  const row = response.students[0];
  assert.equal(row.primaryState, "mentor");
  assert.equal(row.primaryAction, "review_resolution");
  assert.equal(overviewActionLabel(row), "确认处理结果");
  assert.equal(overviewActionHref(row), "/students/student-1#progress-resolution-18-next_action");
  assert.deepEqual(row.counters, { actionableByMentor: 1, waitingForStudent: 0, blocked: 1, overdue: 0 });
  assert.equal(row.issues.length, 2);
  assert.equal(row.nextAction, null);
  assert.equal(row.nextActionDueDate, null);
  assert.doesNotMatch(JSON.stringify(response), /附件中包含处理说明|submission_note/);
  assert.equal(row.issues.every((issue) => issue.sourceType === "resolution"), true);
  assert.doesNotMatch(row.primaryReasonLabel, /已解决|已完成/);
});

test("confirming a difficulty leaves the separate overdue plan open until its own confirmation", () => {
  const input = inputWithResolution({ resolutions: [resolution({ status: "resolved" })] });
  const blockerClosed = assembleMentorOverview(input, admin, NOW).students[0];
  assert.equal(blockerClosed.primaryReasonCode, "NEXT_ACTION_OVERDUE");
  assert.equal(blockerClosed.counters.blocked, 0);
  assert.equal(blockerClosed.counters.overdue, 1);
  assert.equal(blockerClosed.nextAction, "完成部署");

  input.resolutions.push(resolution({ id: 2, item_kind: "next_action", status: "resolved" }));
  const allClosed = assembleMentorOverview(input, admin, NOW);
  assert.equal(allClosed.students[0].primaryState, "on_track");
  assert.deepEqual(allClosed.students[0].counters, { actionableByMentor: 0, waitingForStudent: 0, blocked: 0, overdue: 0 });
  assert.equal(allClosed.students[0].nextAction, null);
  assert.doesNotThrow(() => assertMentorOverviewResponse(allClosed));
});

test("returned outcomes wait for student supplementation and reopening restores the original reminder", () => {
  const input = inputWithResolution({
    acceptedTracks: [currentTrack({ next_action: "" })],
    resolutions: [resolution({ status: "changes_requested" })],
  });
  const returned = assembleMentorOverview(input, admin, NOW);
  const row = returned.students[0];
  assert.equal(row.primaryState, "on_track");
  assert.equal(row.issues.find((issue) => issue.state === "follow_up")?.code, "STUDENT_RESOLUTION_CHANGES_REQUESTED");
  assert.equal(row.issues.find((issue) => issue.state === "follow_up")?.action, "view_resolution");
  assert.deepEqual(row.counters, { actionableByMentor: 0, waitingForStudent: 0, blocked: 1, overdue: 0 });
  assert.doesNotThrow(() => assertMentorOverviewResponse(returned));

  input.resolutions[0].status = "open";
  const reopened = assembleMentorOverview(input, admin, NOW).students[0];
  assert.equal(reopened.primaryState, "on_track");
  assert.equal(reopened.issues.find((issue) => issue.state === "follow_up")?.action, "resolve_blocker");
  assert.equal(reopened.counters.blocked, 1);
});

test("resolution authority rejects earlier revisions, unrelated entries, other students, and superseded tracks", () => {
  const baseline = inputWithResolution({ resolutions: [] });
  const expected = assembleMentorOverview(baseline, admin, NOW);
  for (const overrides of [
    { revision_number: 1 }, { progress_entry_id: 17 }, { student_id: "outside-scope" },
  ]) {
    const input = inputWithResolution({ resolutions: [resolution({ status: "resolved", ...overrides })] });
    assert.deepEqual(assembleMentorOverview(input, admin, NOW), expected);
  }
  const newer = pending({ id: 19, track_type: "project", track_key: "project", current_revision_created_at: "2026-08-24T00:00:00Z" });
  const superseded = assembleMentorOverview(inputWithResolution({ outstanding: [newer] }), admin, NOW);
  assert.equal(superseded.students[0].primaryAction, "review_progress");
  assert.equal(superseded.students[0].issues.some((issue) => issue.sourceType === "resolution"), false);
});

test("view-only and self-submitted outcomes remain visible without becoming executable reviews or overdue alarms", () => {
  for (const scenario of [
    { reviewableStudentIds: [] },
    { resolutions: [resolution({ submitted_by_user_id: 10 })] },
  ]) {
    const response = assembleMentorOverview(inputWithResolution({
      acceptedTracks: [currentTrack({ next_action: "" })], ...scenario,
    }), admin, NOW);
    const row = response.students[0];
    assert.equal(row.primaryState, "on_track");
    const problem = row.issues.find((issue) => issue.state === "follow_up");
    assert.equal(problem?.action, "view_resolution");
    assert.match(problem?.label, /等待导师确认处理结果/);
    assert.equal(problem?.owner, "mentor");
    assert.deepEqual(row.counters, { actionableByMentor: 0, waitingForStudent: 0, blocked: 1, overdue: 0 });
    assert.doesNotThrow(() => assertMentorOverviewResponse(response));
  }
});

test("closing a progress difficulty never closes a separate blocked research milestone or another paper", () => {
  const response = assembleMentorOverview(inputWithResolution({
    acceptedTracks: [currentTrack({ next_action: "" }), currentTrack({ id: 22, track_type: "paper", track_key: "paper:2", next_action: "", blocker: "另一篇论文缺少数据" })],
    resolutions: [resolution({ status: "resolved" })],
    milestones: [{ id: 9, student_id: "student-1", proposal_title: "研究方案", title: "设备验证", target_date: null, status: "blocked", sort_order: 1, updated_at: NOW }],
  }), admin, NOW);
  assert.equal(response.students[0].counters.blocked, 2);
  assert.deepEqual(new Set(response.students[0].issues.filter((issue) => issue.state === "follow_up").map((issue) => issue.sourceType)), new Set(["paper", "milestone"]));
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
});

function problemRecord(overrides = {}) {
  return {
    id: "progress:18:2:blocker", studentId: "student-1", studentName: "学生1",
    source: "progress", trackType: "project", title: "旧进展的问题", content: "设备仍未到位",
    status: "open", current: true, updatedAt: NOW, dueDate: null,
    href: "/students/student-1#progress-resolution-18-blocker-revision-2", ...overrides,
  };
}

test("canonical unresolved problems survive new progress without duplicating current blocker facts", () => {
  const input = inputWithResolution({
    acceptedTracks: [currentTrack({ next_action: "", blocker: "设备仍未到位" })],
    resolutions: [], problemRecords: [problemRecord()],
  });
  const confirmed = assembleMentorOverview(input, admin, NOW);
  assert.equal(confirmed.students[0].primaryState, "on_track");
  assert.equal(confirmed.students[0].counters.blocked, 1);
  assert.equal(confirmed.students[0].additionalIssueCount, 0);
  assert.doesNotThrow(() => assertMentorOverviewResponse(confirmed));

  input.outstanding = [pending({ track_type: "project", track_key: "project", current_revision_created_at: NOW })];
  const newSubmission = assembleMentorOverview(input, admin, NOW);
  assert.equal(newSubmission.students[0].primaryState, "mentor");
  assert.equal(newSubmission.students[0].primaryReasonCode, "MENTOR_PROGRESS_REVIEW");
  assert.equal(newSubmission.students[0].counters.blocked, 1);
  assert.equal(newSubmission.students[0].counters.actionableByMentor, 1);
  assert.equal(newSubmission.students[0].issues.filter((issue) => issue.state === "follow_up").length, 1);
  assert.doesNotThrow(() => assertMentorOverviewResponse(newSubmission));
});

test("problem follow-up dates, reported outcomes, and requested supplements remain separate from progress", () => {
  for (const status of ["open", "pending", "changes_requested"]) {
    const input = inputWithResolution({
      acceptedTracks: [currentTrack({ next_action: "推进下一轮实验", next_action_due_date: "2026-09-02" })],
      problemRecords: [problemRecord({ status, dueDate: "2026-08-01" })],
      guidance: [{ id: 41, student_id: "student-1", mentor_user_id: 10, guidance_type: "blocker", title: "记录设备问题", next_action: "等待设备维修", due_date: "2026-08-01", verification_mode: "mentor_verify", student_reported_at: status === "pending" ? NOW : null, created_at: NOW, updated_at: NOW }],
    });
    const response = assembleMentorOverview(input, admin, NOW);
    const row = response.students[0];
    assert.equal(row.primaryState, "on_track", status);
    assert.equal(row.nextAction, "推进下一轮实验", status);
    assert.equal(row.nextActionDueDate, "2026-09-02", status);
    assert.deepEqual(row.counters, { actionableByMentor: 0, waitingForStudent: 0, blocked: 1, overdue: 0 }, status);
    assert.doesNotThrow(() => assertMentorOverviewResponse(response));
  }
});

test("resolved and historical problems leave progress unchanged and are not active problem counts", () => {
  const input = inputWithResolution({
    acceptedTracks: [currentTrack({ next_action: "" })],
    problemRecords: [problemRecord({ status: "resolved" }), problemRecord({ id: "progress:17:1:blocker", status: "historical" }), problemRecord({ studentId: "outside-scope" })],
  });
  const response = assembleMentorOverview(input, admin, NOW);
  assert.equal(response.students[0].primaryState, "on_track");
  assert.equal(response.students[0].counters.blocked, 0);
  assert.equal(response.students[0].issues.some((issue) => issue.state === "follow_up"), false);
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
});

test("an unconfirmed first submission remains awaiting review even with a separate open problem", () => {
  const input = { ...inputOf(), reviewableStudentIds: ["student-1"], outstanding: [pending()], problemRecords: [problemRecord()] };
  const response = assembleMentorOverview(input, admin, NOW);
  assert.equal(response.students[0].primaryState, "mentor");
  assert.equal(response.students[0].latestSubstantiveAt, null);
  assert.equal(response.weeklySubstantiveStudentCount, 0);
  assert.equal(response.students[0].counters.blocked, 1);
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
});

test("research-loop pending is absent for students and equals the inbox count for staff", () => {
  // Stub of countLoopInboxByStudent(d1, viewer): includes a student outside this scope.
  const inboxCounts = { "student-1": 2, "student-3": 5, "outside-scope": 9 };
  const input = { ...inputOf(3), loopPendingByStudent: inboxCounts };

  const mentorView = assembleMentorOverview(input, admin, NOW);
  assert.deepEqual(mentorView.students.map((row) => [row.studentId, row.loopPending]), [
    ["student-1", 2],
    ["student-2", 0],
    ["student-3", 5],
  ]);
  assert.ok(!JSON.stringify(mentorView).includes("outside-scope"));
  assert.doesNotThrow(() => assertMentorOverviewResponse(mentorView));
  assert.deepEqual(
    assembleMentorOverview(input, { id: 1, role: "superadmin" }, NOW).students.map((row) => row.loopPending),
    [2, 0, 5],
  );

  for (const role of ["student", "pending"]) {
    const studentView = assembleMentorOverview(input, { id: 30, role }, NOW);
    assert.ok(studentView.students.every((row) => !Object.hasOwn(row, "loopPending")), role);
    assert.doesNotThrow(() => assertMentorOverviewResponse(studentView));
  }

  // Counts unavailable (not loaded or failed): the field is omitted, not faked as 0.
  for (const loopPendingByStudent of [undefined, null]) {
    const response = assembleMentorOverview({ ...inputOf(2), loopPendingByStudent }, admin, NOW);
    assert.ok(response.students.every((row) => !Object.hasOwn(row, "loopPending")));
  }
});

test("research-loop pending never changes state, counts, or other student facts", () => {
  const without = assembleMentorOverview(inputOf(4), admin, NOW);
  const withCounts = assembleMentorOverview({ ...inputOf(4), loopPendingByStudent: { "student-2": 7 } }, admin, NOW);
  assert.deepEqual(withCounts.counts, without.counts);
  assert.deepEqual(
    withCounts.students.map((row) => {
      const rest = { ...row };
      delete rest.loopPending;
      return rest;
    }),
    without.students,
  );
  assert.equal(overviewLoopPending(admin, { "student-1": -2 }, "student-1"), 0);
  assert.equal(overviewLoopPending(admin, { "student-1": Number.NaN }, "student-1"), 0);
  assert.equal(overviewLoopPending(admin, { "student-1": 3 }, "student-1"), 3);
  assert.equal(overviewLoopPending({ role: "student" }, { "student-1": 3 }, "student-1"), undefined);
});
