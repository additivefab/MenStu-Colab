import { overviewStateMeta, overviewStates, type MentorOverviewResponse, type OverviewState } from "../../lib/dashboard-overview/types";

export function OverviewMetrics({
  data,
  activeState,
  onStateChange,
}: {
  data: MentorOverviewResponse;
  activeState: OverviewState | "all";
  onStateChange: (state: OverviewState | "all") => void;
}) {
  return <section className="group-overview-metrics" aria-label="全组互斥状态人数">
    <div className="group-overview-metrics-grid">
      {overviewStates.map((state) => {
        const meta = overviewStateMeta[state];
        const active = activeState === state;
        return <button
          type="button"
          className={`${state}${active ? " active" : ""}`}
          aria-pressed={active}
          aria-label={`${meta.label} ${data.counts[state]} 人${active ? "，再次点击显示全部" : ""}`}
          onClick={() => onStateChange(active ? "all" : state)}
          key={state}
        >
          <small>{meta.label}</small>
          <strong>{data.counts[state]}</strong>
        </button>;
      })}
    </div>
    <aside>
      <span>本周可信推进</span>
      <strong>{data.weeklySubstantiveStudentCount}<small> / {data.total} 人</small></strong>

    </aside>
  </section>;
}
