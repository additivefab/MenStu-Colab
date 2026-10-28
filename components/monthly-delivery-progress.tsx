import type { MonthlyDeliverySummary } from "../lib/monthly-delivery";
import styles from "./monthly-delivery-progress.module.css";

const phaseLabels: Record<MonthlyDeliverySummary["phase"], string> = {
  preparing: "本月准备中",
  submitted: "本月已提交",
  confirmed: "本月已确认",
  needs_changes: "本月待补充",
};

const stages = [
  { label: "本月准备", compactLabel: "准备" },
  { label: "本月已提交", compactLabel: "已提交" },
  { label: "本月已确认", compactLabel: "已确认" },
];

export function MonthlyDeliveryProgress({ summary, compact = false }: {
  summary: MonthlyDeliverySummary;
  compact?: boolean;
}) {
  const monthNumber = Number(summary.month.slice(5, 7));
  const monthLabel = monthNumber >= 1 && monthNumber <= 12 ? `${monthNumber}月提交进度` : "本月提交进度";
  const phaseLabel = phaseLabels[summary.phase];
  const stageIndex = summary.phase === "preparing" ? 0 : summary.phase === "confirmed" ? 2 : 1;

  return <div className={`${styles.progress} ${compact ? styles.compact : ""}`} data-phase={summary.phase} role="group" aria-label={`${monthLabel}，${phaseLabel}`} title="按提交月份统计，不代表科研完成率；待解决问题另行跟进。">
    <div className={styles.heading}><strong>{monthLabel}</strong><span className={styles.phase}>{phaseLabel}</span></div>
    <ol className={styles.stages} aria-label="本月提交与确认阶段">
      {stages.map((stage, index) => <li key={stage.label} className={index < stageIndex ? styles.done : index === stageIndex ? styles.current : styles.upcoming} aria-current={index === stageIndex ? "step" : undefined}>
        <i aria-hidden="true">{index < stageIndex ? "✓" : index + 1}</i><span aria-label={stage.label}>{compact ? stage.compactLabel : stage.label}</span>
      </li>)}
    </ol>
    <div className={styles.counts}>
      {summary.total ? <><span>已提交 <b>{summary.total}</b> 条</span><span>已确认 <b>{summary.confirmed}</b> 条</span>{summary.pending ? <span>待确认 <b>{summary.pending}</b> 条</span> : null}{summary.needsChanges ? <span className={styles.needsChanges}>待补充 <b>{summary.needsChanges}</b> 条</span> : null}</> : <span>本月尚无正式提交</span>}
    </div>
    {summary.candidates ? <div className={styles.candidates}>另有 {summary.candidates} 条 AI 纪要候选，尚未计入提交</div> : null}
    {compact ? null : <p className={styles.note}>按提交月份统计，不代表科研完成率；待解决问题另行跟进。</p>}
  </div>;
}
