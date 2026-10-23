/* eslint-disable @next/next/no-html-link-for-pages -- This Vinext build cannot resolve next/link navigation exports; use native anchors. */
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
  const unresolved = data.students.reduce((sum, student) => sum + student.counters.blocked, 0);
  const affectedStudents = data.students.filter((student) => student.counters.blocked > 0).length;
  return <section className="group-overview-metrics" aria-label="全组进度与问题统计">
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
      <span>本周确认进展</span>
      <strong>{data.weeklySubstantiveStudentCount}<small> / {data.total} 人</small></strong>

      <a className="group-overview-problem-summary" href="/?mentorView=issues"><span>待解决问题</span><b>{unresolved} 项 · {affectedStudents} 人</b></a>
    </aside>
  </section>;
}
