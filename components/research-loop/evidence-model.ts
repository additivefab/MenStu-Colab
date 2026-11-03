// Pure helpers for FA4 (frontend plan §四): the 周会证据清单 period and links,
// and the hand-off of a run's progress draft into the student's project
// progress composer. No React, no DOM; shapes come from the results contract.
// The list shows what the platform recorded; it never scores or ranks.

import { calendarDayDiff, shanghaiDateKey } from "../../lib/dashboard-overview/dates.ts";
import type { EvidenceReport, ProgressDraft, ProgressDraftSource } from "../../lib/research-loop/results-contract.ts";

/** Longest period the evidence endpoint accepts, counted in calendar days (inclusive). */
export const EVIDENCE_MAX_DAYS = 62;

export type EvidencePreset = "week" | "month" | "custom";
export type EvidencePeriod = { from: string; to: string };

const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/u;

function shiftDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Today's calendar date in the lab's time zone. */
export function evidenceToday(now: Date = new Date()) {
  return shanghaiDateKey(now) ?? now.toISOString().slice(0, 10);
}

/** 最近 7 天 = today and the six days before; 本月 = the 1st of this month to today. */
export function presetPeriod(preset: Exclude<EvidencePreset, "custom">, today: string): EvidencePeriod {
  if (preset === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: shiftDays(today, -6), to: today };
}

/** Validates a custom period; returns the period or a Chinese error message. */
export function validatePeriod(from: string, to: string): { period: EvidencePeriod } | { error: string } {
  if (!dateKeyPattern.test(from) || !dateKeyPattern.test(to)) return { error: "请选择开始和结束日期" };
  const span = calendarDayDiff(to, from);
  if (span === null) return { error: "日期无效" };
  if (span < 0) return { error: "开始日期不能晚于结束日期" };
  if (span + 1 > EVIDENCE_MAX_DAYS) return { error: `周期最长 ${EVIDENCE_MAX_DAYS} 天` };
  return { period: { from, to } };
}

export function evidenceUrl(studentId: string, period: EvidencePeriod) {
  const params = new URLSearchParams({ studentId, from: period.from, to: period.to });
  return `/api/research-loop/evidence?${params.toString()}`;
}

/** Link to a loop card: an in-page hash on the student profile, otherwise the profile URL. */
export function loopCardHref(studentId: string, target: { kind: "task" | "run"; id: string }, inPage: boolean) {
  const hash = `#research-${target.kind}-${target.id}`;
  return inPage ? hash : `/students/${encodeURIComponent(studentId)}${hash}`;
}

/** Runs whose result the student can still explain (terminal and not interpreted). */
export function needsInterpretation(run: EvidenceReport["runs"][number]) {
  return !run.interpreted && (run.status === "completed" || run.status === "failed");
}

/** "name=value · name=value" (first `limit` metrics, stable order). */
export function metricsSummary(metrics: EvidenceReport["runs"][number]["metrics"], limit = 4) {
  if (!metrics) return "";
  const entries = Object.entries(metrics).filter(([, value]) => typeof value === "number" && Number.isFinite(value));
  const shown = entries.slice(0, limit).map(([name, value]) => `${name}=${value}`);
  if (entries.length > limit) shown.push("…");
  return shown.join(" · ");
}

export const STUDENT_EXPLANATION_PROMPTS = ["为什么这样做", "意味着什么", "下一步如何判断"] as const;

