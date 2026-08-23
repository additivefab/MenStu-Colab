import assert from "node:assert/strict";
import test from "node:test";

import { deriveStudentOverview } from "../lib/dashboard-overview/derive.ts";
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

test("blocked milestone outranks mentor review and preserves the additional issue", () => {
  const result = deriveStudentOverview(input({
    milestones: [{ id: 9, title: "完成跨材料验证", targetDate: "2026-08-28", status: "blocked", updatedAt: "2026-08-22T00:00:00Z" }],
    mentorReviews: [{ id: 31, title: "补充消融实验", occurredAt: "2026-08-23T00:00:00Z", kind: "progress" }],
  }), now);

  assert.equal(result.primaryState, "intervene");
  assert.equal(result.primaryReasonCode, "MILESTONE_BLOCKED");
  assert.equal(result.additionalIssueCount, 2);
  assert.ok(result.issues.some((issue) => issue.code === "MENTOR_PROGRESS_REVIEW"));
  assert.equal(result.counters.actionableByMentor, 1);
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
