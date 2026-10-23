import assert from "node:assert/strict";
import test from "node:test";

import { countOverviewStates, deriveStudentOverview } from "../lib/dashboard-overview/derive.ts";
import { overviewStates } from "../lib/dashboard-overview/types.ts";
import {
  calendarDayDiff,
  isInCurrentShanghaiWeek,
  isOverdueInShanghai,
  shanghaiDateKey,
  shanghaiWeekStart,
} from "../lib/dashboard-overview/dates.ts";

const now = "2026-08-24T00:30:00+08:00";

function input(overrides = {}) {
  return {
    studentId: "student-001",
    cadenceDays: 30,
    trackingStartedAt: "2026-08-01T00:00:00Z",
    latestSubstantiveAt: "2026-08-15T00:00:00Z",
    latestSubmittedAt: "2026-08-20T00:00:00Z",
    hasConfirmedMainline: true,
    milestones: [],
    nextActions: [],
    blockers: [],
    mentorReviews: [],
    studentWaits: [],
    ...overrides,
  };
}

test("mentor review outranks a routine blocked milestone while keeping its follow-up record", () => {
  const result = deriveStudentOverview(input({
    milestones: [{ id: 9, title: "完成跨材料验证", targetDate: "2026-08-28", status: "blocked", updatedAt: "2026-08-22T00:00:00Z" }],
    mentorReviews: [{ id: 31, title: "补充消融实验", occurredAt: "2026-08-23T00:00:00Z", kind: "progress" }],
  }), now);

  assert.equal(result.primaryState, "mentor");
  assert.equal(result.primaryReasonCode, "MENTOR_PROGRESS_REVIEW");
  assert.equal(result.additionalIssueCount, 0);
  assert.equal(result.issues.find((issue) => issue.code === "MILESTONE_BLOCKED")?.state, "follow_up");
  assert.equal(result.counters.actionableByMentor, 1);
});

test("routine progress difficulties and blocked milestones remain neutral follow-ups", () => {
  const result = deriveStudentOverview(input({
    blockers: [{ id: 21, label: "设备尚未到位", dueDate: null, occurredAt: "2026-08-22T00:00:00Z", sourceType: "progress" }],
    milestones: [{ id: 9, title: "设备验证", targetDate: "2026-08-28", status: "blocked", updatedAt: "2026-08-22T00:00:00Z" }],
  }), now);

  assert.equal(result.primaryState, "on_track");
  assert.equal(result.primaryAction, "view_student");
  assert.equal(result.issues.filter((issue) => issue.state === "follow_up").length, 2);
  assert.equal(result.additionalIssueCount, 0);
  assert.deepEqual(result.counters, { actionableByMentor: 0, waitingForStudent: 0, blocked: 2, overdue: 0 });
});

test("an overdue blocked milestone keeps both its risk and its separate problem record", () => {
  const result = deriveStudentOverview(input({
    milestones: [{ id: 9, title: "设备验证", targetDate: "2026-08-20", status: "blocked", updatedAt: "2026-08-22T00:00:00Z" }],
  }), now);

  assert.equal(result.primaryState, "intervene");
  assert.equal(result.primaryReasonCode, "MILESTONE_OVERDUE");
  assert.equal(result.primaryAction, "follow_up");
  assert.equal(result.issues.find((issue) => issue.code === "MILESTONE_BLOCKED")?.state, "follow_up");
  assert.deepEqual(result.counters, { actionableByMentor: 0, waitingForStudent: 0, blocked: 1, overdue: 1 });
});

test("an overdue plan outranks a routine difficulty without attributing its deadline to the difficulty", () => {
  const result = deriveStudentOverview(input({
    blockers: [{ id: 21, label: "等待设备", dueDate: null, occurredAt: "2026-08-22T00:00:00Z", sourceType: "paper" }],
    nextActions: [{ id: 21, label: "完成实验", dueDate: "2026-08-20", occurredAt: "2026-08-22T00:00:00Z", sourceType: "paper" }],
  }), now);

  assert.equal(result.primaryReasonCode, "NEXT_ACTION_OVERDUE");
  assert.equal(result.primaryState, "intervene");
  assert.equal(result.issues.find((issue) => issue.code === "MILESTONE_BLOCKED")?.dueDate, null);
  assert.equal(result.counters.blocked, 1);
  assert.equal(result.counters.overdue, 1);
});

