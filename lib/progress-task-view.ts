import { instantTimestamp } from "./dashboard-overview/dates.ts";
import type { ProgressResolutionItem } from "./progress-resolution.ts";

export type ProgressTaskFilter = "open" | "pending" | "completed";
type TaskState = Pick<ProgressResolutionItem, "current" | "status" | "resolvedAt" | "key">;

export function progressTaskFilter(item: Pick<TaskState, "current" | "status">): ProgressTaskFilter | "historical" {
  if (item.status === "resolved") return "completed";
  if (item.current === false) return "historical";
  return item.status === "pending" ? "pending" : "open";
}

export function groupProgressTasks<T extends TaskState>(items: readonly T[]) {
  const groups: Record<ProgressTaskFilter | "historical", T[]> = { open: [], pending: [], completed: [], historical: [] };
  for (const item of items) groups[progressTaskFilter(item)].push(item);
  groups.completed.sort((left, right) => {
    const leftTime = left.resolvedAt ? instantTimestamp(left.resolvedAt) : NaN;
    const rightTime = right.resolvedAt ? instantTimestamp(right.resolvedAt) : NaN;
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0) || left.key.localeCompare(right.key);
  });
  return groups;
}
