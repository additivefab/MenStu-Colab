"use client";

// FA4 周会证据清单 (frontend plan §四): the platform lists what the loop
// recorded in a period — tasks, PRs, runs and blockers — and the student adds
// "为什么这样做、意味着什么、下一步如何判断". Nothing here scores, ranks or
// counts activity; section headings carry no totals.

import { useEffect, useState } from "react";
import type { EvidenceReport } from "../../lib/research-loop/results-contract.ts";
import { getJson } from "./api";
import {
  EVIDENCE_MAX_DAYS, STUDENT_EXPLANATION_PROMPTS, evidenceReportText, evidenceToday, evidenceUrl, loopCardHref, metricsSummary,
  needsInterpretation, presetPeriod, validatePeriod, type EvidencePeriod, type EvidencePreset,
} from "./evidence-model";
import { changeRequestStatusLabels, reviewStateLabels, runStatusLabels, taskStatusLabels, validityLabels, type Tone } from "./labels";
import { runLabel } from "./numbering";
import { CopyButton, ErrorNote, Pill } from "./ui";
import styles from "./research-loop.module.css";
import ev from "./evidence-list.module.css";

const presets: [EvidencePreset, string][] = [["week", "最近 7 天"], ["month", "本月"], ["custom", "自定义"]];

const blockerLabels: Record<EvidenceReport["blockers"][number]["kind"], string> = {
  run_failed: "运行失败",
  change_failed: "变更未通过",
  task_unconfirmed: "任务待确认",
};

function label(map: Record<string, [string, Tone]>, value: string | null) {
  if (!value) return null;
  const [text, tone] = map[value] ?? [value, "neutral" as Tone];
  return <Pill tone={tone}>{text}</Pill>;
}

