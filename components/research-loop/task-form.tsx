"use client";

import { useId, useState, type FormEvent } from "react";
import { errorText, type TaskBudget } from "./api";
import { ErrorNote } from "./ui";
import styles from "./research-loop.module.css";

export type TaskContentDraft = {
  title: string;
  researchQuestion: string;
  hypothesis: string;
  instructions: string;
  acceptanceCriteria: string;
  allowedPaths: string[];
  protectedPaths: string[];
  budget: TaskBudget;
};

export const emptyTaskContent: TaskContentDraft = {
  title: "", researchQuestion: "", hypothesis: "", instructions: "", acceptanceCriteria: "",
  allowedPaths: [], protectedPaths: [], budget: {},
};

function lines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function budgetNumber(value: string) {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Create / revise / follow-up form for research task content. The server
 * validates everything; default protected paths are always added server-side. */
export function TaskForm({ initial, title, submitLabel, note, onSubmit, onCancel }: {
  initial: TaskContentDraft;
  title: string;
  submitLabel: string;
  note?: string;
  onSubmit: (content: TaskContentDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState({
    ...initial,
    allowedText: initial.allowedPaths.join("\n"),
    // Only the caller-added extras are editable; defaults stay server-side.
    protectedText: initial.protectedPaths.join("\n"),
    agentMinutes: initial.budget.maxAgentMinutes?.toString() ?? "",
    gpuCount: initial.budget.maxGpuCount?.toString() ?? "",
    walltime: initial.budget.maxWalltimeMinutes?.toString() ?? "",
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const budget: TaskBudget = {};
    const agent = budgetNumber(draft.agentMinutes);
    const gpu = budgetNumber(draft.gpuCount);
    const walltime = budgetNumber(draft.walltime);
    if (agent !== undefined) budget.maxAgentMinutes = agent;
    if (gpu !== undefined) budget.maxGpuCount = gpu;
    if (walltime !== undefined) budget.maxWalltimeMinutes = walltime;
    try {
      await onSubmit({
        title: draft.title, researchQuestion: draft.researchQuestion, hypothesis: draft.hypothesis,
        instructions: draft.instructions, acceptanceCriteria: draft.acceptanceCriteria,
        allowedPaths: lines(draft.allowedText), protectedPaths: lines(draft.protectedText), budget,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure : new Error(errorText(failure, "保存失败，请重试")));
      setBusy(false);
    }
  }

  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));
  return <form className={styles.form} onSubmit={submit} aria-labelledby={`${id}-title`}>
    <h4 id={`${id}-title`}>{title}</h4>
    {note ? <p className={styles.muted}>{note}</p> : null}
    <div className={styles.grid2}>
      <label className={styles.wide}>任务标题<input required maxLength={120} value={draft.title} disabled={busy} onChange={(event) => set({ title: event.target.value })} /></label>
      <label className={styles.wide}>研究问题<textarea required rows={3} maxLength={2000} value={draft.researchQuestion} disabled={busy} onChange={(event) => set({ researchQuestion: event.target.value })} /></label>
      <label className={styles.wide}>假设（可选）<textarea rows={2} maxLength={2000} value={draft.hypothesis} disabled={busy} onChange={(event) => set({ hypothesis: event.target.value })} /></label>
      <label className={styles.wide}>执行说明<textarea required rows={4} maxLength={20000} value={draft.instructions} disabled={busy} placeholder="交给代理的具体要求：改什么、怎么验证" onChange={(event) => set({ instructions: event.target.value })} /></label>
      <label className={styles.wide}>验收标准<textarea required rows={2} maxLength={4000} value={draft.acceptanceCriteria} disabled={busy} onChange={(event) => set({ acceptanceCriteria: event.target.value })} /></label>
    </div>
    <details className={styles.subtle}>
      <summary>修改范围与预算</summary>
      <div className={styles.grid2}>
        <label>允许修改的路径（每行一个，留空表示除受保护路径外均可）<textarea rows={3} value={draft.allowedText} disabled={busy} placeholder={"src/**\ntests/**"} spellCheck={false} onChange={(event) => set({ allowedText: event.target.value })} /></label>
        <label>额外受保护路径（每行一个）<textarea rows={3} value={draft.protectedText} disabled={busy} spellCheck={false} onChange={(event) => set({ protectedText: event.target.value })} /><small>默认受保护路径（CI、评价协议、数据划分、依赖与环境文件等）始终生效，不能移除。</small></label>
        <label>代理时长上限（分钟）<input type="number" min={0} max={240} inputMode="numeric" value={draft.agentMinutes} disabled={busy} onChange={(event) => set({ agentMinutes: event.target.value })} /></label>
        <label>GPU 数量上限<input type="number" min={0} max={8} inputMode="numeric" value={draft.gpuCount} disabled={busy} onChange={(event) => set({ gpuCount: event.target.value })} /></label>
        <label>单次运行时长上限（分钟）<input type="number" min={0} max={10080} inputMode="numeric" value={draft.walltime} disabled={busy} onChange={(event) => set({ walltime: event.target.value })} /></label>
      </div>
    </details>
    <ErrorNote error={error} />
    <div className={styles.actions}>
      <button className={styles.primary} type="submit" disabled={busy}>{busy ? "正在保存…" : submitLabel}</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </form>;
}
