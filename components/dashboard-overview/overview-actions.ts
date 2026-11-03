import type { MentorOverviewStudent, OverviewOwner } from "../../lib/dashboard-overview/types";

export const overviewOwnerLabels: Record<OverviewOwner, string> = {
  mentor: "导师",
  student: "学生",
  coordination: "共同处理",
  setup: "补齐档案",
};

export function overviewActionLabel(student: MentorOverviewStudent) {
  switch (student.primaryAction) {
    case "resolve_blocker": return "查看问题记录";
    case "follow_up": return student.issues[0]?.sourceType === "milestone" ? "跟进节点"
      : student.issues[0]?.sourceType === "guidance" ? "跟进指导" : "跟进下一步";
    case "review_progress": return "立即审核";
    case "review_resolution": return "确认处理结果";
    case "view_resolution": return student.primaryReasonCode === "STUDENT_RESOLUTION_CHANGES_REQUESTED" ? "查看待补充" : "查看处理结果";
    case "review_proposal": return "审核方案";
    case "verify_guidance": return "核对验收";
    case "view_guidance": return "查看指导";
    case "view_progress": return student.primaryReasonCode === "STUDENT_CHANGES_REQUESTED" ? "查看待补交" : "查看进展";
    case "view_proposal": return "查看待修改";
    case "complete_profile": return "查看档案缺口";
    default: return "查看";
  }
}

export function overviewActionHref(student: MentorOverviewStudent) {
  const studentPath = `/students/${encodeURIComponent(student.studentId)}`;
  const primaryIssue = student.issues[0];
  const target = Number(student.primaryActionTargetId);
  const targetId = Number.isInteger(target) && target > 0 ? target : null;
  switch (student.primaryAction) {
    case "review_progress": return targetId ? `${studentPath}#review-progress-${targetId}` : `${studentPath}#formal-review`;
    case "review_proposal": {
      return targetId
        ? `/?mentorView=research&researchTab=proposals&proposal=${targetId}`
        : `${studentPath}#proposal`;
    }
    case "view_proposal": return targetId
      ? `/?mentorView=research&researchTab=proposals&proposal=${targetId}`
      : `${studentPath}#proposal`;
    case "verify_guidance":
    case "view_guidance": return targetId ? `${studentPath}#guidance-${targetId}` : `${studentPath}#guidance`;
    case "review_resolution":
    case "view_resolution": return targetId && (primaryIssue?.resolutionKind === "blocker" || primaryIssue?.resolutionKind === "next_action")
      ? `${studentPath}#progress-resolution-${targetId}-${primaryIssue.resolutionKind}`
      : `${studentPath}#${student.primaryReasonCode === "STUDENT_RESOLUTION_CHANGES_REQUESTED" ? "tasks" : "tasks-pending"}`;
    case "view_progress": return targetId ? `${studentPath}#progress-${targetId}` : `${studentPath}#evidence`;
    case "resolve_blocker": return `/?mentorView=issues&issueStudent=${encodeURIComponent(student.studentId)}`;
    case "follow_up": {
      if (!targetId) return `${studentPath}#outlook`;
      if (primaryIssue?.sourceType === "milestone") return `${studentPath}#milestone-${targetId}`;
      if (primaryIssue?.sourceType === "guidance") return `${studentPath}#guidance-${targetId}`;
      if (primaryIssue?.sourceType === "paper" || primaryIssue?.sourceType === "progress") {
        return `${studentPath}#progress-resolution-${targetId}-next_action`;
      }
      return `${studentPath}#progress-${targetId}`;
    }
    case "complete_profile":
    case "view_student":
    default: return `${studentPath}#outlook`;
  }
}

export function overviewDate(value: string | null, withYear = false) {
  if (!value) return "暂无";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(withYear ? { year: "numeric" as const } : {}),
    month: "numeric",
    day: "numeric",
  }).format(date);
}
