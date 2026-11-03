// Pilot process metrics (design pack 05 "试点观察指标"; plan G5 in
// docs/设计包评估与下一步_2026-11-03.md). They evaluate the platform's own
// process, never people: the payload carries only aggregate numbers over the
// whole pilot — counts, ratios, median/p90 durations — each with its
// definition and sample size. No student, user, task title or per-person
// breakdown is ever read into or returned from this module (principle 6 of
// docs/科研闭环_前端优化方案_2026-11-03.md: 不监控、不排名).
//
// A metric that the stored data cannot support is returned with value null and
// a reason; nothing is estimated or fabricated.
//
// Period: inclusive Asia/Shanghai calendar days [from, to] (default: the last
// 30 days ending today, at most 366 days). Each metric is attributed to the
// period by one stated event (e.g. "PR opened in the period").
//
// Percentiles: median = middle value (mean of the two middle values for an even
// sample); p90 = nearest-rank (the ⌈0.9·n⌉-th smallest value). Durations are in
// minutes, rounded to 0.1.

import { calendarDayDiff, instantTimestamp, shanghaiDateKey } from "./dashboard-overview/dates.ts";

export const PILOT_MAX_DAYS = 366;
export const PILOT_DEFAULT_DAYS = 30;
/** ReproductionView default (lib/research-loop/contracts.ts TaskBudget.reproTolerance). */
export const DEFAULT_REPRO_TOLERANCE = 0.01;
export const PILOT_PURPOSE_NOTE = "这些是流程指标，用于评估平台本身，不用于评价学生";

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FINAL_REVIEW_STATES = new Set(["accepted", "rejected", "needs_followup"]);
const PUBLISHED_PR_STATUSES = new Set(["open", "merged", "closed"]);

export class PilotInputError extends Error {}

export type PilotPeriod = { from: string; to: string; start: number; end: number };

function utcMidnight(dateKey: string) {
  if (!DATE_PATTERN.test(dateKey)) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = Date.UTC(year, month - 1, day);
  return new Date(value).toISOString().slice(0, 10) === dateKey ? value : null;
}

