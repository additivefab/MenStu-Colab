"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PilotMetric, PilotMetricsReport } from "../../lib/loop-pilot-metrics";
import { getJson } from "./api";
import { ErrorNote } from "./ui";
import styles from "./pilot-metrics.module.css";

const NOTE = "这些是流程指标，用于评估平台本身，不用于评价学生";
const PRESETS = [7, 30, 90] as const;

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function shiftDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10);
}

const number = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });

function valueText(metric: PilotMetric) {
  if (metric.kind === "ratio") {
    if (metric.value === null) return null;
    return `${number(metric.value * 100)}%（${metric.numerator ?? 0}/${metric.denominator ?? 0}）`;
  }
  if (metric.kind === "count") return metric.value === null ? null : `${metric.value} ${metric.unit}`;
  if (metric.median === null) return null;
  const unit = metric.unit === "分钟" ? " 分钟" : ` ${metric.unit}`;
  return `中位 ${number(metric.median)}${unit} · P90 ${number(metric.p90 ?? metric.median)}${unit}`;
}

/** Collapsed by default; the metrics are only requested once it is opened. */
export function PilotMetricsSection() {
  const [open, setOpen] = useState(false);
  return <details className={styles.section} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><h4 className={styles.title}>试点流程指标</h4><span className={styles.muted}>只看流程，不看个人</span></summary>
    {open ? <PilotMetrics /> : null}
  </details>;
}

/** Superadmin-only pilot process metrics (plan G5): aggregate, never per person. */
export function PilotMetrics() {
  const [to, setTo] = useState(shanghaiToday);
  const [from, setFrom] = useState(() => shiftDays(shanghaiToday(), -29));
  const [query, setQuery] = useState(() => ({ from, to, round: 0 }));
  const [data, setData] = useState<PilotMetricsReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const queryString = new URLSearchParams({ from: query.from, to: query.to }).toString();
  const requestKey = `${queryString}#${query.round}`;
  const [settled, setSettled] = useState<string | null>(null);
  const loading = settled !== requestKey;

  const load = useCallback((signal: AbortSignal) => {
    return getJson<PilotMetricsReport>(`/api/admin/pilot-metrics?${queryString}`, "试点流程指标读取失败", signal).then(
      (payload) => { if (!signal.aborted) { setData(payload); setError(null); setSettled(requestKey); } },
      (failure: unknown) => { if (!signal.aborted) { setError(failure); setSettled(requestKey); } },
    );
  }, [queryString, requestKey]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery((current) => ({ from, to, round: current.round + 1 }));
  }

  function preset(days: number) {
    const end = shanghaiToday();
    const start = shiftDays(end, -(days - 1));
    setFrom(start); setTo(end); setQuery((current) => ({ from: start, to: end, round: current.round + 1 }));
  }

  return <div className={styles.root}>
    <p className={styles.note}>{NOTE}。只显示全体试点的汇总分布，不按学生或个人拆分，也不排名。</p>
    <form className={styles.period} onSubmit={submit} aria-label="统计周期">
      <label>开始<input type="date" value={from} max={to} required onChange={(event) => setFrom(event.target.value)} /></label>
      <label>结束<input type="date" value={to} min={from} required onChange={(event) => setTo(event.target.value)} /></label>
      <button type="submit" disabled={loading}>{loading ? "正在统计…" : "统计"}</button>
      <span className={styles.presets}>{PRESETS.map((days) => <button key={days} type="button" disabled={loading} onClick={() => preset(days)}>近 {days} 天</button>)}</span>
    </form>
    <ErrorNote error={error} />
    {!data && !error ? <p className={styles.muted} role="status">正在读取…</p> : null}
    {data ? <>
      <div className={styles.tableWrap}><table className={styles.table}>
        <caption>{data.period.from} 至 {data.period.to}（北京时间，含首尾两天）</caption>
        <thead><tr><th scope="col">指标</th><th scope="col">数值</th><th scope="col">样本量</th><th scope="col">口径</th></tr></thead>
        <tbody>{data.metrics.map((metric) => {
          const text = valueText(metric);
          return <tr key={metric.key}>
            <th scope="row">{metric.label}<small>{metric.group}</small></th>
            <td className={styles.value}>{text ?? <span className={styles.unavailable}>{metric.computable ? "无样本" : "无法计算"}</span>}
              {text === null && metric.reason ? <small>{metric.reason}</small> : null}</td>
            <td className={styles.sample}>{metric.computable ? metric.sampleSize : "—"}</td>
            <td>{metric.definition}{metric.caveat ? <small className={styles.caveat}>{metric.caveat}</small> : null}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <p className={styles.muted}>{data.percentileMethod}</p>
    </> : null}
  </div>;
}
