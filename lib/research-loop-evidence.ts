// Weekly-meeting evidence list (frontend plan FA4, contract
// lib/research-loop/results-contract.ts → EvidenceReport). It lists what
// happened for one student in a period — tasks progressed, change requests
// (PRs), runs and open blockers — so the student can explain why and what
// next. It is a list of facts only: no activity score, no counts across
// students, no ranking.
//
// Period: inclusive Asia/Shanghai calendar days [from, to], at most 62 days,
// default the last 7 days ending today. Instants are bounded like
// lib/monthly-delivery.ts: day start = UTC midnight − 8 h, end exclusive.
//
// Output never contains file contents, credentials, hashes or SHAs.

import { calendarDayDiff, instantTimestamp, shanghaiDateKey } from "./dashboard-overview/dates.ts";
import type { EvidenceReport } from "./research-loop/results-contract.ts";

export const EVIDENCE_MAX_DAYS = 62;
export const EVIDENCE_DEFAULT_DAYS = 7;
/** A draft version older than this many calendar days at period end is a blocker. */
export const UNCONFIRMED_DRAFT_DAYS = 3;

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IN_FLIGHT = new Set(["awaiting_approval", "queued", "dispatching", "running", "collecting", "cancel_requested", "reconciling"]);
const TASK_ENDED = new Set(["closed", "canceled"]);
const FAILURE_REASON_MAX = 300;

export class EvidenceInputError extends Error {}

export type EvidencePeriod = {
  from: string;
  to: string;
  /** Inclusive start instant (ms). */
  start: number;
  /** Exclusive end instant (ms). */
  end: number;
};

function utcMidnight(dateKey: string) {
  if (!DATE_PATTERN.test(dateKey)) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = Date.UTC(year, month - 1, day);
  return new Date(value).toISOString().slice(0, 10) === dateKey ? value : null;
}

