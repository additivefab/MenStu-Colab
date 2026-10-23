"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MentorOverviewResponse, OverviewState } from "../../lib/dashboard-overview/types";
import { OverviewFilters, type OverviewDegreeFilter } from "./overview-filters";
import { OverviewMetrics } from "./overview-metrics";
import { OverviewMobileList } from "./overview-mobile-list";
import { OverviewTable } from "./overview-table";
import { parseOverviewUrl, sortOverviewStudents } from "./overview-view-model";
import { StudentOverviewDrawer } from "./student-overview-drawer";

function readOverviewUrl() {
  if (typeof window === "undefined") return { state: "all" as const, degree: "all" as const, studentId: null as string | null };
  return parseOverviewUrl(window.location.href);
}

export function MentorGroupOverview({ query, onQueryChange, refreshRequest, active = true }: { query: string; onQueryChange: (value: string) => void; refreshRequest: number; active?: boolean }) {
  const initial = readOverviewUrl();
  const [data, setData] = useState<MentorOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [stateFilter, setStateFilter] = useState<OverviewState | "all">(initial.state);
  const [degreeFilter, setDegreeFilter] = useState<OverviewDegreeFilter>(initial.degree);
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(initial.studentId);
  const hasData = useRef(false);
  const requestSequence = useRef(0);

  const updateUrl = useCallback((updates: Record<string, string | null>, replace = false) => {
    if (!active) return;
    const url = new URL(window.location.href);
    Object.entries(updates).forEach(([key, value]) => {
      if (!value || value === "all") url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    });
    window.history[replace ? "replaceState" : "pushState"]({}, "", url);
  }, [active]);

  const load = useCallback(async (refresh = false) => {
    const sequence = ++requestSequence.current;
    if (refresh) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/dashboard/overview", { cache: "no-store" });
      const payload = await response.json() as MentorOverviewResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "全组进度读取失败");
      if (sequence !== requestSequence.current) return;
      hasData.current = true;
      setData(payload);
    } catch (loadError) {
      if (sequence === requestSequence.current) setError(loadError instanceof Error ? loadError.message : "全组进度读取失败");
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    // Keep this instance's last result visible while refreshing after a tab switch.
    const timer = window.setTimeout(() => void load(hasData.current), 0);
    return () => window.clearTimeout(timer);
  }, [active, load, refreshRequest]);

  useEffect(() => {
    if (!active) return;
    const onPopState = () => {
      const next = readOverviewUrl();
      setStateFilter(next.state);
      setDegreeFilter(next.degree);
      setSelectedStudentId(next.studentId);
    };
    onPopState();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const url = new URL(window.location.href);
    const normalized = query.trim();
    if ((url.searchParams.get("q") ?? "") === normalized) return;
    if (normalized) url.searchParams.set("q", normalized); else url.searchParams.delete("q");
    window.history.replaceState({}, "", url);
  }, [active, query]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return data.students
      .filter((student) => stateFilter === "all" || student.primaryState === stateFilter)
      .filter((student) => degreeFilter === "all" || (degreeFilter === "phd" ? student.degreeLevel === "博士" : student.degreeLevel === "硕士"))
      .filter((student) => {
        if (!normalized) return true;
        const searchable = [
          student.displayName,
          student.currentFocus,
          student.stage,
          student.paperPosition?.title,
          student.paperPosition?.stage,
          student.projectPosition?.title,
          student.projectPosition?.stage,
          student.nextAction,
        ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
        return searchable.includes(normalized);
      })
      .sort(sortOverviewStudents);
  }, [data, degreeFilter, query, stateFilter]);

  const selected = data?.students.find((student) => student.studentId === selectedStudentId) ?? null;
  const openStudent = useCallback((studentId: string) => {
    setSelectedStudentId(studentId);
    updateUrl({ student: studentId });
  }, [updateUrl]);
  const closeDrawer = useCallback(() => {
    const previous = selectedStudentId;
    setSelectedStudentId(null);
    updateUrl({ student: null });
    window.setTimeout(() => {
      if (!previous) return;
      const target = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-overview-student]"))
        .find((element) => element.dataset.overviewStudent === previous && element.getClientRects().length > 0);
      target?.focus();
    }, 0);
  }, [selectedStudentId, updateUrl]);
  const setState = (state: OverviewState | "all") => { setStateFilter(state); updateUrl({ state }); };
  const setDegree = (degree: OverviewDegreeFilter) => { setDegreeFilter(degree); updateUrl({ degree }); };

  if (loading && !data) return <section className="group-overview-loading" aria-live="polite"><span /><strong>正在读取学生进度</strong><small></small></section>;
  if (error && !data) return <section className="group-overview-error" role="alert"><span>!</span><strong>全组进度暂时没有加载出来</strong><p>{error}</p><button type="button" onClick={() => void load()}>重新读取</button></section>;
  if (!data) return null;

  return <section className="mentor-group-overview" aria-label="全组进度总览">
    <OverviewMetrics data={data} activeState={stateFilter} onStateChange={setState} />
    <div className="group-overview-toolbar">
      <OverviewFilters
        query={query}
        state={stateFilter}
        degree={degreeFilter}
        visibleCount={filtered.length}
        total={data.total}
        onQueryChange={onQueryChange}
        onStateChange={setState}
        onDegreeChange={setDegree}
      />
      <span className="group-overview-sync-status" aria-live="polite">{refreshing ? "同步中…" : `更新于 ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(new Date(data.generatedAt))}`}</span>
    </div>
    {error ? <div className="group-overview-inline-error" role="status">最新同步失败，当前仍显示上一次成功结果。<button type="button" onClick={() => void load(true)}>重试</button></div> : null}
    {data.total === 0 ? <div className="group-overview-empty scope"><span>◎</span><strong>当前没有已分配学生</strong><p>系统没有返回全组数据；请由超级管理员确认导师分配范围。</p></div>
      : !filtered.length ? <div className="group-overview-empty"><span>⌕</span><strong>没有符合当前筛选的学生</strong><p>可以清空搜索，或再次点击已选状态人数恢复全部。</p><button type="button" onClick={() => { onQueryChange(""); setState("all"); setDegree("all"); }}>清空筛选</button></div>
        : <>
          <OverviewTable students={filtered} selectedStudentId={selectedStudentId} onOpen={openStudent} />
          <OverviewMobileList students={filtered} onOpen={openStudent} />
        </>}
    <details className="quiet-details group-overview-help"><summary>状态说明</summary><p>每人只显示当前最需处理的状态。进展统计仅包含导师确认的实质性进展，日期按北京时间计算。</p></details>
    {active && selected ? <StudentOverviewDrawer student={selected} onClose={closeDrawer} /> : null}
  </section>;
}
