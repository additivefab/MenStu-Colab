"use client";

// Provenance links (frontend plan F3). CONTRACT (batch 1): A3 implements both
// components; A2 renders <TaskSourceLinks> in the task card header area and
// A3 renders <ResultLineage> at the bottom of a run's result section.
//
// Only facts present in the loaded data are shown; anything the panel cannot
// resolve says so ("未记录" / plain text) instead of being guessed.

import type { MouseEvent, ReactNode } from "react";
import type { RunDetail, TaskSummary } from "./api";
import { label, reviewStateLabels, shortSha } from "./labels";
import { anchorId, useLoopNavigation } from "./navigation";
import { runLabel } from "./numbering";
import type { StageTarget } from "./stage-model";
import styles from "./lineage.module.css";

function targetAnchor(target: StageTarget) {
  switch (target.kind) {
    case "task": return anchorId.task(target.taskId);
    case "attempt": return anchorId.attempt(target.attemptId);
    case "changeRequest": return anchorId.changeRequest(target.changeRequestId);
    case "run": return anchorId.run(target.runId);
  }
}

/** In-panel link: a real hash link for middle-click/copy, but a click asks the
 * panel to open and scroll to the card instead of changing the URL hash. */
export function NavLink({ target, children }: { target: StageTarget; children: ReactNode }) {
  const { navigate } = useLoopNavigation();
  return <a href={`#${targetAnchor(target)}`} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(target);
  }}>{children}</a>;
}

function GuidanceLink({ noteId, text }: { noteId: number; text: string }) {
  const { guidanceHref } = useLoopNavigation();
  const href = guidanceHref(noteId);
  return href ? <a href={href} onClick={(event) => event.stopPropagation()}>{text}</a> : <span>{text} #{noteId}</span>;
}

function SourceRunLink({ runId, suffix }: { runId: string; suffix: string }) {
  const { runRef } = useLoopNavigation();
  const ref = runRef(runId);
  return ref
    ? <NavLink target={{ kind: "run", taskId: ref.taskId, runId }}>{runLabel(ref.number)} {suffix}</NavLink>
    : <span>上一轮运行{suffix}</span>;
}

/** "来自导师意见 … / 来自运行 #n 的评审 / 上一轮：<任务>" links for a task. */
export function TaskSourceLinks({ task }: { task: TaskSummary }) {
  const { taskTitle } = useLoopNavigation();
  if (!task.sourceGuidanceNoteId && !task.sourceRunId && !task.parentTaskId) return null;
  const parentTitle = task.parentTaskId ? taskTitle(task.parentTaskId) : null;
  return <span className={styles.sources}>
    {task.sourceGuidanceNoteId ? <span className={styles.source}><GuidanceLink noteId={task.sourceGuidanceNoteId} text="来自导师意见" /></span> : null}
    {task.sourceRunId ? <span className={styles.source}>来自<SourceRunLink runId={task.sourceRunId} suffix="的评审" /></span> : null}
    {task.parentTaskId ? <span className={styles.source}>{parentTitle
      ? <NavLink target={{ kind: "task", taskId: task.parentTaskId }}>上一轮任务：{parentTitle}</NavLink>
      : <span>上一轮任务（不在当前列表中）</span>}</span> : null}
  </span>;
}

const UNKNOWN = <span className={styles.unknown}>未记录</span>;

/** 原意见 → 任务第 N 版 → PR #x → 运行 #y → 评审 → 下一轮任务 chain for one run. */
export function ResultLineage({ task, detail }: { task: TaskSummary | null; detail: RunDetail }) {
  const nav = useLoopNavigation();
  const { run, spec, review } = detail;
  const taskId = spec.taskId || run.taskId;

  const origin = !task ? UNKNOWN
    : task.sourceGuidanceNoteId ? <GuidanceLink noteId={task.sourceGuidanceNoteId} text="导师意见" />
    : task.sourceRunId ? <SourceRunLink runId={task.sourceRunId} suffix="的评审" />
    : <span className={styles.unknown}>无（直接创建）</span>;

  const title = task?.title ?? nav.taskTitle(taskId);
  const taskStep = <NavLink target={{ kind: "task", taskId }}>{title ? <span className={styles.title}>{title}</span> : "任务"}<span className={styles.nowrap}>第 {spec.taskVersion} 版</span></NavLink>;

  const crRef = spec.changeRequestId ? nav.changeRequestRef?.(spec.changeRequestId) ?? null : null;
  const change = spec.changeRequestId
    ? <NavLink target={{ kind: "changeRequest", taskId, changeRequestId: spec.changeRequestId }}>
      {crRef?.prNumber ? `PR #${crRef.prNumber}` : crRef?.number ? `变更 #${crRef.number}` : "变更请求"}
    </NavLink>
    : <span className={styles.unknown}>未关联（直接指定提交 {shortSha(spec.executedCommitSha, 7)}）</span>;

  const runNumber = nav.runRef(run.id)?.number ?? null;
  const runStep = <span>{runLabel(runNumber)}{run.attempt > 1 ? ` · 第 ${run.attempt} 次执行` : ""}</span>;

  const reviewStep = review ? <span>{label(reviewStateLabels, review.state)[0]}</span>
    : detail.result ? <span className={styles.unknown}>尚未评审</span> : UNKNOWN;

  const followupId = review?.followupTaskId ?? null;
  const followupTitle = followupId ? nav.taskTitle(followupId) : null;
  const next = followupId
    ? <NavLink target={{ kind: "task", taskId: followupId }}>{followupTitle ? <span className={styles.title}>{followupTitle}</span> : "下一轮任务"}</NavLink>
    : <span className={styles.unknown}>尚未创建</span>;

  const steps: [string, ReactNode][] = [
    ["原意见", origin], ["任务", taskStep], ["变更", change], ["运行", runStep], ["评审", reviewStep], ["下一轮", next],
  ];
  return <div className={styles.lineage}>
    <h5>谱系</h5>
    <ol className={styles.chain} aria-label="结果谱系">
      {steps.map(([name, value]) => <li key={name}><small>{name}</small>{value}</li>)}
    </ol>
  </div>;
}
