import { instantTimestamp } from "./dashboard-overview/dates.ts";
import type { ProgressResolutionItem } from "./progress-resolution.ts";

export type ProgressTaskFilter = "open" | "pending" | "completed";
type TaskState = Pick<ProgressResolutionItem, "current" | "status" | "resolvedAt" | "key">;
export type ProgressResolutionTarget = Pick<ProgressResolutionItem, "progressEntryId" | "itemKind"> & { revisionNumber?: number };

export function parseProgressResolutionHash(hash: string): ProgressResolutionTarget | null {
  const match = /^#?progress-resolution-(\d+)-(blocker|next_action)(?:-revision-(\d+))?$/u.exec(hash);
  if (!match) return null;
  const progressEntryId = Number(match[1]);
  const revisionNumber = match[3] === undefined ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(progressEntryId) || progressEntryId < 1
    || (revisionNumber !== undefined && (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1))) return null;
  return {
    progressEntryId,
    itemKind: match[2] as ProgressResolutionItem["itemKind"],
    ...(revisionNumber === undefined ? {} : { revisionNumber }),
  };
}

export function findProgressResolutionTarget<T extends Pick<ProgressResolutionItem, "progressEntryId" | "itemKind" | "revisionNumber" | "current">>(
  items: readonly T[],
  target: ProgressResolutionTarget,
): T | undefined {
  const matches = items.filter((item) => item.progressEntryId === target.progressEntryId && item.itemKind === target.itemKind);
  if (target.revisionNumber !== undefined) return matches.find((item) => item.revisionNumber === target.revisionNumber);
  return matches.find((item) => item.current)
    ?? matches.sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
}

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
