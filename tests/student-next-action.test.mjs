import assert from "node:assert/strict";
import test from "node:test";

import { deriveStudentNextAction } from "../lib/student-next-action.ts";

const base = {
  now: new Date("2026-08-24T10:00:00+08:00"),
  cadenceDays: 14,
  currentFocus: "完成消融实验",
  progress: [],
  papers: [],
  milestones: [],
  guidance: [],
  meetings: [],
};

test("returned evidence outranks every other student action and reports remaining count", () => {
  const result = deriveStudentNextAction({
    ...base,
    progress: [
      { id: 8, kind: "论文", title: "补充图 4", submittedAt: "2026-08-23T08:00:00Z", reviewStatus: "changes_requested", reviewerNote: "补原始数据", paper: null, project: null },
    ],
    guidance: [
      { id: 2, title: "重跑基线", nextAction: "重跑基线", dueDate: "2026-08-20", status: "open", acknowledgedAt: null, studentReportedAt: null },
    ],
  });
  assert.equal(result.primary?.kind, "supplement");
  assert.equal(result.primary?.targetId, 8);
  assert.equal(result.additionalActionCount, 1);
});

test("waiting review is context, never a duplicate submit action", () => {
  const result = deriveStudentNextAction({
    ...base,
    progress: [
      { id: 4, kind: "项目", title: "完成第一轮实验", submittedAt: "2026-08-24T01:00:00Z", reviewStatus: "submitted", reviewerNote: "", paper: null, project: { nextAction: "继续提交同一结果", nextActionDueDate: "2026-08-24", blocker: "" } },
    ],
  });
  assert.equal(result.primary?.kind, "waiting");
  assert.equal(result.waitingCount, 1);
  assert.equal(result.additionalActionCount, 0);
});

