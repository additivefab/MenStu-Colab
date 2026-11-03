"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { getJson, newKey, postJson, type RunList, type TaskSummary } from "./api";
import { anchorId, LoopNavigationContext, type ChangeRequestRef, type LoopNavigation } from "./navigation";
import { sequenceNumbers } from "./numbering";
import { Readiness } from "./readiness";
import type { StageTarget } from "./stage-model";
import { TaskCard } from "./task-card";
import { emptyTaskContent, TaskForm, type TaskContentDraft } from "./task-form";
import { ErrorNote, Notice } from "./ui";
import styles from "./research-loop.module.css";

export type TaskPrefill = Partial<TaskContentDraft> & { sourceGuidanceNoteId?: number; key: number };

type LoopData = { tasks: TaskSummary[]; runs: RunList };

function fetchLoop(studentId: string, signal: AbortSignal): Promise<LoopData> {
  const id = encodeURIComponent(studentId);
  return Promise.all([
    getJson<{ tasks: TaskSummary[] }>(`/api/research-tasks?studentId=${id}`, "研究任务读取失败", signal),
    getJson<RunList>(`/api/runs?studentId=${id}`, "运行记录读取失败", signal),
  ]).then(([tasks, runs]) => ({ tasks: tasks.tasks, runs }));
}

/** Research loop: task → agent attempt → change request → run → result review.
 * `mode` only changes wording; every action is gated by server permissions. */
export function ResearchLoopPanel({ studentId, mode, prefill, guidanceHref }: {
  studentId: string;
  mode: "staff" | "student";
  prefill?: TaskPrefill;
  /** Link to a guidance note where notes are on the same page (student profile). */
  guidanceHref?: (noteId: number) => string | null;
}) {
  return <PanelContent key={studentId} studentId={studentId} mode={mode} prefill={prefill} guidanceHref={guidanceHref} />;
}

type RegisteredChangeRequest = { id: string; taskId: string; createdAt: string; prNumber: number | null };

const isOpenTask = (task: TaskSummary) => task.status === "draft" || task.status === "confirmed";