function dateOnly(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

export function EvidenceList({ studentId, mode, inPage = false }: {
  studentId: string;
  mode: "student" | "staff";
  /** True on the student profile, where loop cards are reachable by in-page hashes. */
  inPage?: boolean;
}) {
  const staff = mode === "staff";
  const [open, setOpen] = useState(!staff);
  const [today] = useState(() => evidenceToday());
  const [preset, setPreset] = useState<EvidencePreset>("week");
  const [period, setPeriod] = useState<EvidencePeriod>(() => presetPeriod("week", today));
  const [customFrom, setCustomFrom] = useState(() => presetPeriod("week", today).from);
  const [customTo, setCustomTo] = useState(today);
  const [customError, setCustomError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  // Last finished request; loading is derived from whether it matches the current one.
  const [result, setResult] = useState<{ key: string; report: EvidenceReport | null; error: unknown } | null>(null);
  const url = evidenceUrl(studentId, period);
  const requestKey = `${url}#${reloadKey}`;
  const loading = open && result?.key !== requestKey;
  const report = result?.report ?? null;
  const error = result?.key === requestKey ? result.error : null;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    getJson<EvidenceReport>(url, "证据清单加载失败，请重试", controller.signal)
      .then((payload) => setResult({ key: requestKey, report: payload, error: null }))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, report: null, error: failure });
      });
    return () => controller.abort();
  }, [open, url, requestKey]);

  function choosePreset(next: EvidencePreset) {
    setPreset(next); setCustomError("");
    if (next !== "custom") setPeriod(presetPeriod(next, today));
  }

  function applyCustom() {
    const result = validatePeriod(customFrom, customTo);
    if ("error" in result) return setCustomError(result.error);
    setCustomError("");
    setPeriod(result.period);
  }

  const titles = new Map(report?.tasks.map((task) => [task.taskId, task.title]) ?? []);
  const taskName = (taskId: string) => titles.get(taskId) ?? "研究任务";
  const href = (kind: "task" | "run", id: string) => loopCardHref(studentId, { kind, id }, inPage);
  const toExplain = !staff && report ? report.runs.filter(needsInterpretation) : [];

  const body = <div className={ev.body}>
    <p className={ev.intro}>{staff
      ? "平台按周期列出任务、PR、运行和阻塞，供周会核对证据；学生对结果的解释见各运行的解读。清单不用于评分或排名。"
      : `平台列出这段时间留下的证据。周会前请补充：${STUDENT_EXPLANATION_PROMPTS.join("、")}。`}</p>

    <div className={ev.periodBar} role="group" aria-label="选择周期">
      {presets.map(([value, text]) => <button key={value} type="button" aria-pressed={preset === value} className={preset === value ? ev.presetActive : undefined} onClick={() => choosePreset(value)}>{text}</button>)}
      <span className={ev.periodText}>{period.from} 至 {period.to}</span>
    </div>
    {preset === "custom" ? <div className={ev.custom}>
      <label>开始<input type="date" value={customFrom} max={customTo || undefined} onChange={(event) => setCustomFrom(event.target.value)} /></label>
      <label>结束<input type="date" value={customTo} min={customFrom || undefined} onChange={(event) => setCustomTo(event.target.value)} /></label>
      <button type="button" onClick={applyCustom}>查看</button>
      <small>最长 {EVIDENCE_MAX_DAYS} 天</small>
      {customError ? <p className={styles.error} role="alert">{customError}</p> : null}
    </div> : null}

    {loading && !report ? <p className={styles.muted} role="status">正在加载证据清单…</p> : null}
    {error ? <div className={ev.retry}><ErrorNote error={error} /><button type="button" onClick={() => setReloadKey((key) => key + 1)}>重试</button></div> : null}

    {report ? <div className={ev.sections} aria-busy={loading || undefined}>
      {toExplain.length ? <div className={ev.prompt} role="note">
        <strong>这些运行还没有你的解读</strong>
        <span>说明它意味着什么、可能的其他解释和下一步如何判断，导师评审前就能看到。</span>
        <ul>{toExplain.map((run) => <li key={run.runId}><a href={href("run", run.runId)}>{runLabel(run.number)} · {taskName(run.taskId)}：补充解读 ›</a></li>)}</ul>
      </div> : null}

      <section aria-labelledby={`evidence-tasks-${studentId}`}>
        <h5 id={`evidence-tasks-${studentId}`}>推进的任务</h5>
        {report.tasks.length ? <ul className={ev.items}>{report.tasks.map((task) => <li key={task.taskId}>
          <a href={href("task", task.taskId)}>{task.title}</a>
          <span className={ev.meta}>{label(taskStatusLabels, task.status)}{task.created ? <small>本周期新建</small> : null}{task.versionsConfirmed > 0 ? <small>本周期有版本确认</small> : null}</span>
        </li>)}</ul> : <p className={ev.none}>这段时间没有任务变化</p>}
      </section>

      <section aria-labelledby={`evidence-prs-${studentId}`}>
        <h5 id={`evidence-prs-${studentId}`}>产生的 PR</h5>
        {report.changeRequests.length ? <ul className={ev.items}>{report.changeRequests.map((item) => <li key={item.id}>
          {item.prUrl ? <a href={item.prUrl} target="_blank" rel="noopener noreferrer">{item.prNumber ? `PR #${item.prNumber}` : "查看 PR"}</a> : <span>{item.prNumber ? `PR #${item.prNumber}` : "变更（未开 PR）"}</span>}
          <span className={ev.meta}>{label(changeRequestStatusLabels, item.status)}<a href={href("task", item.taskId)}>{taskName(item.taskId)}</a><small>{dateOnly(item.createdAt)}</small></span>
        </li>)}</ul> : <p className={ev.none}>这段时间没有新的 PR</p>}
      </section>

      <section aria-labelledby={`evidence-runs-${studentId}`}>
        <h5 id={`evidence-runs-${studentId}`}>跑过的运行</h5>
        {report.runs.length ? <ul className={ev.items}>{report.runs.map((run) => {
          const metrics = metricsSummary(run.metrics);
          return <li key={run.runId}>
            <a href={href("run", run.runId)}>{runLabel(run.number)} · {taskName(run.taskId)}</a>
            <span className={ev.meta}>
              {label(runStatusLabels, run.status)}
              {label(validityLabels, run.technicalValidity)}
              {label(reviewStateLabels, run.reviewState)}
              {run.interpreted ? <Pill tone="neutral">已写解读</Pill> : <Pill tone="warn">尚未解读</Pill>}
              {run.endedAt ? <small>{dateOnly(run.endedAt)}</small> : null}
            </span>
            {metrics ? <code className={ev.metrics}>{metrics}</code> : null}
            {run.failureReason ? <small className={ev.failure}>{run.failureReason}</small> : null}
          </li>;
        })}</ul> : <p className={ev.none}>这段时间没有运行</p>}
      </section>

      <section aria-labelledby={`evidence-blockers-${studentId}`}>
        <h5 id={`evidence-blockers-${studentId}`}>遇到的阻塞</h5>
        {report.blockers.length ? <ul className={ev.items}>{report.blockers.map((blocker, index) => <li key={`${blocker.kind}:${blocker.runId ?? blocker.taskId}:${index}`}>
          <span className={ev.meta}><Pill tone={blocker.kind === "task_unconfirmed" ? "warn" : "bad"}>{blockerLabels[blocker.kind] ?? blocker.kind}</Pill></span>
          <span className={ev.blockerText}>{blocker.text}</span>
          <a href={blocker.runId ? href("run", blocker.runId) : href("task", blocker.taskId)}>查看{blocker.runId ? "运行" : "任务"} ›</a>
        </li>)}</ul> : <p className={ev.none}>这段时间没有记录到阻塞</p>}
      </section>

      <div className={ev.footer}>
        <CopyButton text={evidenceReportText(report)} label={staff ? "复制清单" : "复制清单（含待补充的三个问题）"} />
        <small>{staff ? "清单只列证据，不代表评价。" : "复制后补上你的判断，可用于组会汇报或写进展。"}</small>
      </div>
    </div> : null}
  </div>;

  if (staff) {
    return <details className={`${styles.panel} ${ev.root}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={ev.summary}><strong>周会证据清单</strong><small>按周期列出任务、PR、运行和阻塞</small></summary>
      {open ? body : null}
    </details>;
  }
  return <section className={`${styles.panel} ${ev.root}`} aria-labelledby={`evidence-title-${studentId}`}>
    <h2 id={`evidence-title-${studentId}`} className={ev.title}>周会证据清单</h2>
    {body}
  </section>;
}

/** Notice shown at the top of the student's progress composer when it was
 * opened from a run's progress draft (or the draft could not be found). */
export function ProgressDraftNotice({ text, detail, found }: { text: string; detail?: string; found: boolean }) {
  return <p className={`${ev.draftNotice} ${found ? "" : ev.draftNoticeMuted}`} role="status">
    <span>{text}</span>
    {detail ? <small>{detail}</small> : null}
  </p>;
}
