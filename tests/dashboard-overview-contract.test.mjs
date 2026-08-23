import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMentorOverviewResponse,
  MENTOR_OVERVIEW_MAX_JSON_BYTES,
  mentorOverviewResponseJsonBytes,
} from "../lib/dashboard-overview/contract.ts";
import { overviewStates } from "../lib/dashboard-overview/types.ts";

const issueByState = {
  intervene: {
    code: "MILESTONE_BLOCKED",
    label: "培养节点受阻：完成跨材料验证",
    owner: "coordination",
    sourceType: "milestone",
    action: "resolve_blocker",
  },
  mentor: {
    code: "MENTOR_PROGRESS_REVIEW",
    label: "审核进展：补充消融实验",
    owner: "mentor",
    sourceType: "progress",
    action: "review_progress",
  },
  student: {
    code: "STUDENT_CHANGES_REQUESTED",
    label: "等待补交：补充对照实验",
    owner: "student",
    sourceType: "progress",
    action: "view_progress",
  },
  on_track: {
    code: "ON_TRACK_NEXT_ACTION",
    label: "下一行动明确：完成第三组实验",
    owner: "student",
    sourceType: "progress",
    action: "view_progress",
  },
  insufficient: {
    code: "INSUFFICIENT_NO_ACTION",
    label: "尚无可判断的明确下一行动",
    owner: "setup",
    sourceType: "profile",
    action: "complete_profile",
  },
};

function studentAt(index) {
  const primaryState = overviewStates[index % overviewStates.length];
  const fact = issueByState[primaryState];
  const studentId = `student-${String(index + 1).padStart(3, "0")}`;
  const issue = {
    code: fact.code,
    state: primaryState,
    label: fact.label,
    owner: fact.owner,
    dueDate: primaryState === "intervene" ? "2026-08-30" : null,
    occurredAt: "2026-08-24T00:00:00.000Z",
    sourceType: fact.sourceType,
    sourceId: primaryState === "insufficient" ? studentId : index + 1,
    action: fact.action,
    actionTargetId: primaryState === "insufficient" ? studentId : index + 1,
  };
  return {
    studentId,
    displayName: `测试学生${index + 1}`,
    degreeLevel: index % 2 ? "硕士" : "博士",
    grade: 2024,
    stage: "研究执行期",
    currentFocus: "完成当前实验并整理可核验结果",
    cadenceDays: 30,
    primaryState,
    primaryReasonCode: issue.code,
    primaryReasonLabel: issue.label,
    nextOwner: issue.owner,
    primaryAction: issue.action,
    primaryActionTargetId: issue.actionTargetId,
    issues: [issue],
    additionalIssueCount: 0,
    counters: {
      actionableByMentor: primaryState === "mentor" ? 1 : 0,
      waitingForStudent: primaryState === "student" ? 1 : 0,
      blocked: issue.code === "MILESTONE_BLOCKED" ? 1 : 0,
      overdue: 0,
    },
    latestSubstantiveTitle: null,
    latestSubstantiveAt: null,
    latestSubmittedAt: "2026-08-24T00:00:00.000Z",
    nextAction: primaryState === "on_track" ? "完成第三组实验" : null,
    nextActionDueDate: primaryState === "on_track" ? "2026-08-30" : null,
    paperPosition: null,
    projectPosition: null,
    recentSubstantive: [],
  };
}

function responseOf(size) {
  const students = Array.from({ length: size }, (_, index) => studentAt(index));
  const counts = Object.fromEntries(overviewStates.map((state) => [
    state,
    students.filter((student) => student.primaryState === state).length,
  ]));
  return {
    generatedAt: "2026-08-24T08:00:00.000Z",
    timezone: "Asia/Shanghai",
    total: students.length,
    counts,
    weeklySubstantiveStudentCount: 0,
    students,
  };
}

function clone(value) {
  return structuredClone(value);
}

test("0, 1, 26, and 100 students share one valid compact response contract", () => {
  for (const size of [0, 1, 26, 100]) {
    const response = responseOf(size);
    assert.doesNotThrow(() => assertMentorOverviewResponse(response), `${size} students`);
    assert.equal(Object.values(response.counts).reduce((sum, value) => sum + value, 0), size);
    assert.ok(mentorOverviewResponseJsonBytes(response) <= MENTOR_OVERVIEW_MAX_JSON_BYTES);
  }
});

test("structure and mutually exclusive counts must agree with students", () => {
  const missingField = clone(responseOf(1));
  delete missingField.students[0].stage;
  assert.throws(() => assertMentorOverviewResponse(missingField), /stage.*必填字段/);

  const wrongCount = clone(responseOf(1));
  wrongCount.counts.intervene += 1;
  assert.throws(() => assertMentorOverviewResponse(wrongCount), /counts\.intervene.*不一致/);

  const wrongTotal = clone(responseOf(1));
  wrongTotal.total = 2;
  assert.throws(() => assertMentorOverviewResponse(wrongTotal), /total.*students\.length/);
});

test("student IDs must be unique in one response", () => {
  const response = responseOf(2);
  response.students[1].studentId = response.students[0].studentId;
  assert.throws(() => assertMentorOverviewResponse(response), /studentId.*必须唯一/);
});

test("primary fields must describe issues[0] exactly", () => {
  const response = responseOf(1);
  response.students[0].primaryAction = "view_student";
  assert.throws(() => assertMentorOverviewResponse(response), /primaryAction.*issues\[0\].*一致/);

  const missingPrimary = responseOf(1);
  missingPrimary.students[0].issues = [];
  assert.throws(() => assertMentorOverviewResponse(missingPrimary), /至少一个主 issue/);
});

test("sensitive and deep payload fields are rejected recursively", () => {
  for (const field of ["feishu_open_id", "email", "attachments", "auditHistory", "snapshot_json", "reviewerNote"]) {
    const response = responseOf(1);
    response.students[0].issues[0][field] = "must-not-leave-the-server";
    assert.throws(
      () => assertMentorOverviewResponse(response),
      /禁止返回的敏感或深层字段/,
      field,
    );
  }
});

test("UTF-8 JSON larger than 250 KB fails the response-size gate", () => {
  const response = responseOf(1);
  response.students[0].currentFocus = "研".repeat(MENTOR_OVERVIEW_MAX_JSON_BYTES);
  assert.ok(mentorOverviewResponseJsonBytes(response) > MENTOR_OVERVIEW_MAX_JSON_BYTES);
  assert.throws(() => assertMentorOverviewResponse(response), /超过 250 KB 门禁/);
});

test("more than 100 students is outside the overview contract", () => {
  const response = responseOf(101);
  assert.throws(() => assertMentorOverviewResponse(response), /total.*不能超过 100/);
});