function shiftDays(dateKey: string, days: number) {
  return new Date((utcMidnight(dateKey) as number) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Validates the query period; missing bounds default to the last 7 days ending today (Shanghai). */
export function parseEvidencePeriod(rawFrom: string | null, rawTo: string | null, now: Date | string = new Date()): EvidencePeriod {
  const fromInput = rawFrom?.trim() || null;
  const toInput = rawTo?.trim() || null;
  for (const value of [fromInput, toInput]) {
    if (value !== null && utcMidnight(value) === null) throw new EvidenceInputError("日期格式无效，应为 YYYY-MM-DD");
  }
  const today = shanghaiDateKey(now);
  if (!today) throw new EvidenceInputError("当前时间无效");
  const to = toInput ?? today;
  const from = fromInput ?? shiftDays(to, -(EVIDENCE_DEFAULT_DAYS - 1));
  const span = calendarDayDiff(to, from);
  if (span === null) throw new EvidenceInputError("日期格式无效，应为 YYYY-MM-DD");
  if (span < 0) throw new EvidenceInputError("开始日期不能晚于结束日期");
  if (span + 1 > EVIDENCE_MAX_DAYS) throw new EvidenceInputError(`统计周期不能超过 ${EVIDENCE_MAX_DAYS} 天`);
  return {
    from, to,
    start: (utcMidnight(from) as number) - SHANGHAI_OFFSET_MS,
    end: (utcMidnight(to) as number) + DAY_MS - SHANGHAI_OFFSET_MS,
  };
}

// ---------------------------------------------------------------------------
// Rows (snake_case, as read from D1)
// ---------------------------------------------------------------------------

export type EvidenceTaskRow = { id: string; title: string; status: string; created_at: string; updated_at: string };
export type EvidenceTaskEventRow = { id: number; task_id: string; version: number; action: string; created_at: string };
export type EvidenceTaskVersionRow = { task_id: string; version: number; created_at: string; confirmed_at: string | null };
export type EvidenceChangeRequestRow = {
  id: string; task_id: string; pr_number: number | null; pr_url: string; status: string; created_at: string; updated_at: string;
};
export type EvidenceRunRow = {
  id: string; task_id: string; status: string; failure_reason: string; created_at: string; ended_at: string | null;
  technical_validity: string | null; metrics_json: string | null; review_state: string | null; interpreted: number | null;
};
export type EvidenceRows = {
  tasks: EvidenceTaskRow[];
  events: EvidenceTaskEventRow[];
  versions: EvidenceTaskVersionRow[];
  changeRequests: EvidenceChangeRequestRow[];
  runs: EvidenceRunRow[];
};

const time = (value: string | null | undefined) => (value ? instantTimestamp(value) : Number.NaN);
const iso = (value: string | null) => {
  const ms = time(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byTimeThenId = <T>(timeOf: (item: T) => number, idOf: (item: T) => string) => (a: T, b: T) => {
  const ta = timeOf(a), tb = timeOf(b);
  const fa = Number.isFinite(ta), fb = Number.isFinite(tb);
  if (fa !== fb) return fa ? -1 : 1;
  if (fa && ta !== tb) return ta - tb;
  return compareId(idOf(a), idOf(b));
};

/** Same rule as components/research-loop/numbering.ts: per-task creation order, then id. */
function runNumbers(runs: readonly EvidenceRunRow[]) {
  const byTask = new Map<string, EvidenceRunRow[]>();
  for (const run of runs) byTask.set(run.task_id, [...(byTask.get(run.task_id) ?? []), run]);
  const numbers = new Map<string, number>();
  for (const list of byTask.values()) {
    list.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : compareId(a.id, b.id)));
    list.forEach((run, index) => numbers.set(run.id, index + 1));
  }
  return numbers;
}

/** metrics_json is the canonical tanyan.metrics/v1 file; only finite numeric values are returned. */
function metricsOf(json: string | null): { [name: string]: number } | null {
  if (!json) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const values = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { values?: unknown }).values : null;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const metrics: { [name: string]: number } = {};
  for (const name of Object.keys(values).sort()) {
    const value = (values as Record<string, unknown>)[name];
    if (typeof value === "number" && Number.isFinite(value)) metrics[name] = value;
  }
  return Object.keys(metrics).length ? metrics : null;
}

function shortReason(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > FAILURE_REASON_MAX ? `${text.slice(0, FAILURE_REASON_MAX)}…` : text;
}

/** Pure assembly from one student's rows; exported for tests. */
export function buildEvidenceReport(studentId: string, period: EvidencePeriod, rows: EvidenceRows): EvidenceReport {
  const inPeriod = (value: string | null | undefined) => {
    const ms = time(value);
    return Number.isFinite(ms) && ms >= period.start && ms < period.end;
  };
  const beforeEnd = (value: string | null | undefined) => {
    const ms = time(value);
    return Number.isFinite(ms) && ms < period.end;
  };
  const taskById = new Map(rows.tasks.map((task) => [task.id, task]));
  const title = (taskId: string) => taskById.get(taskId)?.title ?? "研究任务";
  const numbers = runNumbers(rows.runs);
  const runLabel = (runId: string) => {
    const number = numbers.get(runId);
    return number ? `运行 #${number}` : "运行";
  };

  // A task closed or canceled at or before period end no longer blocks.
  const taskEndedAt = new Map<string, number>();
  for (const event of rows.events) {
    if (!TASK_ENDED.has(event.action)) continue;
    const ms = time(event.created_at);
    if (Number.isFinite(ms) && ms < (taskEndedAt.get(event.task_id) ?? Infinity)) taskEndedAt.set(event.task_id, ms);
  }
  for (const task of rows.tasks) {
    if (TASK_ENDED.has(task.status) && !taskEndedAt.has(task.id)) taskEndedAt.set(task.id, time(task.updated_at));
  }
  const activeAtEnd = (taskId: string) => {
    if (!taskById.has(taskId)) return false;
    const ended = taskEndedAt.get(taskId);
    return ended === undefined || !Number.isFinite(ended) || ended >= period.end;
  };

  // Change requests created in the period.
  const changeRequests = rows.changeRequests
    .filter((cr) => inPeriod(cr.created_at))
    .sort(byTimeThenId((cr) => time(cr.created_at), (cr) => cr.id))
    .map((cr) => ({
      id: cr.id, taskId: cr.task_id, prNumber: cr.pr_number ?? null, prUrl: cr.pr_url ?? "",
      status: cr.status, createdAt: iso(cr.created_at) ?? cr.created_at,
    }));

  // Runs that ended in the period, then runs still in flight (created before period end).
  const ended = rows.runs
    .filter((run) => !IN_FLIGHT.has(run.status) && inPeriod(run.ended_at))
    .sort(byTimeThenId((run) => time(run.ended_at), (run) => run.id));
  const inFlight = rows.runs
    .filter((run) => IN_FLIGHT.has(run.status) && beforeEnd(run.created_at))
    .sort(byTimeThenId((run) => time(run.created_at), (run) => run.id));
  const runs = [...ended, ...inFlight].map((run) => ({
    runId: run.id,
    taskId: run.task_id,
    number: numbers.get(run.id) ?? null,
    status: run.status,
    technicalValidity: run.technical_validity ?? null,
    reviewState: run.review_state ?? null,
    endedAt: iso(run.ended_at),
    metrics: metricsOf(run.metrics_json),
    failureReason: shortReason(run.failure_reason ?? ""),
    interpreted: Boolean(run.interpreted),
  }));

  // Tasks created, confirmed or otherwise updated in the period, plus the
  // tasks the listed change requests and runs belong to.
  const confirmed = new Map<string, Set<number>>();
  const markConfirmed = (taskId: string, version: number) => {
    const set = confirmed.get(taskId) ?? new Set<number>();
    set.add(version);
    confirmed.set(taskId, set);
  };
  for (const version of rows.versions) if (inPeriod(version.confirmed_at)) markConfirmed(version.task_id, version.version);
  for (const event of rows.events) if (event.action === "confirmed" && inPeriod(event.created_at)) markConfirmed(event.task_id, event.version);
  const touched = new Set<string>();
  for (const task of rows.tasks) if (inPeriod(task.created_at) || inPeriod(task.updated_at)) touched.add(task.id);
  for (const event of rows.events) if (inPeriod(event.created_at)) touched.add(event.task_id);
  for (const taskId of confirmed.keys()) touched.add(taskId);
  for (const cr of changeRequests) touched.add(cr.taskId);
  for (const run of runs) touched.add(run.taskId);
  const tasks = [...touched]
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is EvidenceTaskRow => Boolean(task))
    .sort(byTimeThenId((task) => time(task.created_at), (task) => task.id))
    .map((task) => ({
      taskId: task.id, title: task.title, status: task.status,
      versionsConfirmed: confirmed.get(task.id)?.size ?? 0, created: inPeriod(task.created_at),
    }));

  // Blockers, as of period end.
  type Blocker = EvidenceReport["blockers"][number] & { at: number; sortId: string };
  const blockers: Blocker[] = [];
  const newer = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) => {
    const ta = time(a.created_at), tb = time(b.created_at);
    return ta !== tb ? ta > tb : a.id > b.id;
  };
  // 1) Failed runs not followed by a newer completed run in the same task.
  for (const run of rows.runs) {
    if (run.status !== "failed" || !activeAtEnd(run.task_id)) continue;
    const endedAt = run.ended_at ?? run.created_at;
    if (!beforeEnd(endedAt)) continue;
    const cleared = rows.runs.some((other) => other.task_id === run.task_id && other.status === "completed"
      && beforeEnd(other.ended_at) && newer(other, run));
    if (cleared) continue;
    const reason = shortReason(run.failure_reason ?? "");
    blockers.push({
      kind: "run_failed", taskId: run.task_id, runId: run.id, at: time(endedAt), sortId: run.id,
      text: `「${title(run.task_id)}」${runLabel(run.id)} 失败${reason ? `：${reason}` : ""}，之后还没有成功的运行`,
    });
  }
  // 2) Change requests rejected or failed, not followed by a newer open or merged one in the same task.
  for (const cr of rows.changeRequests) {
    if ((cr.status !== "rejected" && cr.status !== "failed") || !activeAtEnd(cr.task_id)) continue;
    if (!beforeEnd(cr.updated_at) && !beforeEnd(cr.created_at)) continue;
    const superseded = rows.changeRequests.some((other) => other.task_id === cr.task_id
      && (other.status === "open" || other.status === "merged") && beforeEnd(other.created_at) && newer(other, cr));
    if (superseded) continue;
    const pr = cr.pr_number ? `PR #${cr.pr_number}` : "代码变更";
    blockers.push({
      kind: "change_failed", taskId: cr.task_id, runId: null,
      at: beforeEnd(cr.updated_at) ? time(cr.updated_at) : time(cr.created_at), sortId: cr.id,
      text: `「${title(cr.task_id)}」${pr} ${cr.status === "rejected" ? "已被退回" : "发布失败"}，还没有新的变更`,
    });
  }
  // 3) Draft versions unconfirmed for more than 3 calendar days at period end.
  const latestVersion = new Map<string, EvidenceTaskVersionRow>();
  for (const version of rows.versions) {
    if (!beforeEnd(version.created_at)) continue;
    const previous = latestVersion.get(version.task_id);
    if (!previous || version.version > previous.version) latestVersion.set(version.task_id, version);
  }
  for (const [taskId, version] of latestVersion) {
    if (!activeAtEnd(taskId)) continue;
    if (version.confirmed_at && beforeEnd(version.confirmed_at)) continue;
    const createdDay = shanghaiDateKey(version.created_at);
    const age = createdDay ? calendarDayDiff(period.to, createdDay) : null;
    if (age === null || age <= UNCONFIRMED_DRAFT_DAYS) continue;
    blockers.push({
      kind: "task_unconfirmed", taskId, runId: null, at: time(version.created_at), sortId: taskId,
      text: `「${title(taskId)}」第 ${version.version} 版任务草稿已 ${age} 天未确认`,
    });
  }
  blockers.sort(byTimeThenId((item) => item.at, (item) => `${item.sortId}\u0000${item.kind}`));

  return {
    studentId,
    period: { from: period.from, to: period.to },
    tasks,
    changeRequests,
    runs,
    blockers: blockers.map(({ kind, text, taskId, runId }) => ({ kind, text, taskId, runId })),
  };
}