test("routine follow-up does not suppress a stale student update or manufacture mentor review work", () => {
  const result = deriveStudentOverview(input({
    cadenceDays: 7,
    latestSubstantiveAt: "2026-08-01T00:00:00Z",
    blockers: [{ id: 21, label: "等待设备", dueDate: null, occurredAt: "2026-08-22T00:00:00Z", sourceType: "progress" }],
  }), now);

  assert.equal(result.primaryState, "student");
  assert.equal(result.issues.some((issue) => issue.code === "STUDENT_CADENCE_OVERDUE"), true);
  assert.deepEqual(result.counters, { actionableByMentor: 0, waitingForStudent: 1, blocked: 1, overdue: 0 });
});

test("overdue milestone outranks an open student guidance action", () => {
  const result = deriveStudentOverview(input({
    milestones: [{ id: 4, title: "形成训练集", targetDate: "2026-08-20", status: "in_progress", updatedAt: "2026-08-19T00:00:00Z" }],
    studentWaits: [{ id: 7, title: "补齐数据说明", dueDate: "2026-08-30", occurredAt: "2026-08-21T00:00:00Z", kind: "guidance" }],
  }), now);

  assert.equal(result.primaryReasonCode, "MILESTONE_OVERDUE");
  assert.ok(result.issues.some((issue) => issue.code === "STUDENT_GUIDANCE_ACTION"));
});

test("mentor work outranks cadence and suppresses the stale-only student issue", () => {
  const result = deriveStudentOverview(input({
    cadenceDays: 14,
    latestSubstantiveAt: "2026-07-01T00:00:00Z",
    mentorReviews: [{ id: 8, title: "论文 V3", occurredAt: "2026-08-23T00:00:00Z", kind: "progress" }],
  }), now);

  assert.equal(result.primaryState, "mentor");
  assert.equal(result.primaryReasonCode, "MENTOR_PROGRESS_REVIEW");
  assert.equal(result.issues.some((issue) => issue.code === "STUDENT_CADENCE_OVERDUE"), false);
});

test("changes requested is waiting for the student", () => {
  const result = deriveStudentOverview(input({
    latestSubstantiveAt: null,
    hasConfirmedMainline: false,
    studentWaits: [{ id: 12, title: "补充对照实验", dueDate: null, occurredAt: "2026-08-22T00:00:00Z", kind: "changes_requested" }],
  }), now);

  assert.equal(result.primaryState, "student");
  assert.equal(result.primaryReasonCode, "STUDENT_CHANGES_REQUESTED");
  assert.equal(result.primaryAction, "view_progress");
});

test("a returned proposal waits for student revision and links to that proposal", () => {
  const result = deriveStudentOverview(input({
    latestSubstantiveAt: null,
    hasConfirmedMainline: false,
    studentWaits: [{ id: 44, title: "重构研究假设", dueDate: null, occurredAt: "2026-08-22T00:00:00Z", kind: "proposal_changes_requested" }],
  }), now);

  assert.equal(result.primaryState, "student");
  assert.equal(result.primaryReasonCode, "STUDENT_CHANGES_REQUESTED");
  assert.equal(result.primaryAction, "view_proposal");
  assert.equal(result.primaryActionTargetId, 44);
});

test("cadence overdue alone is waiting for the student rather than red", () => {
  const result = deriveStudentOverview(input({
    cadenceDays: 14,
    latestSubstantiveAt: "2026-08-01T00:00:00Z",
    hasConfirmedMainline: false,
  }), now);

  assert.equal(result.primaryState, "student");
  assert.equal(result.primaryReasonCode, "STUDENT_CADENCE_OVERDUE");
  assert.match(result.primaryReasonLabel, /超节奏 9 天/);
});

test("a normal future student action is on track", () => {
  const result = deriveStudentOverview(input({
    latestSubstantiveAt: null,
    nextActions: [{ id: 21, label: "完成第三组实验", dueDate: "2026-08-30", occurredAt: "2026-08-20T00:00:00Z", sourceType: "progress" }],
  }), now);

  assert.equal(result.primaryState, "on_track");
  assert.equal(result.primaryReasonCode, "ON_TRACK_NEXT_ACTION");
  assert.equal(result.nextOwner, "student");
});

test("missing tracking baseline never becomes a synthetic 999-day risk", () => {
  const result = deriveStudentOverview(input({
    trackingStartedAt: null,
    latestSubstantiveAt: null,
    latestSubmittedAt: "2026-08-23T00:00:00Z",
    hasConfirmedMainline: false,
  }), now);

  assert.equal(result.primaryState, "insufficient");
  assert.equal(result.primaryReasonCode, "INSUFFICIENT_NO_BASELINE");
  assert.doesNotMatch(result.primaryReasonLabel, /999|红色/);
});