test("on-hold paper is not selected as an actionable paper", () => {
  const result = deriveStudentNextAction({
    ...base,
    papers: [{ id: 3, title: "暂停论文", status: "on_hold", currentStage: "drafting" }],
    progress: [
      { id: 3, kind: "论文", title: "旧稿", submittedAt: "2026-07-20T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: { id: 3, title: "暂停论文", nextAction: "继续写", nextActionDueDate: "2026-08-20", blocker: "" }, project: null },
    ],
  });
  assert.notEqual(result.primary?.kind, "paper");
});

test("blocked milestone outranks a routine due-soon paper action", () => {
  const result = deriveStudentNextAction({
    ...base,
    papers: [{ id: 1, title: "论文 A", status: "active", currentStage: "drafting" }],
    progress: [
      { id: 1, kind: "论文", title: "论文更新", submittedAt: "2026-08-22T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: { id: 1, title: "论文 A", nextAction: "修改讨论", nextActionDueDate: "2026-08-26", blocker: "" }, project: null },
    ],
    milestones: [{ id: 5, title: "完成现场试验", targetDate: "2026-09-01", status: "blocked" }],
  });
  assert.equal(result.primary?.kind, "meeting");
  assert.equal(result.primary?.targetId, 5);
});

test("one paper waiting for review does not hide another active paper that is overdue", () => {
  const result = deriveStudentNextAction({
    ...base,
    papers: [
      { id: 1, title: "论文 A", status: "active", currentStage: "drafting" },
      { id: 2, title: "论文 B", status: "active", currentStage: "drafting" },
    ],
    progress: [
      { id: 11, kind: "论文", title: "A 新提交", submittedAt: "2026-08-24T01:00:00Z", reviewStatus: "submitted", reviewerNote: "", paper: { id: 1, title: "论文 A", nextAction: "等待审核", nextActionDueDate: "2026-08-30", blocker: "" }, project: null },
      { id: 10, kind: "论文", title: "B 已确认", submittedAt: "2026-08-20T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: { id: 2, title: "论文 B", nextAction: "补讨论章节", nextActionDueDate: "2026-08-20", blocker: "" }, project: null },
    ],
  });
  assert.equal(result.primary?.kind, "paper");
  assert.equal(result.primary?.targetId, 2);
  assert.equal(result.primary?.destination, "paper");
  assert.equal(result.waitingCount, 1);
});

test("all active papers enter the comparator instead of only the newest paper", () => {
  const result = deriveStudentNextAction({
    ...base,
    papers: [
      { id: 1, title: "论文 A", status: "active", currentStage: "drafting" },
      { id: 2, title: "论文 B", status: "active", currentStage: "drafting" },
    ],
    progress: [
      { id: 21, kind: "论文", title: "A", submittedAt: "2026-08-23T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: { id: 1, title: "论文 A", nextAction: "整理附录", nextActionDueDate: "2026-09-10", blocker: "" }, project: null },
      { id: 20, kind: "论文", title: "B", submittedAt: "2026-08-10T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: { id: 2, title: "论文 B", nextAction: "补实验", nextActionDueDate: "2026-08-20", blocker: "" }, project: null },
    ],
  });
  assert.equal(result.primary?.targetId, 2);
  assert.equal(result.additionalActionCount, 1);
});

test("an overdue action outranks a blocked but not overdue milestone", () => {
  const result = deriveStudentNextAction({
    ...base,
    papers: [{ id: 1, title: "论文 A", status: "active", currentStage: "drafting" }],
    progress: [
      { id: 31, kind: "论文", title: "A", submittedAt: "2026-08-20T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: { id: 1, title: "论文 A", nextAction: "提交修订稿", nextActionDueDate: "2026-08-22", blocker: "" }, project: null },
    ],
    milestones: [{ id: 7, title: "等待设备", targetDate: "2026-09-10", status: "blocked" }],
  });
  assert.equal(result.primary?.kind, "paper");
  assert.equal(result.primary?.targetId, 1);
});

test("a confirmed meeting links to the meeting desk instead of the progress feed", () => {
  const result = deriveStudentNextAction({
    ...base,
    meetings: [{ id: 9, topic: "讨论下一轮实验", preferredDate: "2026-08-26", preferredTime: "10:00", status: "confirmed" }],
  });
  assert.equal(result.primary?.kind, "waiting");
  assert.equal(result.primary?.destination, "meeting");
  assert.equal(result.primary?.targetId, 9);
  assert.equal(result.primary?.kicker, "预约已确认");
});

test("a guidance action preserves the exact guidance target", () => {
  const result = deriveStudentNextAction({
    ...base,
    guidance: [{ id: 12, title: "补基线", nextAction: "补跑基线", dueDate: "2026-08-25", status: "open", acknowledgedAt: null, studentReportedAt: null }],
  });
  assert.equal(result.primary?.destination, "guidance");
  assert.equal(result.primary?.targetId, 12);
});

test("only the newest unlinked project record owns the general project action", () => {
  const result = deriveStudentNextAction({
    ...base,
    progress: [
      { id: 42, kind: "项目", title: "最新课题记录", submittedAt: "2026-08-23T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: null, project: { milestoneId: null, nextAction: "整理最新实验结果", nextActionDueDate: "2026-09-10", blocker: "" } },
      { id: 41, kind: "项目", title: "旧课题记录", submittedAt: "2026-08-20T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: null, project: { milestoneId: null, nextAction: "已被后续记录取代的旧行动", nextActionDueDate: "2026-08-20", blocker: "" } },
    ],
  });
  assert.equal(result.primary?.id, "project-42");
  assert.equal(result.primary?.title, "整理最新实验结果");
  assert.equal(result.candidates.some((candidate) => candidate.id === "project-41"), false);
});

test("an accepted project record cannot revive a completed milestone", () => {
  const result = deriveStudentNextAction({
    ...base,
    milestones: [{ id: 9, title: "已完成节点", targetDate: null, status: "completed" }],
    progress: [
      { id: 43, kind: "项目", title: "节点历史记录", submittedAt: "2026-08-23T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: null, project: { milestoneId: 9, nextAction: "不应继续催办", nextActionDueDate: "2026-08-20", blocker: "" } },
    ],
  });
  assert.equal(result.candidates.some((candidate) => candidate.targetId === 9), false);
  assert.equal(result.primary?.kind, "onboarding");
});

test("routine paper and project actions outrank a new non-urgent guidance acknowledgement", () => {
  const result = deriveStudentNextAction({
    ...base,
    papers: [{ id: 1, title: "论文 A", status: "active", currentStage: "drafting" }],
    progress: [
      { id: 44, kind: "论文", title: "论文记录", submittedAt: "2026-08-23T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: { id: 1, title: "论文 A", nextAction: "完成论文正常下一步", nextActionDueDate: "2026-09-20", blocker: "" }, project: null },
      { id: 45, kind: "项目", title: "课题记录", submittedAt: "2026-08-22T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: null, project: { milestoneId: null, nextAction: "完成课题正常下一步", nextActionDueDate: "2026-09-21", blocker: "" } },
    ],
    guidance: [{ id: 13, title: "新指导", nextAction: "确认收到远期指导", dueDate: "2026-09-30", status: "open", acknowledgedAt: null, studentReportedAt: null }],
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.kind), ["paper", "project", "guidance"]);
  assert.equal(result.primary?.targetId, 1);
});

test("due-soon guidance remains urgent even when it has not been acknowledged", () => {
  const result = deriveStudentNextAction({
    ...base,
    papers: [{ id: 1, title: "论文 A", status: "active", currentStage: "drafting" }],
    progress: [
      { id: 46, kind: "论文", title: "论文记录", submittedAt: "2026-08-23T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: { id: 1, title: "论文 A", nextAction: "论文正常下一步", nextActionDueDate: "2026-09-20", blocker: "" }, project: null },
    ],
    guidance: [{ id: 14, title: "临期指导", nextAction: "今周补跑对照实验", dueDate: "2026-08-28", status: "open", acknowledgedAt: null, studentReportedAt: null }],
  });
  assert.equal(result.primary?.kind, "guidance");
  assert.equal(result.primary?.targetId, 14);
});
