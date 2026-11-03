// Task stage model (frontend plan F1). Pure: derives where a research task is
// in the loop and who acts next, from data the existing endpoints return. It
// never decides authorization — the server's `permissions` still gate actions.
//
// CONTRACT (batch 1): workstream A1 implements `computeTaskStages`; the types
// and signature are fixed for A2 (stage bar) and the tests.

import type { AttemptSummary, RunSummary, TaskSummary } from "./api";
import { attemptLabel, runLabel, sequenceNumbers } from "./numbering.ts";

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
  /** Optional second role that may equally act (e.g. a mentor may also confirm
   * a student's task). Display only; `owner` stays the primary role. (batch 2) */
  coOwner?: StageOwner;
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
  /** Optional second role that may equally act (batch 2). */
  coOwner?: StageOwner;
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
  /** Follow-up tasks already created from a run's review: runId → follow-up taskId
   * (tasks whose sourceRunId is that run). Optional; without it a reviewed run
   * still asks for a decision even if a follow-up exists. */
  followupTaskIdByRun?: Readonly<Record<string, string>>;
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

/*
 * Derivation rules (F1). Uses StageInput only — no clock, no network. "#n" is
 * the per-task creation-order number from numbering.ts. Owners are the role
 * expected to act; the server's `permissions` still decide who actually may.
 *
 * task    draft, never confirmed       → active · student "第 N 版待确认" (学生或导师均可确认)
 *         draft, confirmedVersion set  → active · student "第 N 版待重新确认"
 *         confirmed                    → done "第 N 版已确认"; closed / canceled → done
 * code    attempts or changeRequests null → partial: a run used a change request → done,
 *           other runs → skipped, otherwise idle (details unknown, nothing claimed)
 *         oldest CR pending_review: extra review outstanding → active · mentor, else active · student
 *         a queued/running/waiting_approval/cancel_requested attempt → working · agent
 *         a CR publishing → working · agent
 *         newest settled attempt (canceled attempts without a CR are passed over):
 *           CR open/merged → done "PR #n 已开启/已合并"; CR rejected/failed/closed → failed · student;
 *           no CR + failed → failed · student (shortened error); no CR + change_ready → done
 *         a code failure followed by a newer run → done (another PR landed) or skipped: the student moved on
 *         nothing settled: runs exist → skipped; task confirmed → active · student
 *           "可以交给代理修改代码，或直接登记运行"; otherwise idle
 * run     oldest awaiting_approval → active · mentor (takes precedence over newer in-flight runs)
 *         newest queued/dispatching/running/collecting/cancel_requested/reconciling → working · lab
 *         newest non-canceled: failed → failed · student (failureReason); completed → done "执行结束"
 *         none / only canceled: task confirmed and code done|skipped → active · student (登记运行); else idle
 * result  completed runs only. Oldest unreviewed (pending or missing review) → active · mentor; runs
 *           not technically invalid come first. An invalid run is still active (the mentor must review
 *           it) and its summary says 技术无效 / 不能验收, so it never reads as success. Otherwise the newest
 *           reviewed run → done with its review wording. Validity and review are always worded
 *           separately; nothing here is a combined "success".
 * next    task closed → done. A follow-up already created from the newest reviewed run
 *           (followupTaskIdByRun) → done. Newest run completed with a final review and no code/run stage
 *           active or working → active · student (text names 学生或导师):
 *           needs_followup "转为下一轮任务" · accepted "决定：转为下一轮任务或完成并关闭" ·
 *           rejected "决定：修订任务、转为下一轮或关闭". Otherwise idle.
 * terminal task (closed/canceled): later stages that would be active or idle → skipped; next = null.
 * next step: the first active stage; else the first working stage (waiting on agent/lab); else the
 *   first failed stage (its owner must handle it); else null.
 * current: the next step's stage, else the last stage that is neither idle nor skipped, else "task".
 */

type Derived = { stage: Stage; next: NextStep | null };

const BUSY_ATTEMPT = new Set(["queued", "running", "waiting_approval", "cancel_requested"]);
const INFLIGHT_RUN = new Set(["queued", "dispatching", "running", "collecting", "cancel_requested", "reconciling"]);
const FINAL_REVIEW = new Set(["accepted", "rejected", "needs_followup"]);

function make(key: StageKey, state: StageState, summary: string, owner: StageOwner = null): Stage {
  return { key, label: STAGE_LABELS[key], state, summary, owner };
}

function only(stage: Stage): Derived {
  return { stage, next: null };
}

function brief(text: string, max = 40) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function inOrder<T extends { id: string }>(items: readonly T[], numbers: Map<string, number>) {
  return [...items].sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0));
}

