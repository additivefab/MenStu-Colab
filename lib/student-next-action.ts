import { calendarDayDiff, daysSinceInShanghai, instantTimestamp, shanghaiDateKey } from "./dashboard-overview/dates.ts";
import { activeBlockerText } from "./progress-blocker.ts";
import { isCurrentResearchTrack } from "./progress-track.ts";

type ProgressStatus = "submitted" | "in_review" | "accepted" | "changes_requested" | "rejected";

export type StudentNextActionInput = {
  now: Date;
  cadenceDays: number;
  currentFocus: string;
  proposal: { status: string; version: number } | null;
  progress: Array<{
    id: number;
    kind: string;
    title: string;
    submittedAt: string;
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

export type StudentActionKind = "supplement" | "guidance" | "paper" | "project" | "meeting" | "waiting" | "onboarding";
export type StudentActionDestination = "supplement" | "guidance" | "paper" | "project" | "meeting" | "progress";

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
  for (const paper of input.papers.filter((item) => item.status === "active")) {
    const latestPaper = sortedProgress.find((entry) => entry.paper?.id === paper.id && entry.reviewStatus === "accepted");
    if (!latestPaper?.paper || hasNewerSubmission(latestPaper)) continue;
    const due = dueState(latestPaper.paper.nextActionDueDate || null, input.now);
    const blocker = activeBlockerText(latestPaper.paper.blocker);
    const action = latestPaper.paper.nextAction.trim();
    if (blocker || action) {
      candidates.push({
        id: `paper-${paper.id}`,
        priority: blocker ? 31 : due.overdue ? 24 : 70,
        kind: blocker ? "meeting" : "paper",
        destination: blocker ? "meeting" : "paper",
        kicker: blocker ? "论文推进受阻" : due.overdue ? "论文行动已逾期" : "论文下一行动",
        title: blocker || action,
        detail: latestPaper.paper.title,
        meta: latestPaper.paper.nextActionDueDate ? `${latestPaper.paper.nextActionDueDate} · ${due.label}` : "完成后记录论文进展",
        dueDate: latestPaper.paper.nextActionDueDate || null,
        targetId: paper.id,
        attention: Boolean(blocker || due.overdue),
        waiting: false,
      });
    }
  }

  // Select the accepted project baseline before lifecycle checks so a retired
  // milestone cannot uncover an older, superseded general-project action.
  const latestProject = sortedProgress.find((entry) => entry.project && entry.reviewStatus === "accepted");
  if (latestProject?.project && isCurrentTrack(latestProject) && !hasNewerSubmission(latestProject)) {
    const authoritativeMilestone = latestProject.project.milestoneId
      ? currentMilestones.find((item) => item.id === latestProject.project?.milestoneId)
      : null;
    const due = dueState(latestProject.project.nextActionDueDate || null, input.now);
    const blocker = activeBlockerText(latestProject.project.blocker);
    const action = latestProject.project.nextAction.trim();
    const milestoneDue = dueState(authoritativeMilestone?.targetDate ?? null, input.now);
    const coveredByMilestone = authoritativeMilestone?.status === "blocked"
      || (!blocker && (milestoneDue.overdue || (milestoneDue.days !== null && milestoneDue.days <= 7)));
    if ((blocker || action) && !coveredByMilestone) {
      candidates.push({
        id: latestProject.project.milestoneId ? `project-milestone-${latestProject.project.milestoneId}` : `project-${latestProject.id}`,
        priority: blocker ? 32 : due.overdue ? 25 : 72,
        kind: blocker ? "meeting" : "project",
        destination: blocker ? "meeting" : "project",
        kicker: blocker ? "课题推进受阻" : due.overdue ? "课题行动已逾期" : "课题下一行动",
        title: blocker || action,
        detail: latestProject.title,
        meta: latestProject.project.nextActionDueDate ? `${latestProject.project.nextActionDueDate} · ${due.label}` : "完成后记录课题进展",
        dueDate: latestProject.project.nextActionDueDate || null,
        targetId: latestProject.project.milestoneId ?? undefined,
        attention: Boolean(blocker || due.overdue),
        waiting: false,
      });
    }
  }

  const waitingGuidance = input.guidance.filter((note) => note.status === "open" && Boolean(note.studentReportedAt));
  const waitingMeetings = input.meetings.filter((meeting) => meeting.status === "requested" || meeting.status === "confirmed");
  const waitingCount = waitingProgress.length + waitingGuidance.length + waitingMeetings.length;
  const actionable = candidates.filter((candidate) => !candidate.waiting).sort(compareCandidates);
  let primary = actionable[0] ?? null;

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
