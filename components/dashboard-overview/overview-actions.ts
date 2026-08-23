import type { MentorOverviewStudent, OverviewOwner } from "../../lib/dashboard-overview/types";

export const overviewOwnerLabels: Record<OverviewOwner, string> = {
  mentor: "导师",
  student: "学生",
  coordination: "共同处理",
  setup: "补齐档案",
};

export function overviewActionLabel(student: MentorOverviewStudent) {
  switch (student.primaryAction) {
    case "resolve_blocker": return "处理阻塞";
    case "review_progress": return "立即审核";
    case "review_proposal": return "审核方案";
    case "verify_guidance": return "核对验收";
    case "view_guidance": return "查看指导";
    case "view_progress": return "查看待补交";
    case "complete_profile": return "补齐信息";
    default: return "查看";
  }
}

export function overviewActionHref(student: MentorOverviewStudent) {
  const studentPath = `/students/${encodeURIComponent(student.studentId)}`;
  const primaryIssue = student.issues[0];
  switch (student.primaryAction) {
    case "review_progress": return `${studentPath}#formal-review`;
    case "review_proposal": {
      const target = Number(student.primaryActionTargetId);
      return Number.isInteger(target) && target > 0
        ? `/?mentorView=research&researchTab=proposals&proposal=${target}`
        : `${studentPath}#proposal`;
    }
    case "verify_guidance":
    case "view_guidance": return `${studentPath}#guidance`;
    case "view_progress": return `${studentPath}#evidence`;
    case "resolve_blocker": return `${studentPath}${primaryIssue?.sourceType === "paper" ? "#papers" : "#milestones"}`;
    case "complete_profile":
    case "view_student":
    default: return `${studentPath}#outlook`;
  }
}

export function overviewDate(value: string | null, withYear = false) {
  if (!value) return "暂无";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
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
