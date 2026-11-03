"use client";

// Provenance links (frontend plan F3). CONTRACT (batch 1): A3 implements both
// components; A2 renders <TaskSourceLinks> in the task card header area and
// A3 renders <ResultLineage> at the bottom of a run's result section.

import type { RunDetail, TaskSummary } from "./api";

/** "来自导师意见 … / 来自运行 #n 的评审 / 上一轮：<任务>" links for a task. */
export function TaskSourceLinks({ task }: { task: TaskSummary }) {
  void task;
  return null;
}

/** 原意见 → 任务第 N 版 → PR #x → 运行 #y → 评审 → 下一轮任务 chain for one run. */
export function ResultLineage({ task, detail }: { task: TaskSummary | null; detail: RunDetail }) {
  void task; void detail;
  return null;
}
