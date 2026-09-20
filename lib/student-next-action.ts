import { calendarDayDiff, daysSinceInShanghai, instantTimestamp, shanghaiDateKey } from "./dashboard-overview/dates.ts";
import { activeBlockerText } from "./progress-blocker.ts";
import { isCurrentResearchTrack } from "./progress-track.ts";
import type { ProgressResolutionKind, ProgressResolutionRow } from "./progress-resolution.ts";

type ProgressStatus = "submitted" | "in_review" | "accepted" | "changes_requested" | "rejected";

export type StudentNextActionInput = {
  now: Date;
  cadenceDays: number;
  currentFocus: string;
  resolutions?: ProgressResolutionRow[];
  proposal: { status: string; version: number } | null;
  progress: Array<{
    id: number;
    kind: string;
    title: string;
    submittedAt: string;
    currentRevision?: number;
    reviewStatus: ProgressStatus;
    reviewerNote: string;
    paper: null | { id: number; title: string; nextAction: string; nextActionDueDate: string; blocker: string };
    project: null | { milestoneId: number | null; proposalVersion: number | null; nextAction: string; nextActionDueDate: string; blocker: string };
  }>;
  papers: Array<{ id: number; title: string; status: string; currentStage: string }>;
  milestones: Array<{ id: number; title: string; targetDate: string | null; status: string }>;
  guidance: Array<{
    id: number;
    title: string;
    nextAction: string;
    dueDate: string | null;
    status: string;
    acknowledgedAt: string | null;
    studentReportedAt: string | null;
  }>;
  meetings: Array<{ id: number; topic: string; preferredDate: string; preferredTime: string; status: string }>;
};

export type StudentActionKind = "supplement" | "guidance" | "paper" | "project" | "meeting" | "waiting" | "onboarding" | "resolution";
export type StudentActionDestination = "supplement" | "guidance" | "paper" | "project" | "meeting" | "progress" | "resolution";

export type StudentActionCandidate = {
  id: string;
  priority: number;
  kind: StudentActionKind;
  destination: StudentActionDestination;
  kicker: string;
  title: string;
  detail: string;
  meta: string;
  dueDate: string | null;
  targetId?: number;
  itemKind?: ProgressResolutionKind;
  attention: boolean;
  waiting: boolean;
};

function dueState(value: string | null, now: Date) {
  if (!value) return { overdue: false, days: null as number | null, label: "未设置期限" };
  const today = shanghaiDateKey(now);
  const days = today ? calendarDayDiff(value, today) : null;
  if (days === null) return { overdue: false, days, label: "期限格式无效" };
  if (days < 0) return { overdue: true, days, label: `逾期 ${Math.abs(days)} 天` };
  if (days === 0) return { overdue: false, days, label: "今天到期" };
  return { overdue: false, days, label: `${days} 天后` };
}

function compareCandidates(left: StudentActionCandidate, right: StudentActionCandidate) {
  return left.priority - right.priority
    || (left.dueDate === right.dueDate ? 0 : left.dueDate === null ? 1 : right.dueDate === null ? -1 : left.dueDate.localeCompare(right.dueDate))
    || left.id.localeCompare(right.id);
}

