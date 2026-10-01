import assert from "node:assert/strict";
import test from "node:test";

import { deriveStudentNextAction } from "../lib/student-next-action.ts";

const base = {
  now: new Date("2026-08-24T10:00:00+08:00"),
  cadenceDays: 14,
  currentFocus: "完成消融实验",
  proposal: { status: "approved", version: 1 },
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
  assert.equal(result.primary?.kind, "resolution");
  assert.equal(result.primary?.targetId, 10);
  assert.equal(result.primary?.itemKind, "next_action");
  assert.equal(result.primary?.destination, "resolution");
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
  assert.equal(result.primary?.targetId, 20);
  assert.equal(result.primary?.itemKind, "next_action");
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
  assert.equal(result.primary?.kind, "resolution");
  assert.equal(result.primary?.targetId, 31);
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

const oldProject = { id: 51, kind: "项目", title: "旧课题记录", submittedAt: "2026-08-20T01:00:00Z", reviewStatus: "accepted", reviewerNote: "", paper: null, project: { milestoneId: null, proposalVersion: null, nextAction: "旧行动", nextActionDueDate: "2026-08-20", blocker: "旧困难" } };
const linkedProject = { ...oldProject, id: 52, title: "最新节点进展", submittedAt: "2026-08-23T01:00:00Z", project: { ...oldProject.project, milestoneId: 9, proposalVersion: 1, nextAction: "最新安排", nextActionDueDate: "2026-09-20", blocker: "已解决" } };
const currentMilestone = { id: 9, title: "实验节点", targetDate: "2026-09-20", status: "in_progress" };

test("a new project baseline supersedes old general work even after the new node retires", () => {
  const input = { ...base, milestones: [currentMilestone], progress: [oldProject, linkedProject] };
  assert.equal(deriveStudentNextAction(input).primary.title, "最新安排");
  for (const patch of [
    { milestones: [{ ...currentMilestone, status: "completed" }] },
    { milestones: [] },
    { proposal: { status: "draft", version: 1 } },
    { proposal: { status: "approved", version: 2 } },
  ]) {
    const result = deriveStudentNextAction({ ...input, ...patch });
    assert.equal(result.candidates.some((item) => ["旧行动", "旧困难", "最新安排"].includes(item.title)), false);
  }
});

test("current resubmissions pause old actions, rejected records do not erase accepted difficulties", () => {
  const pending = { ...linkedProject, id: 53, reviewStatus: "submitted", submittedAt: "2026-08-24T08:00:00Z" };
  const input = { ...base, milestones: [currentMilestone], progress: [oldProject, pending] };
  assert.equal(deriveStudentNextAction(input).primary.kind, "waiting");
  const rejected = deriveStudentNextAction({ ...input, progress: [oldProject, { ...pending, reviewStatus: "rejected" }] });
  assert.equal(rejected.candidates.some((item) => item.title === "旧困难" && item.itemKind === "blocker"), true);
  const sameTime = { ...pending, submittedAt: oldProject.submittedAt };
  assert.equal(deriveStudentNextAction({ ...input, progress: [oldProject, sameTime] }).primary.kind, "waiting");
});

test("retired-node waits disappear from the work queue and real difficulties survive a nearby deadline", () => {
  for (const reviewStatus of ["submitted", "in_review", "changes_requested"]) {
    const result = deriveStudentNextAction({ ...base, milestones: [], progress: [{ ...linkedProject, reviewStatus }] });
    assert.equal(result.waitingCount, 0);
    assert.equal(result.candidates.length, 0);
    const withOldWork = deriveStudentNextAction({ ...base, milestones: [], progress: [oldProject, { ...linkedProject, reviewStatus }] });
    assert.equal(withOldWork.candidates.some((candidate) => candidate.title === "旧困难"), false);
  }
  const result = deriveStudentNextAction({ ...base, milestones: [{ ...currentMilestone, targetDate: "2026-08-25" }], progress: [{ ...linkedProject, project: { ...linkedProject.project, blocker: "缺关键设备，需导师协调" } }] });
  assert.equal(result.primary.kind, "resolution");
  assert.equal(result.primary.itemKind, "blocker");
  assert.equal(result.primary.title, "缺关键设备，需导师协调");
});


const resolutionProgress = {
  id: 70, currentRevision: 2, kind: "项目", title: "完成测试", submittedAt: "2026-08-20T08:00:00Z",
  reviewStatus: "accepted", reviewerNote: "", paper: null,
  project: { milestoneId: null, proposalVersion: null, nextAction: "整理测试结果", nextActionDueDate: "2026-08-22", blocker: "缺少测试数据" },
};
const resolutionRow = (kind, status, extra = {}) => ({
  id: 1, student_id: "s1", progress_entry_id: 70, revision_number: 2, item_kind: kind, status,
  version: 1, submission_note: "数据已整理", reviewer_note: "请补充具体结果", ...extra,
});

test("student can open the exact difficulty and overdue plan independently", () => {
  const result = deriveStudentNextAction({ ...base, progress: [resolutionProgress], resolutions: [] });
  assert.deepEqual(result.candidates.map((item) => [item.targetId, item.itemKind]).sort(), [[70, "blocker"], [70, "next_action"]]);
  assert.equal(result.candidates.every((item) => item.destination === "resolution"), true);
});

test("a submitted result waits for review; resolving a difficulty does not complete its plan", () => {
  const progress = [resolutionProgress];
  const result = deriveStudentNextAction({ ...base, progress, resolutions: [resolutionRow("blocker", "pending"), resolutionRow("next_action", "resolved")] });
  assert.equal(result.primary.waiting, true);
  assert.equal(result.primary.destination, "resolution");
  assert.equal(result.primary.targetId, 70);
  assert.equal(result.primary.itemKind, "blocker");
  assert.equal(result.waitingCount, 1);
  assert.equal(result.candidates.length, 0);
  const plan = deriveStudentNextAction({ ...base, progress, resolutions: [resolutionRow("blocker", "resolved")] });
  assert.equal(plan.primary.itemKind, "next_action");
});

test("returned results reopen their exact submission and stale resolution revisions never hide new work", () => {
  const returned = deriveStudentNextAction({ ...base, progress: [resolutionProgress], resolutions: [resolutionRow("blocker", "changes_requested")] });
  assert.equal(returned.primary.itemKind, "blocker");
  assert.equal(returned.primary.detail, "请补充具体结果");
  const stale = deriveStudentNextAction({ ...base, progress: [resolutionProgress], resolutions: [resolutionRow("blocker", "resolved", { revision_number: 1 })] });
  assert.equal(stale.candidates.some((item) => item.itemKind === "blocker"), true);
  const oldSource = deriveStudentNextAction({ ...base, progress: [{ ...resolutionProgress, id: 71 }], resolutions: [resolutionRow("blocker", "resolved")] });
  assert.equal(oldSource.candidates.some((item) => item.itemKind === "blocker"), true);
});

test("retired or superseded pending results never keep the student waiting", () => {
  const newer = { ...resolutionProgress, id: 72, reviewStatus: "submitted", submittedAt: "2026-08-23T08:00:00Z" };
  const result = deriveStudentNextAction({ ...base, progress: [resolutionProgress, newer], resolutions: [resolutionRow("blocker", "pending")] });
  assert.equal(result.primary.destination, "progress");
  assert.equal(result.primary.targetId, 72);
  assert.equal(result.waitingCount, 1);
});


test("a paused paper still shows an already submitted completion result waiting for confirmation", () => {
  const entry = { ...resolutionProgress, paper: { id: 3, title: "暂停论文", nextAction: "整理结果", nextActionDueDate: "2026-08-20", blocker: "" }, project: null };
  const result = deriveStudentNextAction({ ...base, progress: [entry], papers: [{ id: 3, title: "暂停论文", status: "on_hold", currentStage: "drafting" }], resolutions: [resolutionRow("next_action", "pending")] });
  assert.equal(result.waitingCount, 1);
  assert.equal(result.primary.destination, "resolution");
  assert.equal(result.primary.waiting, true);
});


test("mentor feedback on a never-submitted plan is actionable for the student", () => {
  const feedback = "补充对比实验，修改图表标注";
  const result = deriveStudentNextAction({ ...base, progress: [resolutionProgress], resolutions: [
    resolutionRow("blocker", "resolved"),
    resolutionRow("next_action", "changes_requested", { submitted_by_user_id: null, submitted_at: null, reviewer_note: feedback }),
  ] });
  assert.equal(result.primary.destination, "resolution"); assert.equal(result.primary.itemKind, "next_action");
  assert.equal(result.primary.detail, feedback); assert.equal(result.primary.waiting, false);
});
