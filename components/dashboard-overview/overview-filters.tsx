import { overviewStateMeta, overviewStates, type OverviewState } from "../../lib/dashboard-overview/types";

export type OverviewDegreeFilter = "all" | "phd" | "master";

export function OverviewFilters({
  query,
  state,
  degree,
  visibleCount,
  total,
  onQueryChange,
  onStateChange,
  onDegreeChange,
  onRefresh,
  refreshing,
}: {
  query: string;
  state: OverviewState | "all";
  degree: OverviewDegreeFilter;
  visibleCount: number;
  total: number;
  onQueryChange: (value: string) => void;
  onStateChange: (value: OverviewState | "all") => void;
  onDegreeChange: (value: OverviewDegreeFilter) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return <section className="group-overview-filters" aria-label="筛选全组进度">
    <label className="group-overview-search">
      <span aria-hidden="true">⌕</span>
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        aria-label="搜索学生姓名、研究方向、论文或培养节点"
        placeholder="搜索姓名、方向、论文或节点"
      />
      {query ? <button type="button" onClick={() => onQueryChange("")} aria-label="清空搜索">×</button> : null}
    </label>
    <label><span>状态</span><select value={state} onChange={(event) => onStateChange(event.target.value as OverviewState | "all")}>
      <option value="all">全部状态</option>
      {overviewStates.map((value) => <option value={value} key={value}>{overviewStateMeta[value].label}</option>)}
    </select></label>
    <label><span>层次</span><select value={degree} onChange={(event) => onDegreeChange(event.target.value as OverviewDegreeFilter)}>
      <option value="all">博士与硕士</option><option value="phd">博士</option><option value="master">硕士</option>
    </select></label>
    <div className="group-overview-filter-result"><strong>{visibleCount}</strong><span> / {total} 人</span></div>
    <button className="group-overview-refresh" type="button" onClick={onRefresh} disabled={refreshing}>
      {refreshing ? "同步中…" : "同步最新"}
    </button>
  </section>;
}