function taskStage(task: TaskSummary): Derived {
  const target: StageTarget = { kind: "task", taskId: task.id };
  if (task.status === "draft") {
    const version = task.currentVersion;
    const again = task.confirmedVersion !== null;
    return {
      stage: make("task", "active", `第 ${version} 版待${again ? "重新" : ""}确认`, "student"),
      next: { text: `学生需${again ? "重新" : ""}确认第 ${version} 版任务（导师也可确认）`, owner: "student", target },
    };
  }
  if (task.status === "confirmed") return only(make("task", "done", `第 ${task.confirmedVersion ?? task.currentVersion} 版已确认`));
  if (task.status === "closed") return only(make("task", "done", "任务已关闭"));
  if (task.status === "canceled") return only(make("task", "done", "任务已取消"));
  return only(make("task", "idle", String(task.status)));
}

function partialCodeStage(task: TaskSummary, runs: readonly RunSummary[]): Derived {
  if (runs.some((run) => run.changeRequestId)) return only(make("code", "done", "运行使用了代理变更"));
  if (runs.length) return only(make("code", "skipped", "运行未使用代理变更"));
  return only(make("code", "idle", task.status === "confirmed" ? "代码详情加载中" : ""));
}

function prText(cr: StageChangeRequest) {
  if (cr.status === "merged") return cr.prNumber ? `PR #${cr.prNumber} 已合并` : "变更已合并";
  return cr.prNumber ? `PR #${cr.prNumber} 已开启` : "PR 已开启";
}