/** Give both bounds or neither (neither = last 30 days ending today, Shanghai). */
export function parsePilotPeriod(rawFrom: string | null, rawTo: string | null, now: Date | string = new Date()): PilotPeriod {
  const fromInput = rawFrom?.trim() || null;
  const toInput = rawTo?.trim() || null;
  if ((fromInput === null) !== (toInput === null)) throw new PilotInputError("请同时提供开始和结束日期，或都不提供");
  for (const value of [fromInput, toInput]) {
    if (value !== null && utcMidnight(value) === null) throw new PilotInputError("日期格式无效，应为 YYYY-MM-DD");
  }
  const today = shanghaiDateKey(now);
  if (!today) throw new PilotInputError("当前时间无效");
  const to = toInput ?? today;
  const from = fromInput ?? new Date((utcMidnight(to) as number) - (PILOT_DEFAULT_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const span = calendarDayDiff(to, from);
  if (span === null) throw new PilotInputError("日期格式无效，应为 YYYY-MM-DD");
  if (span < 0) throw new PilotInputError("开始日期不能晚于结束日期");
  if (span + 1 > PILOT_MAX_DAYS) throw new PilotInputError(`统计周期不能超过 ${PILOT_MAX_DAYS} 天`);
  return {
    from, to,
    start: (utcMidnight(from) as number) - SHANGHAI_OFFSET_MS,
    end: (utcMidnight(to) as number) + DAY_MS - SHANGHAI_OFFSET_MS,
  };
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export type PilotMetricKind = "ratio" | "duration" | "count" | "usage";

/** Every metric has the same keys; fields that do not apply are null. */
export type PilotMetric = {
  key: string;
  group: string;
  label: string;
  kind: PilotMetricKind;
  /** Display unit: "比例" | "分钟" | "个" | "tokens". */
  unit: string;
  /** Ratio in [0, 1] or a count; null for duration/usage metrics or when not computable. */
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  /** Distribution (duration/usage metrics only). */
  median: number | null;
  p90: number | null;
  /** Number of observations the value is computed from. */
  sampleSize: number;
  definition: string;
  /** Why the value is null (no sample in the period, or not measurable at all). */
  reason: string | null;
  /** Caveat about coverage, e.g. records left out because a timestamp is not recoverable. */
  caveat: string | null;
  /** false = not measurable from the stored data at all, whatever the period. */
  computable: boolean;
};

export type PilotMetricsReport = {
  period: { from: string; to: string };
  note: string;
  percentileMethod: string;
  metrics: PilotMetric[];
};

// ---------------------------------------------------------------------------
// Rows (snake_case, as read from D1). Deliberately no student/user columns.
// ---------------------------------------------------------------------------

export type PilotRows = {
  tasks: { id: string; first_confirmed_at: string | null; guidance_created_at: string | null }[];
  changeRequests: { id: string; task_id: string; status: string; pr_number: number | null; created_at: string; updated_at: string; webhook_touched: number }[];
  attempts: { id: string; task_id: string; status: string; created_at: string; started_at: string | null; ended_at: string | null; usage_json: string; plan_first: number }[];
  runs: {
    id: string; task_id: string; run_spec_sha256: string; attempt: number; status: string; submit_tag: string;
    runner_id: string | null; scheduler_job_id: string | null; created_at: string; queued_at: string | null;
    started_at: string | null; ended_at: string | null; review_state: string | null; metrics_json: string | null;
    budget_json: string | null;
  }[];
};

const ms = (value: string | null | undefined) => (value ? instantTimestamp(value) : Number.NaN);

function minutesBetween(start: string | null | undefined, end: string | null | undefined) {
  const a = ms(start);
  const b = ms(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60_000;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function p90(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)];
}

function parseObject(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** tanyan.metrics/v1 `values`, finite numbers only (as in research-loop-evidence). */
function metricValues(json: string | null) {
  const values = parseObject(json)?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) if (finite(value)) out[name] = value;
  return out;
}

const NO_SAMPLE = "周期内没有样本";

type Base = Pick<PilotMetric, "key" | "group" | "label" | "definition"> & { caveat?: string | null };

function ratioMetric(base: Base, numerator: number, denominator: number, emptyReason = NO_SAMPLE): PilotMetric {
  return {
    ...base, kind: "ratio", unit: "比例", caveat: base.caveat ?? null, computable: true,
    value: denominator ? round3(numerator / denominator) : null,
    numerator, denominator, median: null, p90: null, sampleSize: denominator,
    reason: denominator ? null : emptyReason,
  };
}

function distributionMetric(base: Base, kind: "duration" | "usage", unit: string, values: number[], round = round1): PilotMetric {
  const mid = median(values);
  const high = p90(values);
  return {
    ...base, kind, unit, caveat: base.caveat ?? null, computable: true,
    value: null, numerator: null, denominator: null,
    median: mid === null ? null : round(mid), p90: high === null ? null : round(high),
    sampleSize: values.length, reason: values.length ? null : NO_SAMPLE,
  };
}

function countMetric(base: Base, value: number, sampleSize: number): PilotMetric {
  return {
    ...base, kind: "count", unit: "个", caveat: base.caveat ?? null, computable: true,
    value, numerator: null, denominator: null, median: null, p90: null, sampleSize, reason: null,
  };
}

function unavailableMetric(base: Base, kind: PilotMetricKind, unit: string, reason: string): PilotMetric {
  return {
    ...base, kind, unit, caveat: base.caveat ?? null, computable: false,
    value: null, numerator: null, denominator: null, median: null, p90: null, sampleSize: 0, reason,
  };
}

// ---------------------------------------------------------------------------
// Assembly (pure; exported for tests)
// ---------------------------------------------------------------------------

/**
 * When the PR of a change request was opened. change_requests has no
 * published_at column; `updated_at` equals the publish moment only while the
 * row is still `open` and no GitHub webhook has touched it since (a later
 * synchronize/close/reopen overwrites it). Other published rows are left out
 * and counted as not recoverable — never guessed.
 */
function publishInstant(cr: PilotRows["changeRequests"][number]) {
  if (cr.pr_number === null || cr.status !== "open" || Number(cr.webhook_touched)) return null;
  const value = ms(cr.updated_at);
  return Number.isFinite(value) ? value : null;
}

export function buildPilotMetrics(period: PilotPeriod, rows: PilotRows): PilotMetricsReport {
  const inPeriod = (value: number) => Number.isFinite(value) && value >= period.start && value < period.end;
  const metrics: PilotMetric[] = [];

  // 1. Closed-loop completion.
  const confirmedInPeriod = rows.tasks.filter((task) => inPeriod(ms(task.first_confirmed_at)));
  const closedTasks = new Set(rows.runs
    .filter((run) => run.status === "completed" && run.review_state !== null && FINAL_REVIEW_STATES.has(run.review_state))
    .map((run) => run.task_id));
  metrics.push(ratioMetric({
    key: "closed_loop_completion", group: "闭环", label: "闭环完成比例",
    definition: "周期内首次确认的研究任务中，至少有一次“执行完成且已有导师最终评审（接受、拒绝或需后续）”运行的任务所占比例。评审状态按查询时计。",
  }, confirmedInPeriod.filter((task) => closedTasks.has(task.id)).length, confirmedInPeriod.length));

  // 2–3. Guidance / confirmation → first PR opened; 4. review time.
  const crsByTask = new Map<string, PilotRows["changeRequests"]>();
  for (const cr of rows.changeRequests) crsByTask.set(cr.task_id, [...(crsByTask.get(cr.task_id) ?? []), cr]);
  const published = rows.changeRequests.filter((cr) => cr.pr_number !== null && PUBLISHED_PR_STATUSES.has(cr.status));
  const unrecoverable = published.filter((cr) => publishInstant(cr) === null).length;
  /** First PR opened for a task, or null when it cannot be established. */
  const firstPr = new Map<string, number | null>();
  for (const [taskId, crs] of crsByTask) {
    const withPr = crs.filter((cr) => cr.pr_number !== null && PUBLISHED_PR_STATUSES.has(cr.status));
    const known = withPr.map(publishInstant).filter((value): value is number => value !== null);
    if (!known.length) { firstPr.set(taskId, null); continue; }
    const first = Math.min(...known);
    // An unrecoverable PR created before `first` may have been published earlier.
    const ambiguous = withPr.some((cr) => publishInstant(cr) === null && ms(cr.created_at) < first);
    firstPr.set(taskId, ambiguous ? null : first);
  }
  const prCaveat = unrecoverable
    ? `平台未单独记录 PR 打开时间；仅当变更请求仍为“已打开”且此后未被 GitHub 回调更新时，其更新时间才等于打开时间。有 ${unrecoverable} 个已发布变更请求的打开时间无法确证，未计入样本。`
    : "平台未单独记录 PR 打开时间；以仍为“已打开”且未被 GitHub 回调更新的变更请求的更新时间作为打开时间。";
  const leadTimes = (startOf: (task: PilotRows["tasks"][number]) => string | null) => {
    const values: number[] = [];
    for (const task of rows.tasks) {
      const pr = firstPr.get(task.id);
      if (pr === undefined || pr === null || !inPeriod(pr)) continue;
      const start = ms(startOf(task));
      if (Number.isFinite(start) && pr >= start) values.push((pr - start) / 60_000);
    }
    return values;
  };
  metrics.push(distributionMetric({
    key: "guidance_to_first_pr", group: "时延", label: "意见到 PR 时延（源自导师意见的任务）",
    definition: "由导师意见转成的研究任务：从意见创建到该任务第一个 PR 打开的时长。按 PR 打开时间归入周期。",
    caveat: prCaveat,
  }, "duration", "分钟", leadTimes((task) => task.guidance_created_at)));
  metrics.push(distributionMetric({
    key: "confirmation_to_first_pr", group: "时延", label: "任务确认到 PR 时延",
    definition: "从研究任务首次确认到该任务第一个 PR 打开的时长。按 PR 打开时间归入周期。",
    caveat: prCaveat,
  }, "duration", "分钟", leadTimes((task) => task.first_confirmed_at)));
  const reviewTimes: number[] = [];
  for (const cr of published) {
    const opened = publishInstant(cr);
    const created = ms(cr.created_at);
    if (opened !== null && inPeriod(opened) && Number.isFinite(created) && opened >= created) reviewTimes.push((opened - created) / 60_000);
  }
  metrics.push(distributionMetric({
    key: "change_review_time", group: "时延", label: "人工审查时长（变更请求）",
    definition: "变更请求从创建（代理产出修改）到发布为 PR 的墙钟时长，包含等待时间，不是实际阅读时长；被拒绝的变更不计入。按发布时间归入周期。",
    caveat: prCaveat,
  }, "duration", "分钟", reviewTimes));

  // 5–6. Queue and run time (compute runs).
  const runQueue: number[] = [];
  const runExec: number[] = [];
  for (const run of rows.runs) {
    if (inPeriod(ms(run.started_at))) { const value = minutesBetween(run.queued_at, run.started_at); if (value !== null) runQueue.push(value); }
    if (inPeriod(ms(run.ended_at))) { const value = minutesBetween(run.started_at, run.ended_at); if (value !== null) runExec.push(value); }
  }
  metrics.push(distributionMetric({
    key: "run_queue_time", group: "排队与运行", label: "计算运行排队时间",
    definition: "运行从进入队列（审批通过后）到开始执行的时长。按开始时间归入周期。",
  }, "duration", "分钟", runQueue));
  metrics.push(distributionMetric({
    key: "run_execution_time", group: "排队与运行", label: "计算运行执行时间",
    definition: "运行从开始执行到结束（完成、失败或取消）的时长。按结束时间归入周期。",
  }, "duration", "分钟", runExec));

  // 7–8. Agent attempts queue/run (plan-first attempts excluded: their span includes a human plan decision).
  const attemptQueue: number[] = [];
  const attemptExec: number[] = [];
  for (const attempt of rows.attempts) {
    if (Number(attempt.plan_first)) continue;
    if (inPeriod(ms(attempt.started_at))) { const value = minutesBetween(attempt.created_at, attempt.started_at); if (value !== null) attemptQueue.push(value); }
    if (inPeriod(ms(attempt.ended_at))) { const value = minutesBetween(attempt.started_at, attempt.ended_at); if (value !== null) attemptExec.push(value); }
  }
  const planCaveat = "先计划后修改的代理尝试不计入（其时长包含人工审批计划的等待）。";
  metrics.push(distributionMetric({
    key: "attempt_queue_time", group: "排队与运行", label: "代理尝试排队时间",
    definition: "代理尝试从发起到工作进程开始执行的时长。按开始时间归入周期。", caveat: planCaveat,
  }, "duration", "分钟", attemptQueue));
  metrics.push(distributionMetric({
    key: "attempt_execution_time", group: "排队与运行", label: "代理尝试执行时间",
    definition: "代理尝试从开始执行到结束的时长。按结束时间归入周期。", caveat: planCaveat,
  }, "duration", "分钟", attemptExec));

  // 9–11. Model usage from usage_json (attempts ended in the period).
  const tokensPerAttempt: number[] = [];
  const wallPerAttempt: number[] = [];
  const tokensPerTask = new Map<string, number>();
  for (const attempt of rows.attempts) {
    if (!inPeriod(ms(attempt.ended_at))) continue;
    const usage = parseObject(attempt.usage_json) ?? {};
    if (finite(usage.inputTokens) || finite(usage.outputTokens)) {
      const tokens = (finite(usage.inputTokens) ? usage.inputTokens : 0) + (finite(usage.outputTokens) ? usage.outputTokens : 0);
      tokensPerAttempt.push(tokens);
      tokensPerTask.set(attempt.task_id, (tokensPerTask.get(attempt.task_id) ?? 0) + tokens);
    }
    if (finite(usage.agentWallSeconds) && usage.agentWallSeconds >= 0) wallPerAttempt.push(usage.agentWallSeconds / 60);
  }
  const usageCaveat = "只统计工作进程上报了相应字段的尝试；不同提供商的 token 口径不完全一致。";
  metrics.push(distributionMetric({
    key: "tokens_per_attempt", group: "模型用量", label: "每次代理尝试的模型 token",
    definition: "usage_json 中 inputTokens + outputTokens（缓存命中包含在输入内，不另计）。按尝试结束时间归入周期。", caveat: usageCaveat,
  }, "usage", "tokens", tokensPerAttempt, Math.round));
  metrics.push(distributionMetric({
    key: "tokens_per_task", group: "模型用量", label: "每任务模型 token",
    definition: "同一研究任务在周期内结束的全部代理尝试的 token 合计，在任务之间取分布。", caveat: usageCaveat,
  }, "usage", "tokens", [...tokensPerTask.values()], Math.round));
  metrics.push(distributionMetric({
    key: "agent_wall_minutes_per_attempt", group: "模型用量", label: "每次代理尝试的代理运行时长",
    definition: "usage_json 中 agentWallSeconds（工作进程测得的代理墙钟时长）换算为分钟。按尝试结束时间归入周期。", caveat: usageCaveat,
  }, "duration", "分钟", wallPerAttempt));

  // 12–13. Failure recovery.
  const recoveredRun = (failed: PilotRows["runs"][number]) => {
    const after = ms(failed.ended_at ?? failed.created_at);
    return rows.runs.some((run) => run.id !== failed.id && run.task_id === failed.task_id && run.status === "completed" && ms(run.created_at) >= after);
  };
  const failedRuns = rows.runs.filter((run) => run.status === "failed" && inPeriod(ms(run.ended_at)));
  metrics.push(ratioMetric({
    key: "run_failure_recovery", group: "失败恢复", label: "计算运行失败恢复成功率",
    definition: "周期内结束的失败运行中，同一任务之后（失败结束后创建）有一次执行完成的运行所占比例。后续运行按查询时计。",
  }, failedRuns.filter(recoveredRun).length, failedRuns.length));
  const failedAttempts = rows.attempts.filter((attempt) => attempt.status === "failed" && inPeriod(ms(attempt.ended_at)));
  const recoveredAttempt = (failed: PilotRows["attempts"][number]) => {
    const after = ms(failed.ended_at ?? failed.created_at);
    return rows.attempts.some((attempt) => attempt.id !== failed.id && attempt.task_id === failed.task_id
      && attempt.status === "change_ready" && ms(attempt.created_at) >= after);
  };
  metrics.push(ratioMetric({
    key: "attempt_failure_recovery", group: "失败恢复", label: "代理尝试失败恢复成功率",
    definition: "周期内结束的失败代理尝试中，同一任务之后有一次产出可审查修改的尝试所占比例。后续尝试按查询时计。",
  }, failedAttempts.filter(recoveredAttempt).length, failedAttempts.length));

  // 14. Duplicate jobs (should be 0).
  const runsInPeriod = rows.runs.filter((run) => inPeriod(ms(run.created_at)));
  const groups = new Map<string, PilotRows["runs"]>();
  for (const run of rows.runs) {
    const tags = [`tag:${run.submit_tag}`];
    if (run.scheduler_job_id) tags.push(`job:${run.runner_id ?? ""}:${run.scheduler_job_id}`);
    for (const tag of tags) groups.set(tag, [...(groups.get(tag) ?? []), run]);
  }
  const duplicates = new Set<string>();
  for (const members of groups.values()) {
    if (members.length < 2 || !members.some((run) => inPeriod(ms(run.created_at)))) continue;
    const ordered = [...members].sort((a, b) => ms(a.created_at) - ms(b.created_at) || (a.id < b.id ? -1 : 1));
    for (const run of ordered.slice(1)) duplicates.add(run.id);
  }
  metrics.push(countMetric({
    key: "duplicate_jobs", group: "正确性", label: "重复作业数量（应为 0）",
    definition: "与更早的运行共用同一执行器上的调度器作业 ID，或共用提交标签的运行数（每组保留最早一条，其余计为重复）。只看至少一条在周期内创建的组。这是正确性门槛，不与其他指标相抵。",
    caveat: "提交标签在数据库中有唯一约束，因此重复只可能来自调度器作业 ID。",
  }, duplicates.size, runsInPeriod.length));

  // 15. Reproduction ratio (ReproductionView semantics, results-contract.ts).
  let reruns = 0;
  let reproduced = 0;
  for (const run of rows.runs) {
    if (run.status !== "completed" || !inPeriod(ms(run.ended_at))) continue;
    const previous = rows.runs
      .filter((other) => other.run_spec_sha256 === run.run_spec_sha256 && other.status === "completed" && other.attempt < run.attempt)
      .sort((a, b) => b.attempt - a.attempt)[0];
    if (!previous) continue;
    reruns += 1;
    const tolerance = parseObject(run.budget_json)?.reproTolerance;
    const limit = finite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_REPRO_TOLERANCE;
    const current = metricValues(run.metrics_json) ?? {};
    const prior = metricValues(previous.metrics_json) ?? {};
    const shared = Object.keys(current).filter((name) => name in prior);
    if (shared.length && shared.every((name) => Math.abs(current[name] - prior[name]) <= limit)) reproduced += 1;
  }
  metrics.push(ratioMetric({
    key: "reproduction_ratio", group: "可复现", label: "结果可复现比例",
    definition: "周期内结束的、同一运行规格的重复执行中，与上一次已完成执行相比所有共同指标的差值都在容差内（任务预算 reproTolerance，默认 0.01；至少比较一项）的比例，与运行详情的“复现检查”口径相同。",
    caveat: "只覆盖做过重复执行的运行；从未重跑的结果不计入分母。",
  }, reproduced, reruns, "周期内没有同一运行规格的重复执行"));

  // 16. Not measurable.
  metrics.push(unavailableMetric({
    key: "mentor_evidence_lookup_time", group: "可追溯", label: "导师找到原始证据所需时间",
    definition: "导师从开始查找到打开对应原始证据（提交、运行、产物）所用的时间。",
  }, "duration", "分钟", "需要界面操作计时（埋点），平台没有也不打算默认采集这类个人操作数据；可在试点中用有人陪同的计时任务单独测量。"));

  return {
    period: { from: period.from, to: period.to },
    note: PILOT_PURPOSE_NOTE,
    percentileMethod: "中位数取中间值（偶数个样本取中间两个的平均）；P90 取第 ⌈0.9n⌉ 小的值。时长单位为分钟。",
    metrics,
  };
}

// ---------------------------------------------------------------------------
// D1 read: only the columns the definitions need; never student or user ids.
// ---------------------------------------------------------------------------

export async function readPilotMetrics(d1: D1Database, period: PilotPeriod): Promise<PilotMetricsReport> {
  const [tasks, changeRequests, attempts, runs] = await Promise.all([
    d1.prepare(`SELECT t.id,
        (SELECT MIN(v.confirmed_at) FROM research_task_versions v WHERE v.task_id = t.id AND v.confirmed_at IS NOT NULL) AS first_confirmed_at,
        g.created_at AS guidance_created_at
      FROM research_tasks t
      LEFT JOIN student_guidance_notes g ON g.id = t.source_guidance_note_id`).all<PilotRows["tasks"][number]>(),
    d1.prepare(`SELECT cr.id, cr.task_id, cr.status, cr.pr_number, cr.created_at, cr.updated_at,
        EXISTS (SELECT 1 FROM github_webhook_deliveries w WHERE w.status = 'processed'
          AND json_valid(w.summary_json) AND json_extract(w.summary_json, '$.changeRequestId') = cr.id) AS webhook_touched
      FROM change_requests cr`).all<PilotRows["changeRequests"][number]>(),
    d1.prepare(`SELECT a.id, a.task_id, a.status, a.created_at, a.started_at, a.ended_at, a.usage_json,
        EXISTS (SELECT 1 FROM agent_attempt_plans p WHERE p.attempt_id = a.id) AS plan_first
      FROM agent_attempts a`).all<PilotRows["attempts"][number]>(),
    d1.prepare(`SELECT r.id, r.task_id, r.run_spec_sha256, r.attempt, r.status, r.submit_tag, r.runner_id, r.scheduler_job_id,
        r.created_at, r.queued_at, r.started_at, r.ended_at, rv.state AS review_state, res.metrics_json, v.budget_json
      FROM runs r
      JOIN run_specs s ON s.sha256 = r.run_spec_sha256
      LEFT JOIN research_task_versions v ON v.task_id = s.task_id AND v.version = s.task_version
      LEFT JOIN result_reviews rv ON rv.run_id = r.id
      LEFT JOIN run_results res ON res.run_id = r.id`).all<PilotRows["runs"][number]>(),
  ]);
  return buildPilotMetrics(period, {
    tasks: tasks.results, changeRequests: changeRequests.results, attempts: attempts.results, runs: runs.results,
  });
}