export function deriveStudentNextAction(input: StudentNextActionInput) {
  const candidates: StudentActionCandidate[] = [];
  const waitingResolutions: StudentActionCandidate[] = [];
  const sortedProgress = [...input.progress].sort((a, b) => (
    instantTimestamp(b.submittedAt) - instantTimestamp(a.submittedAt) || b.id - a.id
  ));
  const currentMilestones = input.proposal?.status === "approved" ? input.milestones : [];
  function isCurrentTrack(entry: StudentNextActionInput["progress"][number]) {
    return isCurrentResearchTrack({ paperId: entry.paper?.id, milestoneId: entry.project?.milestoneId, proposalVersion: entry.project?.proposalVersion }, input);
  }
  const currentProgress = sortedProgress.filter(isCurrentTrack);
  const outstanding = sortedProgress.filter((entry) => ["submitted", "in_review", "changes_requested"].includes(entry.reviewStatus));
  function hasNewerSubmission(accepted: StudentNextActionInput["progress"][number]) {
    return outstanding.some((entry) => (
      (accepted.paper ? entry.paper?.id === accepted.paper.id : Boolean(entry.project))
      && sortedProgress.indexOf(entry) < sortedProgress.indexOf(accepted)
    ));
  }

  for (const entry of currentProgress) {
    if ((entry.kind === "论文" || entry.kind === "项目") && entry.reviewStatus === "changes_requested") {
      candidates.push({
        id: `supplement-${entry.id}`,
        priority: 10,
        kind: "supplement",
        destination: "supplement",
        kicker: "导师已退回 · 需要补证",
        title: entry.paper?.title || entry.title,
        detail: entry.reviewerNote || "按导师意见补充结论、证据或附件后重新提交。",
        meta: "重新提交会生成新版本，原记录继续保留",
        dueDate: null,
        targetId: entry.id,
        attention: true,
        waiting: false,
      });
    }
  }

  for (const note of input.guidance.filter((item) => item.status === "open" && !item.studentReportedAt)) {
    const due = dueState(note.dueDate, input.now);
    candidates.push({
      id: `guidance-${note.id}`,
      priority: due.overdue ? 20 : due.days !== null && due.days <= 7 ? 55 : !note.acknowledgedAt ? 80 : 75,
      kind: "guidance",
      destination: "guidance",
      kicker: due.overdue ? "导师行动已逾期" : !note.acknowledgedAt ? "有一条新导师指导" : "导师给你的下一步",
      title: note.nextAction || note.title || "查看导师指导",
      detail: note.title || "完成后提交说明，等待导师验收。",
      meta: note.dueDate ? `${note.dueDate} · ${due.label}` : due.label,
      dueDate: note.dueDate,
      targetId: note.id,
      attention: due.overdue,
      waiting: false,
    });
  }

  for (const milestone of currentMilestones.filter((item) => item.status !== "completed")) {
    const due = dueState(milestone.targetDate, input.now);
    if (milestone.status === "blocked") {
      candidates.push({
        id: `milestone-blocked-${milestone.id}`,
        priority: 30,
        kind: "meeting",
        destination: "meeting",
        kicker: "培养节点受阻",
        title: milestone.title,
        detail: "把需要的判断、资源或协作写清楚，并和导师确认。",
        meta: milestone.targetDate ? `${milestone.targetDate} · ${due.label}` : "建议预约导师解决阻塞",
        dueDate: milestone.targetDate,
        targetId: milestone.id,
        attention: true,
        waiting: false,
      });
    } else if (due.overdue || (due.days !== null && due.days <= 7)) {
      candidates.push({
        id: `milestone-${milestone.id}`,
        priority: due.overdue ? 22 : 60,
        kind: "project",
        destination: "project",
        kicker: due.overdue ? "培养节点已逾期" : "培养节点即将到期",
        title: milestone.title,
        detail: input.currentFocus || "围绕节点形成一项可核验成果。",
        meta: milestone.targetDate ? `${milestone.targetDate} · ${due.label}` : due.label,
        dueDate: milestone.targetDate,
        targetId: milestone.id,
        attention: due.overdue,
        waiting: false,
      });
    }
  }

  const waitingProgress = currentProgress.filter((entry) => entry.reviewStatus === "submitted" || entry.reviewStatus === "in_review");
  function addTrackActions(entry: StudentNextActionInput["progress"][number], allowRoutine = true) {
    const track = entry.paper ?? entry.project;
    if (!track) return;
    const isPaper = Boolean(entry.paper);
    const due = dueState(track.nextActionDueDate || null, input.now);
    for (const itemKind of ["blocker", "next_action"] as const) {
      const text = itemKind === "blocker" ? activeBlockerText(track.blocker) : track.nextAction.trim();
      if (!text) continue;
      const state = input.resolutions?.find((item) => item.progress_entry_id === entry.id
        && item.revision_number === (entry.currentRevision ?? 1) && item.item_kind === itemKind);
      if (state?.status === "resolved") continue;
      const blocking = itemKind === "blocker";
      const pending = state?.status === "pending";
      const returned = state?.status === "changes_requested";
      if (blocking || pending || returned || (allowRoutine && due.overdue)) {
        const candidate: StudentActionCandidate = {
          id: `resolution-${entry.id}-${itemKind}`,
          priority: returned ? 12 : blocking ? 31 : 24,
          kind: pending ? "waiting" : "resolution", destination: "resolution",
          kicker: pending ? "处理结果待确认" : returned ? "处理结果需要补充" : blocking ? "困难待处理" : "计划已逾期",
          title: text,
          detail: returned ? state.reviewer_note : pending ? "已提交处理结果，等待管理员确认。" : entry.paper?.title || entry.title,
          meta: blocking ? "解决后提交说明，管理员确认后关闭提醒" : track.nextActionDueDate ? `${track.nextActionDueDate} · ${due.label}` : "完成后提交结果",
          dueDate: blocking ? null : track.nextActionDueDate || null,
          targetId: entry.id, itemKind, attention: !pending, waiting: pending,
        };
        if (pending) waitingResolutions.push(candidate);
        else candidates.push(candidate);
      } else if (allowRoutine) {
        candidates.push({
          id: isPaper ? `paper-${entry.paper!.id}` : entry.project?.milestoneId ? `project-milestone-${entry.project.milestoneId}` : `project-${entry.id}`,
          priority: isPaper ? 70 : 72, kind: isPaper ? "paper" : "project", destination: isPaper ? "paper" : "project",
          kicker: isPaper ? "论文下一行动" : "课题下一行动", title: text,
          detail: entry.paper?.title || entry.title,
          meta: track.nextActionDueDate ? `${track.nextActionDueDate} · ${due.label}` : "完成后记录进展",
          dueDate: track.nextActionDueDate || null,
          targetId: entry.paper?.id ?? entry.project?.milestoneId ?? undefined,
          attention: false, waiting: false,
        });
      }
    }
  }
  for (const paper of input.papers.filter((item) => item.status === "active" || item.status === "on_hold")) {
    const latestPaper = sortedProgress.find((entry) => entry.paper?.id === paper.id && entry.reviewStatus === "accepted");
    if (!latestPaper?.paper || hasNewerSubmission(latestPaper)) continue;
    addTrackActions(latestPaper, paper.status === "active");
  }

  // Choose the baseline before lifecycle checks so retired work cannot uncover an older plan.
  const latestProject = sortedProgress.find((entry) => entry.project && entry.reviewStatus === "accepted");
  if (latestProject?.project && isCurrentTrack(latestProject) && !hasNewerSubmission(latestProject)) {
    const milestone = currentMilestones.find((item) => item.id === latestProject.project?.milestoneId);
    const milestoneDue = dueState(milestone?.targetDate ?? null, input.now);
    const covered = milestone?.status === "blocked" || milestoneDue.overdue || (milestoneDue.days !== null && milestoneDue.days <= 7);
    addTrackActions(latestProject, !covered);
  }

  const waitingGuidance = input.guidance.filter((note) => note.status === "open" && Boolean(note.studentReportedAt));
  const waitingMeetings = input.meetings.filter((meeting) => meeting.status === "requested" || meeting.status === "confirmed");
  const waitingCount = waitingProgress.length + waitingGuidance.length + waitingMeetings.length + waitingResolutions.length;
  const actionable = candidates.filter((candidate) => !candidate.waiting).sort(compareCandidates);
  let primary = actionable[0] ?? null;

  if (!primary && waitingResolutions.length) primary = waitingResolutions[0];

  if (!primary && waitingCount) {
    const waitingProgressEntry = waitingProgress[0];
    const guidanceEntry = waitingGuidance[0];
    const meetingEntry = waitingMeetings[0];
    const meetingConfirmed = meetingEntry?.status === "confirmed";
    primary = {
      id: "waiting",
      priority: 90,
      kind: "waiting",
      destination: waitingProgressEntry ? "progress" : guidanceEntry ? "guidance" : "meeting",
      kicker: meetingConfirmed && !waitingProgressEntry && !guidanceEntry ? "预约已确认" : "已提交 · 等待导师",
      title: waitingProgressEntry?.title || guidanceEntry?.title || meetingEntry?.topic || "导师正在处理你的提交",
      detail: meetingConfirmed && !waitingProgressEntry && !guidanceEntry
        ? "按确认时间参加会议；如需调整，可在预约记录中取消后重新提交。"
        : "当前不需要重复提交；有结果后这里会自动更新。",
      meta: meetingEntry && !waitingProgressEntry && !guidanceEntry
        ? `${meetingEntry.preferredDate} ${meetingEntry.preferredTime}`
        : `共有 ${waitingCount} 项等待导师`,
      dueDate: null,
      targetId: waitingProgressEntry?.id ?? guidanceEntry?.id ?? meetingEntry?.id,
      attention: false,
      waiting: true,
    };
  }

  if (!primary) {
    const latestSubmission = sortedProgress[0]?.submittedAt ?? null;
    const elapsed = daysSinceInShanghai(latestSubmission, input.now);
    primary = {
      id: "onboarding",
      priority: 100,
      kind: "onboarding",
      destination: input.papers.some((paper) => paper.status === "active") ? "paper" : "project",
      kicker: sortedProgress.length ? "保持科研节奏" : "从第一条记录开始",
      title: input.currentFocus || "记录下一项可核验进展",
      detail: `建议每 ${input.cadenceDays} 天至少更新一次。`,
      meta: elapsed === null ? "完成后记录论文或课题进展" : `距上次记录 ${elapsed} 天`,
      dueDate: null,
      attention: elapsed !== null && elapsed > input.cadenceDays,
      waiting: false,
    };
  }

  return {
    primary,
    additionalActionCount: Math.max(0, actionable.length - (primary.waiting ? 0 : 1)),
    waitingCount,
    candidates: actionable,
  };
}
