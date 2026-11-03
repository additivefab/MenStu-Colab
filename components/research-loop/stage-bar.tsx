"use client";

// Five-stage progress bar plus the "下一步" line for one research task
// (frontend plan F1). Display only: actions stay gated by server permissions.

import { Fragment, useState } from "react";
import { useLoopNavigation } from "./navigation";
import { OWNER_LABELS, type Stage, type StageKey, type StageOwner, type StageState, type TaskStages } from "./stage-model";
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

/** "学生" or, with a co-owner, "学生 / 导师". */
export const ownerText = (owner: StageOwner, coOwner?: StageOwner) =>
  [owner, coOwner].filter((role): role is Exclude<StageOwner, null> => Boolean(role)).map((role) => OWNER_LABELS[role]).join(" / ");

/** "第 2 版已确认 · 学生" style one-liner for a stage (falls back to its state). */
export function stageLine(stage: Stage) {
  return [stage.summary || STAGE_STATE_TEXT[stage.state], ownerText(stage.owner, stage.coOwner)].filter(Boolean).join(" · ");
}

/** Owner label: shows "学生 / 导师", reads "负责人：学生或导师". */
function Owner({ owner, coOwner }: { owner: StageOwner; coOwner?: StageOwner }) {
  const shown = ownerText(owner, coOwner);
  if (!shown) return null;
  return <><span aria-hidden="true">{shown}</span><span className={styles.srOnly}>负责人：{shown.replace(" / ", "或")}</span></>;
}

/** Runs of two or more consecutive done stages, excluding the current one; these fold on narrow cards. */
function doneRuns(stages: TaskStages): Stage[][] {
  const runs: Stage[][] = [];
  let run: Stage[] = [];
  for (const stage of stages.stages) {
    if (stage.state === "done" && stage.key !== stages.current) {
      run.push(stage);
      continue;
    }
    if (run.length > 1) runs.push(run);
    run = [];
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

export function StageBar({ stages }: { stages: TaskStages }) {
  const { navigate } = useLoopNavigation();
  const [expanded, setExpanded] = useState(false);
  const { next } = stages;
  const target = next?.target ?? null;
  const runs = doneRuns(stages);
  const runStart = new Map<StageKey, Stage[]>(runs.map((run) => [run[0].key, run]));
  const folded = new Set<StageKey>(expanded ? [] : runs.flat().map((stage) => stage.key));
  return <div className={styles.bar} data-partial={stages.partial || undefined}>
    <ol className={styles.stages} aria-label="任务阶段">
      {stages.stages.map((stage) => {
        const current = stage.key === stages.current;
        const run = runStart.get(stage.key);
        const hasOwner = Boolean(stage.owner || stage.coOwner);
        return <Fragment key={stage.key}>
          {run ? <li className={styles.doneGroup}>
            <button type="button" className={styles.doneToggle} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              <span className={styles.mark} aria-hidden="true">✓</span>
              <span className={styles.doneText}>{run.map((item) => item.label).join("、")} 已完成</span>
              <span className={styles.doneAction}>{expanded ? "收起" : "展开"}</span>
            </button>
          </li> : null}
          <li className={styles.stage} data-state={stage.state} data-current={current || undefined} data-folded={folded.has(stage.key) || undefined} aria-current={current ? "step" : undefined}>
            <span className={styles.mark} aria-hidden="true">{STATE_MARK[stage.state]}</span>
            <span className={styles.text}>
              <span className={styles.label}><strong>{stage.label}</strong><span className={styles.state}>{STAGE_STATE_TEXT[stage.state]}</span>{current ? <span className={styles.srOnly}>（当前阶段）</span> : null}</span>
              {stage.summary || hasOwner ? <small className={styles.summary}>
                {stage.summary}{stage.summary && hasOwner ? " · " : null}<Owner owner={stage.owner} coOwner={stage.coOwner} />
              </small> : null}
            </span>
          </li>
        </Fragment>;
      })}
    </ol>
    {next ? <p className={styles.next}>
      <span className={styles.nextLabel}>下一步</span>
      <span className={styles.nextText}>{next.text}{next.owner || next.coOwner ? <small> · <Owner owner={next.owner} coOwner={next.coOwner} /></small> : null}</span>
      {target ? <button type="button" className={styles.go} onClick={() => navigate(target)}>前往</button> : null}
    </p> : null}
  </div>;
}
