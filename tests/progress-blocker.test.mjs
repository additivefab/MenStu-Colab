import assert from "node:assert/strict";
import test from "node:test";
import { activeBlockerText } from "../lib/progress-blocker.ts";
import { assembleMentorOverview } from "../lib/dashboard-overview/assemble.ts";
import { assertMentorOverviewResponse } from "../lib/dashboard-overview/contract.ts";
import { deriveStudentNextAction } from "../lib/student-next-action.ts";
import { instantTimestamp, isOverdueInShanghai } from "../lib/dashboard-overview/dates.ts";
import { paperDeadlineState } from "../lib/paper-progress.ts";
import { isCurrentResearchTrack } from "../lib/progress-track.ts";

test("explicit absence or resolution of difficulty is not a blocker, while mixed and unknown statements remain", () => {
  for (const value of [null, undefined, "", "   ", "无", "暂无困难", "目前没有阻塞", "已解决。", "问题已解决", "None", " No blockers. ", "Ｎ／Ａ"]) {
    assert.equal(activeBlockerText(value), "", String(value));
  }
  for (const value of ["无法复现", "暂无经费", "问题已解决，但设备仍未到位", "暂无困难，但仍需导师决定实验方案", "缺少对照数据", "等待导师反馈"]) {
    assert.equal(activeBlockerText(value), value);
  }
});

test("the same rule covers a full cohort and both personas without altering the stored statements", () => {
  const now = "2026-09-20T08:00:00Z";
  const input = { students: [], reviewableStudentIds: [], substantive: [], acceptedTracks: [], latestSubmitted: [], outstanding: [], proposals: [], milestones: [], guidance: [], papers: [] };
  const phrases = ["无", "暂无困难", "已解决", "设备未到位，需导师协调"];
  for (let index = 0; index < 26; index++) {
    const id = `student-${index}`;
    const blocker = phrases[index % phrases.length];
    input.students.push({ id, display_name: `学生${index}`, degree: "硕士", grade_year: 2024, stage: "研究执行期", cadence_days: 30, current_focus: "论文修改", tracking_started_at: null });
    input.acceptedTracks.push({ id: index + 1, student_id: id, track_type: "paper", track_key: `paper:${index + 1}`, next_action: "完成修改", next_action_due_date: "2026-08-31", blocker, current_revision_created_at: now, confirmed_at: now });
    const student = deriveStudentNextAction({ now: new Date(now), cadenceDays: 30, currentFocus: "论文修改", proposal: null, milestones: [], guidance: [], meetings: [], papers: [{ id: 1, title: "论文", status: "active" }], progress: [{ id: 1, kind: "论文", title: "论文", submittedAt: now, reviewStatus: "accepted", reviewerNote: "", project: null, paper: { id: 1, title: "论文", nextAction: "完成修改", nextActionDueDate: "2026-08-31", blocker } }] });
    assert.equal(student.primary.kind, "resolution");
    assert.equal(student.candidates.some((item) => item.itemKind === "blocker"), index % 4 === 3);
  }
  const before = structuredClone(input);
  const response = assembleMentorOverview(input, { id: 1, role: "superadmin" }, now);
  assert.doesNotThrow(() => assertMentorOverviewResponse(response));
  assert.equal(response.total, 26);
  assert.equal(response.students.filter((row) => row.primaryAction === "resolve_blocker").length, 6);
  assert.equal(response.students.filter((row) => row.primaryAction === "follow_up").length, 20);
  assert.equal(response.students.every((row) => row.counters.overdue === 1 && row.counters.actionableByMentor === 0), true);
  assert.deepEqual(input, before);
});

test("overdue checks reject invalid calendar dates and keep the Shanghai due date inclusive", () => {
  assert.equal(instantTimestamp("2026-09-20 08:00:00"), instantTimestamp("2026-09-20T08:00:00Z"));
  assert.ok(instantTimestamp("2026-09-20 08:00:00") > instantTimestamp("2026-09-20T07:59:59Z"));
  for (const value of ["2026-02-30", "2026-00-11", "2026-13-01", "2026-04-31", "", null]) {
    assert.equal(isOverdueInShanghai(value, "2026-09-20"), false);
    assert.equal(paperDeadlineState(value, new Date("2026-09-20")).overdue, false);
  }
  assert.equal(isOverdueInShanghai("2026-08-31", "2026-08-31T15:59:59Z"), false);
  assert.equal(isOverdueInShanghai("2026-08-31", "2026-08-31T16:00:00Z"), true);
});

test("all current-task surfaces can share lifecycle rules while history remains intact", () => {
  const context = { proposal: { status: "approved", version: 2 }, papers: [{ id: 1, status: "active" }], milestones: [{ id: 9, status: "completed" }, { id: 10, status: "in_progress" }] };
  assert.equal(isCurrentResearchTrack({ milestoneId: 9, proposalVersion: 2 }, context), false);
  assert.equal(isCurrentResearchTrack({ milestoneId: 10, proposalVersion: 1 }, context), false);
  assert.equal(isCurrentResearchTrack({ milestoneId: 99, proposalVersion: 2 }, context), false);
  assert.equal(isCurrentResearchTrack({ paperId: 2 }, context), false);
  assert.equal(isCurrentResearchTrack({ paperId: 1 }, context), true);
  assert.equal(isCurrentResearchTrack({ milestoneId: 10, proposalVersion: 2 }, context), true);
  assert.equal(isCurrentResearchTrack({ paperId: 0 }, context), true);
});
