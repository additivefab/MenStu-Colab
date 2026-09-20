import { isOverdueInShanghai } from "./dashboard-overview/dates.ts";

type ProgressWithPlan = {
  review_status: string;
  paper: { next_action: string; next_action_due_date: string } | null;
  project: { next_action: string; next_action_due_date: string } | null;
};

export function progressFollowUpNotice(entry: ProgressWithPlan, now: string | Date): string | null {
  if (entry.review_status !== "accepted") return null;
  const overduePlan = [entry.paper, entry.project].some((plan) => (
    plan?.next_action.trim() && isOverdueInShanghai(plan.next_action_due_date, now)
  ));
  if (!overduePlan) return null;
  return "本次进展已通过。记录中的下一步期限已过，请核对后续完成情况；最新安排以学生后续提交的进展为准。";
}