/** Reads one student's research-loop rows and assembles the report. Authorization is the caller's job. */
export async function readEvidenceReport(d1: D1Database, studentId: string, period: EvidencePeriod): Promise<EvidenceReport> {
  const [tasks, events, versions, changeRequests, runs] = await Promise.all([
    d1.prepare(`SELECT id, title, status, created_at, updated_at FROM research_tasks WHERE student_id = ?`)
      .bind(studentId).all<EvidenceTaskRow>(),
    d1.prepare(`SELECT e.id, e.task_id, e.version, e.action, e.created_at FROM research_task_events e
      JOIN research_tasks t ON t.id = e.task_id WHERE t.student_id = ?`).bind(studentId).all<EvidenceTaskEventRow>(),
    d1.prepare(`SELECT v.task_id, v.version, v.created_at, v.confirmed_at FROM research_task_versions v
      JOIN research_tasks t ON t.id = v.task_id WHERE t.student_id = ?`).bind(studentId).all<EvidenceTaskVersionRow>(),
    d1.prepare(`SELECT c.id, c.task_id, c.pr_number, c.pr_url, c.status, c.created_at, c.updated_at FROM change_requests c
      JOIN research_tasks t ON t.id = c.task_id WHERE c.student_id = ? AND t.student_id = c.student_id`)
      .bind(studentId).all<EvidenceChangeRequestRow>(),
    d1.prepare(`SELECT r.id, r.task_id, r.status, r.failure_reason, r.created_at, r.ended_at,
        rr.technical_validity, rr.metrics_json, rv.state AS review_state,
        EXISTS (SELECT 1 FROM result_interpretations i WHERE i.run_id = r.id) AS interpreted
      FROM runs r JOIN research_tasks t ON t.id = r.task_id
      LEFT JOIN run_results rr ON rr.run_id = r.id
      LEFT JOIN result_reviews rv ON rv.run_id = r.id
      WHERE r.student_id = ? AND t.student_id = r.student_id`).bind(studentId).all<EvidenceRunRow>(),
  ]);
  return buildEvidenceReport(studentId, period, {
    tasks: tasks.results, events: events.results, versions: versions.results,
    changeRequests: changeRequests.results, runs: runs.results,
  });
}
