import { overviewStateMeta, type OverviewState } from "../../lib/dashboard-overview/types";

export type OverviewDegreeFilter = "all" | "phd" | "master";

export function OverviewFilters({ query, state, degree, visibleCount, total, onQueryChange, onStateChange, onDegreeChange }: {
  query: string;
  state: OverviewState | "all";
  degree: OverviewDegreeFilter;
  visibleCount: number;
  total: number;
  onQueryChange: (value: string) => void;
  onStateChange: (value: OverviewState | "all") => void;
  onDegreeChange: (value: OverviewDegreeFilter) => void;
}) {
  const filtered = Boolean(query) || state !== "all" || degree !== "all";
  return <section className="group-overview-filters" aria-label="筛选全组进度">
    <label><span>层次</span><select value={degree} onChange={(event) => onDegreeChange(event.target.value as OverviewDegreeFilter)}>
      <option value="all">全部学生</option><option value="phd">博士</option><option value="master">硕士</option>
    </select></label>
    <div className="group-overview-filter-result" aria-live="polite"><strong>{visibleCount}</strong><span>{filtered ? ` / ${total}` : ""} 人{state !== "all" ? ` · ${overviewStateMeta[state].label}` : ""}</span></div>
    {filtered ? <button className="group-overview-reset" type="button" onClick={() => { onQueryChange(""); onStateChange("all"); onDegreeChange("all"); }}>清除筛选</button> : null}
  </section>;
}
