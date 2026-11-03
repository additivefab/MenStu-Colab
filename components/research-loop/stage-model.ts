// Task stage model (frontend plan F1). Pure: derives where a research task is
// in the loop and who acts next, from data the existing endpoints return. It
// never decides authorization — the server's `permissions` still gate actions.
//
// CONTRACT (batch 1): workstream A1 implements `computeTaskStages`; the types
// and signature are fixed for A2 (stage bar) and the tests.

import type { AttemptSummary, RunSummary, TaskSummary } from "./api";

export type StageKey = "task" | "code" | "run" | "result" | "next";

/** done: finished · active: someone must act now · working: machine/lab busy ·
 * failed: last attempt in this stage failed · idle: not reached yet ·
 * skipped: not applicable (e.g. task canceled before code). */
export type StageState = "done" | "active" | "working" | "failed" | "idle" | "skipped";

/** Role expected to act; null when nobody needs to act (done/idle). */
export type StageOwner = "student" | "mentor" | "reviewer" | "admin" | "agent" | "lab" | null;

export type Stage = {
  key: StageKey;
  label: string;
  state: StageState;
  /** One short Chinese phrase, e.g. "第 2 版已确认" / "变更待额外审查". */
  summary: string;
  owner: StageOwner;
};

export type StageTarget =
  | { kind: "task"; taskId: string }
  | { kind: "attempt"; taskId: string; attemptId: string }
  | { kind: "changeRequest"; taskId: string; changeRequestId: string }
  | { kind: "run"; taskId: string; runId: string };

export type NextStep = {
  /** Chinese sentence naming the action and the actor, e.g. "等待导师批准运行 #3". */
  text: string;
  owner: StageOwner;
  /** Card the next step refers to, for "前往" links and auto-focus. */
  target: StageTarget | null;
};

/** Minimal change-request fields the model needs (subset of api.ts ChangeRequest). */
export type StageChangeRequest = {
  id: string;
  attemptId: string;
  status: string;
  requiresExtraReview?: boolean;
  extraReviewApprovedAt?: string | null;
  prNumber?: number | null;
};

export type StageInput = {
  task: TaskSummary;
  /** null when the task detail has not been loaded yet. */
  attempts: AttemptSummary[] | null;
  /** null when change requests have not been loaded yet. */
  changeRequests: StageChangeRequest[] | null;
  /** Runs of this task (any order). */
  runs: RunSummary[];
};

export type TaskStages = {
  stages: Stage[];
  /** The stage the card should open at. */
  current: StageKey;
  next: NextStep | null;
  /** true when attempts/changeRequests were null, so code-stage details are partial. */
  partial: boolean;
};

export const STAGE_LABELS: Record<StageKey, string> = {
  task: "任务",
  code: "代码",
  run: "运行",
  result: "结果",
  next: "下一轮",
};

export const OWNER_LABELS: Record<Exclude<StageOwner, null>, string> = {
  student: "学生",
  mentor: "导师",
  reviewer: "审查人",
  admin: "超级管理员",
  agent: "代理",
  lab: "实验室",
};

/** Placeholder until A1 lands: only the task stage is derived. */
export function computeTaskStages(input: StageInput): TaskStages {
  const confirmed = input.task.status === "confirmed";
  const stages: Stage[] = (Object.keys(STAGE_LABELS) as StageKey[]).map((key) => ({
    key, label: STAGE_LABELS[key], state: key === "task" ? (confirmed ? "done" : "active") : "idle", summary: "", owner: null,
  }));
  return { stages, current: "task", next: null, partial: input.attempts === null || input.changeRequests === null };
}
