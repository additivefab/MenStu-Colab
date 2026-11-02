"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ProblemRecordSource, ProblemRecordStatus, ProblemRecordStudent, ProblemRecordsPayload } from "../lib/problem-records";
import styles from "./problem-records.module.css";

const statuses: Record<ProblemRecordStatus, string> = {
  open: "待解决", pending: "待确认", changes_requested: "需补充", resolved: "已解决", historical: "历史记录",
};
const sources: Record<ProblemRecordSource, string> = { progress: "进展问题", milestone: "受阻节点", guidance: "问题记录" };
type StatusFilter = "active" | "all" | ProblemRecordStatus;
const pageSize = 30;

function readFilters(query: string) {
  const params = new URLSearchParams(query);
  const status = params.get("issueStatus") ?? "active";
  const source = params.get("issueSource") ?? "all";
  const outputValue = params.get("issueOutput");
  const output = outputValue && /^\d+$/.test(outputValue) ? Number(outputValue) : null;
  return {
    student: params.get("issueStudent") ?? "all",
    status: (status === "active" || status === "all" || Object.hasOwn(statuses, status) ? status : "active") as StatusFilter,
    source: (source === "all" || Object.hasOwn(sources, source) ? source : "all") as ProblemRecordSource | "all",
    output: output && Number.isSafeInteger(output) && output > 0 ? output : null,
  };
}