/** Plain-text list for the weekly meeting, with blanks for the student's explanation. */
export function evidenceReportText(report: EvidenceReport) {
  const titles = new Map(report.tasks.map((task) => [task.taskId, task.title]));
  const taskName = (taskId: string) => titles.get(taskId) ?? "研究任务";
  const lines = [`周会证据清单（${report.period.from} 至 ${report.period.to}）`, "", "推进的任务："];
  if (report.tasks.length) for (const task of report.tasks) lines.push(`- ${task.title}${task.created ? "（本周期新建）" : ""}`);
  else lines.push("- 无");
  lines.push("", "产生的 PR：");
  if (report.changeRequests.length) for (const item of report.changeRequests) lines.push(`- ${item.prNumber ? `PR #${item.prNumber}` : "变更（未开 PR）"} · ${taskName(item.taskId)}${item.prUrl ? ` · ${item.prUrl}` : ""}`);
  else lines.push("- 无");
  lines.push("", "跑过的运行：");
  if (report.runs.length) {
    for (const run of report.runs) {
      const metrics = metricsSummary(run.metrics);
      lines.push(`- ${run.number ? `运行 #${run.number}` : "运行"} · ${taskName(run.taskId)}${metrics ? ` · ${metrics}` : ""}${run.interpreted ? "" : "（尚未解读）"}`);
    }
  } else lines.push("- 无");
  lines.push("", "遇到的阻塞：");
  if (report.blockers.length) for (const blocker of report.blockers) lines.push(`- ${blocker.text}`);
  else lines.push("- 无");
  lines.push("");
  for (const prompt of STUDENT_EXPLANATION_PROMPTS) lines.push(`${prompt}：`, "");
  return lines.join("\n").trimEnd();
}

// ---- progress draft → project progress composer ----

const runIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

/** Run id from the `draftRun` query value, or null when it is not a plausible id. */
export function draftRunParam(value: string | null) {
  return value && runIdPattern.test(value) ? value : null;
}

function isSource(value: unknown): value is ProgressDraftSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return (source.sourceType === "url" || source.sourceType === "git") && typeof source.label === "string" && typeof source.ref === "string";
}

/** Parses a stored draft (JSON text or object); null when missing or malformed. */
export function parseProgressDraft(raw: unknown): ProgressDraft | null {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.title !== "string" || typeof draft.summary !== "string" || typeof draft.evidence !== "string") return null;
  if (!draft.title.trim() && !draft.summary.trim()) return null;
  const sources = Array.isArray(draft.evidenceSources) ? draft.evidenceSources.filter(isSource) : [];
  const from = draft.from && typeof draft.from === "object" ? draft.from as Record<string, unknown> : {};
  return {
    kind: "项目",
    title: draft.title,
    summary: draft.summary,
    evidence: draft.evidence,
    evidenceSources: sources,
    from: {
      taskId: typeof from.taskId === "string" ? from.taskId : "",
      runId: typeof from.runId === "string" ? from.runId : "",
      changeRequestId: typeof from.changeRequestId === "string" ? from.changeRequestId : null,
      interpretationVersion: typeof from.interpretationVersion === "number" ? from.interpretationVersion : null,
    },
  };
}

/** Per-task run number named in the draft ("运行 #3"), or null. */
export function draftRunNumber(draft: ProgressDraft) {
  const match = /运行\s*#(\d+)/u.exec(`${draft.title}\n${draft.evidence}\n${draft.summary}`);
  return match ? Number(match[1]) : null;
}

export function draftNoticeText(draft: ProgressDraft | null) {
  if (!draft) return "没有找到这次运行的草稿，已打开空白表单；可以回到结果卡重新生成。";
  const number = draftRunNumber(draft);
  return `已根据${number ? `运行 #${number} ` : "所选运行"}生成草稿，请补充你的判断后提交；提交后仍由导师审核`;
}

const EVIDENCE_LIMIT = 4_000;
const sourceTypeText: Record<ProgressDraftSource["sourceType"], string> = { url: "链接", git: "代码" };

function isHttpsUrl(value: string) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

export type ProgressDraftPrefill = { summary: string; evidence: string; gitUrl: string };

/**
 * Fields of the project progress composer. The composer derives the title
 * from the first line of the summary, so the draft title leads the summary.
 * The first https `git` source fills the Git link; every other source is
 * appended to the evidence text so the whole evidence chain stays visible.
 */
export function progressDraftPrefill(draft: ProgressDraft): ProgressDraftPrefill {
  const title = draft.title.trim();
  const body = draft.summary.trim();
  const summary = !title ? body : body.startsWith(title) ? body : body ? `${title}\n${body}` : title;
  const gitSource = draft.evidenceSources.find((source) => source.sourceType === "git" && isHttpsUrl(source.ref));
  const rest = draft.evidenceSources.filter((source) => source !== gitSource);
  const lines = [draft.evidence.trim()].filter(Boolean);
  if (rest.length) {
    lines.push("证据来源：");
    for (const source of rest) lines.push(`- ${source.label}（${sourceTypeText[source.sourceType]}）：${source.ref}`);
  }
  return { summary, evidence: lines.join("\n").slice(0, EVIDENCE_LIMIT), gitUrl: gitSource?.ref ?? "" };
}
