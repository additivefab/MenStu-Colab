// Task version diff (frontend plan F2, G1). Pure: compares the content fields
// of two task versions so the confirmer sees exactly what a new version
// changes. Display only — the server snapshot hash stays authoritative.

import type { TaskBudget, TaskSummary, TaskVersion } from "./api";

export type VersionContent = Pick<TaskVersion,
  "title" | "researchQuestion" | "hypothesis" | "instructions" | "acceptanceCriteria" | "allowedPaths" | "protectedPaths" | "budget">;

export type TextField = "title" | "researchQuestion" | "hypothesis" | "instructions" | "acceptanceCriteria";
export type ListField = "allowedPaths" | "protectedPaths";
export type BudgetKey = keyof TaskBudget;

export type TextChange = { kind: "text"; field: TextField; label: string; before: string; after: string };
export type ListChange = { kind: "list"; field: ListField; label: string; before: string[]; after: string[]; added: string[]; removed: string[] };
export type BudgetItemChange = { key: BudgetKey; label: string; unit: string; before: number | undefined; after: number | undefined };
export type BudgetChange = { kind: "budget"; field: "budget"; label: string; items: BudgetItemChange[] };
export type VersionChange = TextChange | ListChange | BudgetChange;

/** Field order follows the task form. */
export const TEXT_FIELDS: { field: TextField; label: string }[] = [
  { field: "title", label: "标题" },
  { field: "researchQuestion", label: "研究问题" },
  { field: "hypothesis", label: "假设" },
  { field: "instructions", label: "执行说明" },
  { field: "acceptanceCriteria", label: "验收标准" },
];

export const LIST_FIELDS: { field: ListField; label: string }[] = [
  { field: "allowedPaths", label: "修改范围" },
  { field: "protectedPaths", label: "受保护路径" },
];

export const BUDGET_KEYS: { key: BudgetKey; label: string; unit: string }[] = [
  { key: "maxAgentMinutes", label: "代理时长上限", unit: "分钟" },
  { key: "maxGpuCount", label: "GPU 上限", unit: "块" },
  { key: "maxWalltimeMinutes", label: "单次运行时长上限", unit: "分钟" },
];

const normalizeText = (value: string | null | undefined) => (value ?? "").replace(/\r\n?/gu, "\n");

function uniquePaths(paths: readonly string[] | null | undefined) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths ?? []) {
    const path = raw.trim();
    if (path && !seen.has(path)) { seen.add(path); result.push(path); }
  }
  return result;
}

function budgetNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Changed content fields from `previous` to `current`, in form order. Text
 * compares exactly (line endings normalized); path lists compare as sets, so
 * reordering is not a change; budget compares per key, unset ≠ 0.
 */
export function diffTaskVersions(previous: VersionContent, current: VersionContent): VersionChange[] {
  const changes: VersionChange[] = [];
  for (const { field, label } of TEXT_FIELDS) {
    const before = normalizeText(previous[field]);
    const after = normalizeText(current[field]);
    if (before !== after) changes.push({ kind: "text", field, label, before, after });
  }
  for (const { field, label } of LIST_FIELDS) {
    const before = uniquePaths(previous[field]);
    const after = uniquePaths(current[field]);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added = after.filter((path) => !beforeSet.has(path));
    const removed = before.filter((path) => !afterSet.has(path));
    if (added.length || removed.length) changes.push({ kind: "list", field, label, before, after, added, removed });
  }
  const previousBudget: Record<string, unknown> = { ...(previous.budget ?? {}) };
  const currentBudget: Record<string, unknown> = { ...(current.budget ?? {}) };
  const known = new Set<string>(BUDGET_KEYS.map((item) => item.key));
  const extraKeys = [...new Set([...Object.keys(previousBudget), ...Object.keys(currentBudget)])]
    .filter((key) => !known.has(key)).sort();
  const items: BudgetItemChange[] = [];
  for (const { key, label, unit } of [...BUDGET_KEYS, ...extraKeys.map((key) => ({ key: key as BudgetKey, label: key, unit: "" }))]) {
    const before = budgetNumber(previousBudget[key]);
    const after = budgetNumber(currentBudget[key]);
    if (before !== after) items.push({ key, label, unit, before, after });
  }
  if (items.length) changes.push({ kind: "budget", field: "budget", label: "预算", items });
  return changes;
}

/**
 * Version a draft should be compared against before confirming: the confirmed
 * version when the draft revises a confirmed task, else the version before it.
 * Null when there is nothing to compare (not a draft, or the first version).
 */
export function comparisonBaseVersion(task: Pick<TaskSummary, "status" | "currentVersion" | "confirmedVersion">): number | null {
  if (task.status !== "draft") return null;
  if (task.confirmedVersion && task.confirmedVersion !== task.currentVersion) return task.confirmedVersion;
  return task.currentVersion > 1 ? task.currentVersion - 1 : null;
}

/** Protected paths split into the platform defaults and the task's own additions. */
export function splitProtectedPaths(paths: readonly string[], defaults: readonly string[]) {
  const defaultSet = new Set(defaults);
  const unique = uniquePaths(paths);
  return {
    defaults: unique.filter((path) => defaultSet.has(path)),
    extra: unique.filter((path) => !defaultSet.has(path)),
  };
}