test("an AI or pending submission changes latest submission only, not trusted progress", () => {
  const result = deriveStudentOverview(input({
    trackingStartedAt: null,
    latestSubstantiveAt: null,
    latestSubmittedAt: "2026-08-23T16:30:00Z",
    hasConfirmedMainline: false,
  }), now);

  assert.equal(result.primaryReasonCode, "INSUFFICIENT_NO_BASELINE");
  assert.equal(result.issues[0].occurredAt, "2026-08-23T16:30:00Z");
});

test("Shanghai calendar makes the due date inclusive and the next day overdue", () => {
  assert.equal(isOverdueInShanghai("2026-08-24", "2026-08-24T23:59:59+08:00"), false);
  assert.equal(isOverdueInShanghai("2026-08-24", "2026-08-25T00:00:00+08:00"), true);
  assert.equal(shanghaiDateKey("2026-08-24 16:00:00"), "2026-08-25");
  assert.equal(calendarDayDiff("2026-08-25", "2026-08-24"), 1);
});

test("issue ordering is deterministic by state, reason, date, and source", () => {
  const fact = input({
    milestones: [
      { id: 3, title: "节点乙", targetDate: "2026-08-19", status: "in_progress", updatedAt: "2026-08-18T00:00:00Z" },
      { id: 2, title: "节点甲", targetDate: "2026-08-18", status: "in_progress", updatedAt: "2026-08-17T00:00:00Z" },
    ],
  });
  const first = deriveStudentOverview(fact, now);
  const second = deriveStudentOverview(fact, now);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.issues.filter((issue) => issue.code === "MILESTONE_OVERDUE").map((issue) => issue.sourceId),
    [2, 3],
  );
});

test("the current Shanghai week starts on Monday and counts each instant consistently", () => {
  assert.equal(shanghaiWeekStart("2026-08-24T08:00:00+08:00"), "2026-08-24");
  assert.equal(isInCurrentShanghaiWeek("2026-08-24T00:01:00+08:00", "2026-08-30T23:59:00+08:00"), true);
  assert.equal(isInCurrentShanghaiWeek("2026-08-23T23:59:00+08:00", "2026-08-24T08:00:00+08:00"), false);
});

test("0, 1, 26, and 100 students always produce mutually exclusive counts", () => {
  for (const size of [0, 1, 26, 100]) {
    const students = Array.from({ length: size }, (_, index) => ({
      primaryState: overviewStates[index % overviewStates.length],
    }));
    const counts = countOverviewStates(students);
    assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), size);
  }
});

test("resolution confirmation is mentor work and does not become a premature resolved claim", () => {
  const result = deriveStudentOverview(input({
    cadenceDays: 7,
    latestSubstantiveAt: "2026-07-01T00:00:00Z",
    resolutions: [{ id: 4, progressEntryId: 18, title: "困难 · 设备调试", occurredAt: "2026-08-23T00:00:00Z", status: "pending", canReview: true }],
  }), now);
  assert.equal(result.primaryState, "mentor");
  assert.equal(result.primaryReasonCode, "MENTOR_RESOLUTION_REVIEW");
  assert.equal(result.primaryAction, "review_resolution");
  assert.equal(result.primaryActionTargetId, 18);
  assert.equal(result.issues[0].sourceId, 4);
  assert.equal(result.issues[0].sourceType, "resolution");
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.counters, { actionableByMentor: 1, waitingForStudent: 0, blocked: 0, overdue: 0 });
  assert.doesNotMatch(result.primaryReasonLabel, /已解决|已完成/);
});

test("a returned resolution belongs to the student while a read-only pending result belongs to its mentor", () => {
  const fact = { id: 4, progressEntryId: 18, title: "后续计划 · 完成部署", occurredAt: "2026-08-23T00:00:00Z", status: "changes_requested", canReview: true };
  const returned = deriveStudentOverview(input({ resolutions: [fact] }), now);
  assert.equal(returned.primaryReasonCode, "STUDENT_RESOLUTION_CHANGES_REQUESTED");
  assert.equal(returned.primaryState, "student");
  assert.equal(returned.primaryAction, "view_resolution");
  assert.equal(returned.counters.waitingForStudent, 1);
  const pending = deriveStudentOverview(input({ cadenceDays: 7, latestSubstantiveAt: "2026-07-01T00:00:00Z", resolutions: [{ ...fact, status: "pending", canReview: false }] }), now);
  assert.equal(pending.nextOwner, "mentor");
  assert.equal(pending.primaryAction, "view_resolution");
  assert.equal(pending.counters.actionableByMentor, 0);
  assert.equal(pending.counters.waitingForStudent, 0);
  assert.equal(pending.issues.length, 1);
});