function codeStage(
  task: TaskSummary,
  attempts: readonly AttemptSummary[],
  changeRequests: readonly StageChangeRequest[],
  runs: readonly RunSummary[],
): Derived {
  const numbers = sequenceNumbers(attempts);
  const ordered = inOrder(attempts, numbers);
  const name = (attemptId: string) => attemptLabel(numbers.get(attemptId) ?? null);
  const crTarget = (cr: StageChangeRequest): StageTarget => ({ kind: "changeRequest", taskId: task.id, changeRequestId: cr.id });
  const attemptTarget = (attempt: AttemptSummary): StageTarget => ({ kind: "attempt", taskId: task.id, attemptId: attempt.id });
  const crs = [...changeRequests].sort((a, b) =>
    (numbers.get(a.attemptId) ?? 0) - (numbers.get(b.attemptId) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const landed = (cr: StageChangeRequest) => cr.status === "open" || cr.status === "merged";

  const pending = crs.find((cr) => cr.status === "pending_review");
  if (pending) {
    if (pending.requiresExtraReview && !pending.extraReviewApprovedAt) {
      return {
        stage: make("code", "active", "变更触及受保护路径，待导师额外审查", "mentor"),
        next: { text: `等待导师额外审查${name(pending.attemptId)} 的变更（触及受保护路径）`, owner: "mentor", target: crTarget(pending) },
      };
    }
    return {
      stage: make("code", "active", "变更待审阅发布", "student"),
      next: { text: `学生需审阅并发布${name(pending.attemptId)} 的变更`, owner: "student", target: crTarget(pending) },
    };
  }

  const busy = ordered.filter((attempt) => BUSY_ATTEMPT.has(attempt.status)).at(-1);
  if (busy) {
    const label = name(busy.id);
    const [summary, text] = busy.status === "queued" ? [`${label} 排队中`, `等待${label} 开始修改代码`]
      : busy.status === "cancel_requested" ? [`${label} 正在取消`, `等待${label} 取消`]
        : [`${label} 正在修改代码`, `等待${label} 完成代码修改`];
    return { stage: make("code", "working", summary, "agent"), next: { text, owner: "agent", target: attemptTarget(busy) } };
  }

  const publishing = crs.find((cr) => cr.status === "publishing");
  if (publishing) {
    return {
      stage: make("code", "working", "变更正在发布为 PR", "agent"),
      next: { text: `正在将${name(publishing.attemptId)} 的变更发布为 PR`, owner: "agent", target: crTarget(publishing) },
    };
  }

  const crByAttempt = new Map(crs.map((cr) => [cr.attemptId, cr]));
  const settled = [...ordered].reverse().find((attempt) => attempt.status !== "canceled" || crByAttempt.has(attempt.id));
  if (!settled) {
    if (runs.length) return only(make("code", "skipped", "未使用代理，直接登记运行"));
    if (task.status === "confirmed") {
      return {
        stage: make("code", "active", "可以交给代理修改代码，或直接登记运行", "student"),
        next: { text: "学生可以交给代理修改代码，或直接登记运行", owner: "student", target: { kind: "task", taskId: task.id } },
      };
    }
    return only(make("code", "idle", ""));
  }

  const label = name(settled.id);
  const cr = crByAttempt.get(settled.id);
  if (cr && landed(cr)) return only(make("code", "done", prText(cr)));
  if (!cr && settled.status === "change_ready") return only(make("code", "done", `${label} 已产出修改`));

  let failure: Derived | null = null;
  if (cr?.status === "rejected") {
    failure = {
      stage: make("code", "failed", `${label} 的变更已驳回`, "student"),
      next: { text: `${label} 的变更已驳回，学生可修订任务或重新交给代理`, owner: "student", target: crTarget(cr) },
    };
  } else if (cr?.status === "failed") {
    failure = {
      stage: make("code", "failed", "PR 发布失败", "student"),
      next: { text: `${label} 的变更发布失败，学生需重试发布`, owner: "student", target: crTarget(cr) },
    };
  } else if (cr?.status === "closed") {
    const pr = cr.prNumber ? `PR #${cr.prNumber}` : "PR";
    failure = {
      stage: make("code", "failed", `${pr} 已关闭（未合并）`, "student"),
      next: { text: `${pr} 已关闭，学生可重新交给代理修改`, owner: "student", target: crTarget(cr) },
    };
  } else if (!cr && settled.status === "failed") {
    const reason = brief(settled.errorMessage || settled.errorCode || "原因未记录");
    failure = {
      stage: make("code", "failed", `${label} 失败：${reason}`, "student"),
      next: { text: `学生需处理${label} 的失败：${reason}`, owner: "student", target: attemptTarget(settled) },
    };
  }
  if (!failure) return only(make("code", "idle", cr ? cr.status : settled.status));

  // The student already registered a run after this failure: code is no longer the blocker.
  if (runs.some((run) => run.createdAt > settled.updatedAt)) {
    const other = crs.filter(landed).at(-1);
    return only(other ? make("code", "done", prText(other)) : make("code", "skipped", `${label} 未产出可用修改，已直接登记运行`));
  }
  return failure;
}

function runStage(task: TaskSummary, runs: readonly RunSummary[], numbers: Map<string, number>, codeState: StageState): Derived {
  const name = (run: RunSummary) => runLabel(numbers.get(run.id) ?? null);
  const target = (run: RunSummary): StageTarget => ({ kind: "run", taskId: task.id, runId: run.id });

  const awaiting = runs.find((run) => run.status === "awaiting_approval");
  if (awaiting) {
    return {
      stage: make("run", "active", `${name(awaiting)} 待导师批准`, "mentor"),
      next: { text: `等待导师批准${name(awaiting)}`, owner: "mentor", target: target(awaiting) },
    };
  }

  const inflight = runs.filter((run) => INFLIGHT_RUN.has(run.status)).at(-1);
  if (inflight) {
    const label = name(inflight);
    const phrases: Record<string, [string, string]> = {
      queued: [`${label} 已批准，排队中`, `${label} 已批准，等待实验室执行`],
      dispatching: [`${label} 派发中`, `等待实验室开始执行${label}`],
      running: [`${label} 运行中`, `等待实验室完成${label}`],
      collecting: [`${label} 回收结果中`, `等待实验室回收${label} 的结果`],
      cancel_requested: [`${label} 正在取消`, `等待实验室取消${label}`],
      reconciling: [`${label} 对账中，不会重复提交`, `正在与实验室核对${label} 的作业状态，不会重复提交`],
    };
    const [summary, text] = phrases[inflight.status];
    return { stage: make("run", "working", summary, "lab"), next: { text, owner: "lab", target: target(inflight) } };
  }

  const settled = runs.filter((run) => run.status !== "canceled").at(-1);
  if (settled?.status === "failed") {
    const reason = brief(settled.failureReason || "原因未记录");
    return {
      stage: make("run", "failed", `${name(settled)} 失败：${reason}`, "student"),
      next: { text: `学生需查看${name(settled)} 的失败原因：${reason}`, owner: "student", target: target(settled) },
    };
  }
  if (settled?.status === "completed") return only(make("run", "done", `${name(settled)} 执行结束`));
  if (settled) return only(make("run", "idle", settled.status));

  const canceled = runs.at(-1);
  const prefix = canceled ? `${name(canceled)} 已取消` : "";
  if (task.status === "confirmed" && (codeState === "done" || codeState === "skipped")) {
    return {
      stage: make("run", "active", canceled ? `${prefix}，可重新登记` : "待登记运行", "student"),
      next: { text: canceled ? `${prefix}，学生可以重新登记运行` : "学生可以登记运行", owner: "student", target: { kind: "task", taskId: task.id } },
    };
  }
  return only(make("run", "idle", prefix));
}

const VALIDITY_TEXT: Record<string, string> = { valid: "技术有效", invalid: "技术无效" };
const REVIEW_TEXT: Record<string, string> = { accepted: "导师已验收", rejected: "导师未采纳", needs_followup: "需要后续实验" };

function resultStage(task: TaskSummary, runs: readonly RunSummary[], numbers: Map<string, number>): Derived {
  const name = (run: RunSummary) => runLabel(numbers.get(run.id) ?? null);
  const target = (run: RunSummary): StageTarget => ({ kind: "run", taskId: task.id, runId: run.id });
  const validity = (run: RunSummary) => VALIDITY_TEXT[run.technicalValidity ?? ""] ?? "技术有效性未知";
  const completed = runs.filter((run) => run.status === "completed");
  const unreviewed = (run: RunSummary) => !run.reviewState || run.reviewState === "pending";

  const pending = completed.find((run) => unreviewed(run) && run.technicalValidity !== "invalid");
  if (pending) {
    return {
      stage: make("result", "active", `${name(pending)} ${validity(pending)} · 待导师评审`, "mentor"),
      next: { text: `等待导师评审${name(pending)}`, owner: "mentor", target: target(pending) },
    };
  }
  const invalid = completed.find(unreviewed);
  if (invalid) {
    return {
      stage: make("result", "active", `${name(invalid)} 技术无效 · 待导师评审`, "mentor"),
      next: { text: `等待导师评审${name(invalid)}（技术无效，不能验收）`, owner: "mentor", target: target(invalid) },
    };
  }
  const reviewed = completed.filter((run) => FINAL_REVIEW.has(run.reviewState ?? "")).at(-1);
  if (reviewed) return only(make("result", "done", `${name(reviewed)} ${validity(reviewed)} · ${REVIEW_TEXT[reviewed.reviewState ?? ""]}`));
  return only(make("result", "idle", ""));
}

function nextStage(task: TaskSummary, runs: readonly RunSummary[], numbers: Map<string, number>, loopBusy: boolean,
  followups: Readonly<Record<string, string>> | undefined): Derived {
  if (task.status === "closed") return only(make("next", "done", "任务已关闭"));
  const latest = runs.at(-1);
  if (!latest || loopBusy || latest.status !== "completed" || !FINAL_REVIEW.has(latest.reviewState ?? "")) return only(make("next", "idle", ""));
  const label = runLabel(numbers.get(latest.id) ?? null);
  // A follow-up already created from this run's review settles the decision.
  if (followups?.[latest.id]) return only(make("next", "done", `已由${label} 转为下一轮任务`));
  const target: StageTarget = { kind: "run", taskId: task.id, runId: latest.id };
  const [summary, text] = latest.reviewState === "needs_followup"
    ? ["转为下一轮任务", `${label} 需要后续实验，学生或导师可转为下一轮任务`]
    : latest.reviewState === "accepted"
      ? ["决定：转为下一轮任务或完成并关闭", `${label} 已验收，学生或导师决定：转为下一轮任务或完成并关闭`]
      : ["决定：修订任务、转为下一轮或关闭", `${label} 未采纳，学生或导师决定：修订任务、转为下一轮或关闭`];
  return { stage: make("next", "active", summary, "student"), next: { text, owner: "student", target } };
}

export function computeTaskStages(input: StageInput): TaskStages {
  const { task, attempts, changeRequests } = input;
  const partial = attempts === null || changeRequests === null;
  const runNumbers = sequenceNumbers(input.runs);
  const runs = inOrder(input.runs, runNumbers);

  const code = attempts && changeRequests ? codeStage(task, attempts, changeRequests, runs) : partialCodeStage(task, runs);
  const run = runStage(task, runs, runNumbers, code.stage.state);
  const result = resultStage(task, runs, runNumbers);
  const loopBusy = [code, run].some((item) => item.stage.state === "active" || item.stage.state === "working");
  let derived = [taskStage(task), code, run, result, nextStage(task, runs, runNumbers, loopBusy, input.followupTaskIdByRun)];

  const terminal = task.status === "closed" || task.status === "canceled";
  if (terminal) {
    const summary = task.status === "canceled" ? "任务已取消" : "任务已关闭";
    derived = derived.map((item, index) => index > 0 && (item.stage.state === "active" || item.stage.state === "idle")
      ? only({ ...item.stage, state: "skipped", owner: null, summary })
      : item);
  }

  const withState = (state: StageState) => derived.find((item) => item.stage.state === state && item.next);
  const pick = terminal ? undefined : withState("active") ?? withState("working") ?? withState("failed");
  const stages = derived.map((item) => item.stage);
  const current = pick?.stage.key
    ?? [...stages].reverse().find((stage) => stage.state !== "idle" && stage.state !== "skipped")?.key
    ?? "task";
  return { stages, current, next: pick?.next ?? null, partial };
}

