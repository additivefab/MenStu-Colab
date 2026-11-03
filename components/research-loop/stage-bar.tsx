"use client";

// Five-stage progress bar plus the "下一步" line for one research task
// (frontend plan F1). Display only: actions stay gated by server permissions.

import { useLoopNavigation } from "./navigation";
import { OWNER_LABELS, type Stage, type StageOwner, type StageState, type TaskStages } from "./stage-model";
import styles from "./stage-bar.module.css";

/** Accessible text for each state; the mark and color only repeat it. */
export const STAGE_STATE_TEXT: Record<StageState, string> = {
  done: "已完成",
  active: "待处理",
  working: "进行中",
  failed: "失败",
  idle: "未开始",
  skipped: "不适用",
};

const STATE_MARK: Record<StageState, string> = {
  done: "✓",
  active: "●",
  working: "◐",
  failed: "!",
  idle: "○",
  skipped: "–",
};

export const ownerText = (owner: StageOwner) => (owner ? OWNER_LABELS[owner] : "");

/** "第 2 版已确认 · 学生" style one-liner for a stage (falls back to its state). */
export function stageLine(stage: Stage) {
  return [stage.summary || STAGE_STATE_TEXT[stage.state], ownerText(stage.owner)].filter(Boolean).join(" · ");
}

export function StageBar({ stages }: { stages: TaskStages }) {
  const { navigate } = useLoopNavigation();
  const { next } = stages;
  const target = next?.target ?? null;
  return <div className={styles.bar} data-partial={stages.partial || undefined}>
    <ol className={styles.stages} aria-label="任务阶段">
      {stages.stages.map((stage) => {
        const current = stage.key === stages.current;
        const owner = ownerText(stage.owner);
        return <li key={stage.key} className={styles.stage} data-state={stage.state} data-current={current || undefined} aria-current={current ? "step" : undefined}>
          <span className={styles.mark} aria-hidden="true">{STATE_MARK[stage.state]}</span>
          <span className={styles.text}>
            <span className={styles.label}><strong>{stage.label}</strong><span className={styles.state}>{STAGE_STATE_TEXT[stage.state]}</span>{current ? <span className={styles.srOnly}>（当前阶段）</span> : null}</span>
            {stage.summary || owner ? <small className={styles.summary}>{[stage.summary, owner].filter(Boolean).join(" · ")}</small> : null}
          </span>
        </li>;
      })}
    </ol>
    {next ? <p className={styles.next}>
      <span className={styles.nextLabel}>下一步</span>
      <span className={styles.nextText}>{next.text}{next.owner ? <small> · {OWNER_LABELS[next.owner]}</small> : null}</span>
      {target ? <button type="button" className={styles.go} onClick={() => navigate(target)}>前往</button> : null}
    </p> : null}
  </div>;
}
