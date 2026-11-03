// Batch 6 (pack 02 §9, T22): client helpers for the evaluation budget and
// reproduction views (lib/research-loop/results-contract.ts). Pure functions;
// the server is the only source of counts, limits and tolerance decisions.

import type { EvaluationBudgetView, ReproductionView } from "../../lib/research-loop/results-contract.ts";
import type { RunDetail } from "./api";

/** RunDetail fields added in batch 6; optional so older servers still render. */
export type RunValidityFields = {
  evaluationBudget?: EvaluationBudgetView | null;
  reproduction?: ReproductionView | null;
};

export type RunDetailWithValidity = RunDetail & RunValidityFields;

export const withValidity = (detail: RunDetail) => detail as RunDetailWithValidity;

export function evaluationBudgetUrl(taskId: string, evaluationProtocolSha256: string) {
  return `/api/runs?view=evaluation_budget&taskId=${encodeURIComponent(taskId)}&evaluationProtocolSha256=${encodeURIComponent(evaluationProtocolSha256)}`;
}

/** "正式评测剩余 N 次（第 v 版任务）"; null when the task version sets no limit. */
export function evaluationBudgetLine(view: EvaluationBudgetView | null | undefined) {
  if (!view || view.limit === null || view.remaining === null) return null;
  return `正式评测剩余 ${view.remaining} 次（第 ${view.taskVersion} 版任务）`;
}

export const evaluationBudgetExhausted = (view: EvaluationBudgetView | null | undefined) => Boolean(view && view.remaining === 0);

/** Rounds away binary floating-point noise for display (0.020000000000000018 → 0.02). */
export function displayNumber(value: number) {
  return Number(value.toPrecision(10));
}

/** Neutral signed difference ("+0.02", "−0.013", "0"); never better/worse. */
export function reproductionDiffText(diff: number) {
  const value = displayNumber(diff);
  if (value === 0) return "0";
  return value > 0 ? `+${value}` : `−${Math.abs(value)}`;
}

/** Neutral summary: within / beyond tolerance, never "成功". */
export function reproductionSummary(view: ReproductionView) {
  if (!view.metrics.length) return "两次执行没有共同的机器指标，无法比较";
  const beyond = view.metrics.filter((item) => !item.withinTolerance).length;
  return beyond ? `${beyond} 项指标超出容差` : `全部 ${view.metrics.length} 项指标在容差内`;
}