export function ProblemRecords({ active, refreshRequest, query, onRecord }: {
  active: boolean; refreshRequest: number; query: string; onRecord: (students: ProblemRecordStudent[], selectedStudentId: string) => void;
}) {
  const routeQuery = useSearchParams().toString();
  const filters = useMemo(() => readFilters(routeQuery), [routeQuery]);
  const [data, setData] = useState<ProblemRecordsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const [pageKey, setPageKey] = useState("");

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/problem-records", { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as ProblemRecordsPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error || "问题记录读取失败");
        if (!controller.signal.aborted) setData(payload);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "问题记录读取失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, refreshRequest, retry]);

  const recordableStudents = useMemo(() => data?.students.filter((student) => student.canRecord) ?? [], [data]);
  const selectedOutputTitle = useMemo(() => {
    if (!filters.output) return "";
    for (const student of data?.students ?? []) {
      const output = student.researchOutputs?.find((item) => item.id === filters.output);
      if (output) return output.title;
    }
    return "";
  }, [data, filters.output]);
  const scoped = useMemo(() => {
    const search = query.trim().toLocaleLowerCase("zh-CN");
    return (data?.records ?? []).filter((record) =>
      (filters.student === "all" || record.studentId === filters.student)
      && (filters.source === "all" || record.source === filters.source)
      && (filters.output === null || record.researchOutputId === filters.output)
      && (!search || `${record.studentName} ${record.title} ${record.content} ${record.researchOutputTitle ?? ""}`.toLocaleLowerCase("zh-CN").includes(search)),
    );
  }, [data, filters.output, filters.source, filters.student, query]);
  const counts = useMemo(() => {
    const result = { active: 0, pending: 0, resolved: 0, historical: 0 };
    for (const record of scoped) {
      if (["open", "pending", "changes_requested"].includes(record.status)) result.active += 1;
      if (record.status === "pending") result.pending += 1;
      if (record.status === "resolved") result.resolved += 1;
      if (record.status === "historical") result.historical += 1;
    }
    return result;
  }, [scoped]);
  const filtered = useMemo(() => scoped.filter((record) => filters.status === "all"
    || (filters.status === "active" ? ["open", "pending", "changes_requested"].includes(record.status) : record.status === filters.status)), [filters.status, scoped]);
  const currentPageKey = JSON.stringify([filters, query]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = pageKey === currentPageKey ? Math.min(page, totalPages) : 1;
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function updateFilter(key: string, value: string) {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    if (value === "all" && key !== "issueStatus") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState({}, "", url);
  }

  function changePage(next: number) { setPageKey(currentPageKey); setPage(next); }

  return <section className={styles.workspace} aria-label="全组问题记录">
    <div className={styles.heading}>
      <div><h2>问题记录</h2><p>未解决问题会持续保留，与本次进展独立跟进，不影响学生继续提交。</p>{filters.output ? <p className={styles.filterContext}>当前成果：{selectedOutputTitle || `成果 #${filters.output}`} · 可按状态继续筛选</p> : null}</div>
      <button className="primary" disabled={!recordableStudents.length} onClick={() => onRecord(recordableStudents, filters.student)}>＋ 记录问题</button>
    </div>
    <div className={styles.metrics} aria-label="问题状态统计">
      {([
        ["active", "待解决", counts.active], ["pending", "待确认", counts.pending],
        ["resolved", "已解决", counts.resolved], ["historical", "历史记录", counts.historical],
      ] as const).map(([status, label, count]) => <button key={status} aria-pressed={filters.status === status} onClick={() => updateFilter("issueStatus", status)}><span>{label}</span><strong>{count}</strong></button>)}
    </div>
    <div className={styles.filters}>
      <label>学生<select value={filters.student} onChange={(event) => updateFilter("issueStudent", event.target.value)}><option value="all">全部学生</option>{data?.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>
      <label>来源<select value={filters.source} onChange={(event) => updateFilter("issueSource", event.target.value)}><option value="all">全部来源</option>{Object.entries(sources).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>状态<select value={filters.status} onChange={(event) => updateFilter("issueStatus", event.target.value)}><option value="active">所有未解决</option><option value="all">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <span className={styles.resultCount}>{filtered.length} 条{filters.output ? " · 当前成果" : ""}{loading && data ? " · 同步中…" : ""}</span>
    </div>
    {error ? <div className={styles.error} role="alert">{error}<button onClick={() => setRetry((value) => value + 1)}>重新加载</button></div> : null}
    {!data && !error ? <div className={styles.empty} role="status">正在读取问题记录…</div> : null}
    {data && !filtered.length ? <div className={styles.empty}>{data.records.length ? "没有符合当前筛选条件的问题。" : "暂无问题记录，遇到困难时可以在这里统一记录。"}</div> : null}
    <div className={styles.list}>
      {visible.map((record) => <article key={record.id} className={styles.record}>
        <div className={styles.recordTop}><span>{record.studentName} · {sources[record.source]}{record.trackType ? ` · ${record.trackType === "paper" ? "论文" : "课题"}` : ""}</span><span className={`${styles.status} ${record.status === "resolved" ? styles.resolved : ""}`}>{statuses[record.status]}</span></div>
        <h3>{record.title || "问题记录"}</h3>
        {record.researchOutputTitle ? <p className={styles.linkedOutput}><span>关联成果</span><a href={`/students/${encodeURIComponent(record.studentId)}#outputs`}>{record.researchOutputTitle} · {record.researchOutputType === "patent" ? "专利" : "论文/成果"} ↗</a></p> : null}
        <p className={styles.content}>{record.content}</p>
        <div className={styles.recordFoot}><span>{record.dueDate ? `跟进日期 ${record.dueDate}` : "未设跟进日期"}{record.sourceCurrent === false ? " · 来自较早修订" : !record.current ? " · 非当前记录" : ""}{record.status === "historical" && record.originalStatus ? ` · 原状态：${statuses[record.originalStatus]}` : ""}</span><a href={record.href}>查看与处理 <span aria-hidden="true">↗</span></a></div>
      </article>)}
    </div>
    {totalPages > 1 ? <nav className={styles.pagination} aria-label="问题记录分页"><button disabled={currentPage <= 1} onClick={() => changePage(currentPage - 1)}>上一页</button><span>{currentPage} / {totalPages}</span><button disabled={currentPage >= totalPages} onClick={() => changePage(currentPage + 1)}>下一页</button></nav> : null}
    <p className={styles.note}>提交新进展不会自动关闭旧问题。问题须明确处理完成，才移入“已解决”。</p>
  </section>;
}