function PanelContent({ studentId, mode, prefill, guidanceHref }: {
  studentId: string;
  mode: "staff" | "student";
  prefill?: TaskPrefill;
  guidanceHref?: (noteId: number) => string | null;
}) {
  const titleId = useId();
  const [data, setData] = useState<LoopData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState<{ initial: TaskContentDraft; sourceGuidanceNoteId?: number; key: string } | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [highlight, setHighlight] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const handledPrefill = useRef<number | null>(null);
  const [focus, setFocus] = useState<LoopNavigation["focus"]>(null);
  const [changeRequests, setChangeRequests] = useState<ReadonlyMap<string, RegisteredChangeRequest>>(new Map());
  const claimedFocus = useRef(new Set<number>());

  const reload = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    return fetchLoop(studentId, controller.signal).then((payload) => {
      if (!controller.signal.aborted) { setData(payload); setError(null); }
    }, (failure: unknown) => { if (!controller.signal.aborted) setError(failure); });
  }, [studentId]);

  useEffect(() => {
    void reload();
    return () => request.current?.abort();
  }, [reload]);

  // A guidance note's "转为研究任务" opens the create form pre-filled.
  useEffect(() => {
    if (!prefill || handledPrefill.current === prefill.key) return;
    handledPrefill.current = prefill.key;
    const { key: _key, sourceGuidanceNoteId, ...content } = prefill;
    void _key;
    const timer = window.setTimeout(() => setCreating({ initial: { ...emptyTaskContent, ...content }, sourceGuidanceNoteId, key: newKey() }), 0);
    return () => window.clearTimeout(timer);
  }, [prefill]);

  async function create(content: TaskContentDraft) {
    if (!creating) return;
    const payload = await postJson<{ task: TaskSummary }>("/api/research-tasks", {
      action: "create", studentId, mutationId: creating.key, ...content,
      ...(creating.sourceGuidanceNoteId ? { sourceGuidanceNoteId: creating.sourceGuidanceNoteId } : {}),
    }, "任务创建失败，请重试");
    setCreating(null);
    setFilter("open");
    setHighlight(payload.task.id);
    setNotice("任务已保存为草稿。确认后才能交给代理或登记运行。");
    await reload();
  }

  const navigate = useCallback((target: StageTarget) => {
    const task = data?.tasks.find((item) => item.id === target.taskId);
    if (!task) {
      setNotice("要前往的任务不在当前列表中（可能尚未加载或无权查看）。");
      return;
    }
    if (!isOpenTask(task)) setFilter("all");
    setHighlight(target.taskId);
    setFocus({ ...target, key: Date.now() });
    if (target.kind === "task") {
      window.setTimeout(() => document.getElementById(anchorId.task(target.taskId))?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }, [data]);

  const registerChangeRequest = useCallback((item: RegisteredChangeRequest) => {
    setChangeRequests((current) => {
      const known = current.get(item.id);
      if (known && known.taskId === item.taskId && known.createdAt === item.createdAt && known.prNumber === item.prNumber) return current;
      return new Map(current).set(item.id, item);
    });
  }, []);

  const claimFocus = useCallback((key: number) => {
    if (claimedFocus.current.has(key)) return false;
    claimedFocus.current.add(key);
    return true;
  }, []);

  const navigation = useMemo<LoopNavigation>(() => {
    const taskList = data?.tasks ?? [];
    const runList = data?.runs.runs ?? [];
    const byTask = new Map<string, typeof runList>();
    for (const run of runList) byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run]);
    const runRefs = new Map<string, { taskId: string; number: number }>();
    for (const [taskId, items] of byTask) for (const [runId, number] of sequenceNumbers(items)) runRefs.set(runId, { taskId, number });
    const crByTask = new Map<string, RegisteredChangeRequest[]>();
    for (const item of changeRequests.values()) crByTask.set(item.taskId, [...(crByTask.get(item.taskId) ?? []), item]);
    const crRefs = new Map<string, ChangeRequestRef>();
    for (const [taskId, items] of crByTask) {
      const numbers = sequenceNumbers(items);
      for (const item of items) crRefs.set(item.id, { taskId, number: numbers.get(item.id) ?? null, prNumber: item.prNumber });
    }
    const followupTaskIdByRun: Record<string, string> = {};
    for (const task of taskList) if (task.sourceRunId) followupTaskIdByRun[task.sourceRunId] ??= task.id;
    return {
      focus,
      navigate,
      followupTaskIdByRun,
      taskTitle: (taskId) => taskList.find((task) => task.id === taskId)?.title ?? null,
      runRef: (runId) => runRefs.get(runId) ?? null,
      guidanceHref: (noteId) => guidanceHref?.(noteId) ?? null,
      task: (taskId) => taskList.find((task) => task.id === taskId) ?? null,
      changeRequestRef: (changeRequestId) => crRefs.get(changeRequestId) ?? null,
      registerChangeRequest,
      claimFocus,
    };
  }, [data, changeRequests, focus, navigate, guidanceHref, registerChangeRequest, claimFocus]);

  const tasks = data?.tasks ?? [];
  const visible = filter === "open" ? tasks.filter(isOpenTask) : tasks;
  const runs = data?.runs.runs ?? [];
  const options = data?.runs.options ?? { entrypoints: [], datasets: [] };
  const openCount = tasks.filter(isOpenTask).length;
  return <LoopNavigationContext.Provider value={navigation}><section className={styles.panel} aria-labelledby={titleId}>
    <header className={styles.panelHead}>
      <div>
        <h2 id={titleId}>代码与实验</h2>
        <p>{mode === "student" ? "确认研究任务后，代理修改代码、你审阅发布，导师批准运行并评审结果。" : "研究任务 → 代理改代码 → 审阅发布 → 批准运行 → 评审结果。"}</p>
      </div>
      {!creating ? <button type="button" className={styles.primary} onClick={() => setCreating({ initial: emptyTaskContent, key: newKey() })}>新建研究任务</button> : null}
    </header>
    <Readiness studentId={studentId} mode={mode} />
    {creating ? <TaskForm
      title={creating.sourceGuidanceNoteId ? "由导师意见创建研究任务" : "新建研究任务"}
      submitLabel="保存为草稿"
      note={creating.sourceGuidanceNoteId ? "已带入导师意见的内容，可修改后保存；任务会记录来源意见。" : "保存后为草稿，需学生本人或有审核权限的导师确认。"}
      initial={creating.initial}
      onSubmit={create}
      onCancel={() => setCreating(null)}
    /> : null}
    <Notice>{notice}</Notice>
    {error ? <div className={styles.errorRow}><ErrorNote error={error} /><button type="button" onClick={() => void reload()}>重新加载</button></div> : null}
    {!data && !error ? <p className={styles.muted} role="status">正在读取研究任务…</p> : null}
    {data ? <>
      <div className={styles.filters} role="group" aria-label="筛选任务">
        <button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>进行中 <span>{openCount}</span></button>
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部 <span>{tasks.length}</span></button>
      </div>
      {visible.map((task, index) => <TaskCard key={task.id} summary={task} runs={runs.filter((run) => run.taskId === task.id)} options={options}
        defaultOpen={highlight ? highlight === task.id : index === 0} onChanged={() => void reload()} />)}
      {!visible.length ? <p className={styles.empty}>{tasks.length ? "没有进行中的任务。可以查看全部任务。" : mode === "student" ? "还没有研究任务。可以自己新建，或请导师把指导意见转为任务。" : "还没有研究任务。可以新建，或在“指导”中把意见转为任务。"}</p> : null}
    </> : null}
  </section></LoopNavigationContext.Provider>;
}
