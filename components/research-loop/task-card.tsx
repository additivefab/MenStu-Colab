"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from "react";
import { DEFAULT_PROTECTED_PATHS } from "../../lib/research-loop/contracts";
import {
  getJson, newKey, postJson, type ChangeRequest, type Dataset, type Entrypoint, type RunSummary, type TaskDetail, type TaskSummary, type TaskVersion,
} from "./api";
import { AttemptCard } from "./attempt-card";
import { ChangeRequestCard } from "./change-request-card";
import { dateLabel, label, providerLabels, shortSha, taskStatusLabels } from "./labels";
import { TaskSourceLinks } from "./lineage";
import { anchorId, useLoopNavigation } from "./navigation";
import { sequenceNumbers } from "./numbering";
import { RunCard } from "./run-card";
import { RunForm } from "./run-form";
import { StageBar, stageLine } from "./stage-bar";
import { computeTaskStages, type StageKey, type StageTarget } from "./stage-model";
import { TaskForm, type TaskContentDraft } from "./task-form";
import { comparisonBaseVersion, ProtectedPathList, VersionDiff } from "./version-diff";
import { Blocked, ConfirmButton, ErrorNote, Notice, Pill } from "./ui";
import styles from "./research-loop.module.css";
import stageStyles from "./stage-bar.module.css";

const defaults = new Set<string>(DEFAULT_PROTECTED_PATHS);

export function contentOf(version: TaskVersion | undefined): TaskContentDraft | null {
  if (!version) return null;
  return {
    title: version.title, researchQuestion: version.researchQuestion, hypothesis: version.hypothesis,
    instructions: version.instructions, acceptanceCriteria: version.acceptanceCriteria,
    allowedPaths: version.allowedPaths, protectedPaths: version.protectedPaths.filter((path) => !defaults.has(path)), budget: version.budget,
  };
}

function VersionBody({ version }: { version: TaskVersion }) {
  const budget = [
    version.budget.maxAgentMinutes !== undefined ? `代理 ≤ ${version.budget.maxAgentMinutes} 分钟` : "",
    version.budget.maxGpuCount !== undefined ? `GPU ≤ ${version.budget.maxGpuCount}` : "",
    version.budget.maxWalltimeMinutes !== undefined ? `单次运行 ≤ ${version.budget.maxWalltimeMinutes} 分钟` : "",
  ].filter(Boolean).join(" · ");
  return <div className={styles.versionBody}>
    <div><h5>研究问题</h5><p>{version.researchQuestion}</p></div>
    {version.hypothesis ? <div><h5>假设</h5><p>{version.hypothesis}</p></div> : null}
    <div><h5>执行说明</h5><p>{version.instructions}</p></div>
    <div><h5>验收标准</h5><p>{version.acceptanceCriteria}</p></div>
    <div><h5>修改范围</h5><p>{version.allowedPaths.length ? version.allowedPaths.join("、") : "除受保护路径外的整个仓库"}</p></div>
    <div><h5>受保护路径</h5><ProtectedPathList paths={version.protectedPaths} /></div>
    <div><h5>预算</h5><p>{budget || "未设上限"}</p></div>
  </div>;
}

function StartAttempt({ detail, onStarted }: { detail: TaskDetail; onStarted: () => void }) {
  const { permissions, task } = detail;
  const [provider, setProvider] = useState(permissions.providers[0] ?? "");
  const [baseRef, setBaseRef] = useState("");
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!permissions.canStartAttempt) {
    if (task.status !== "confirmed") return <Blocked>{task.status === "draft" ? "任务确认后才能交给代理执行。" : "任务已结束，不能再启动代理。"}</Blocked>;
    if (!permissions.providers.length) return <Blocked>你还没有可用的代理凭据档案（或对应的代理工作进程已停用），请联系超级管理员配置。</Blocked>;
    return <Blocked>当前账号不能为该学生启动代理。</Blocked>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/agent-attempts", { action: "start", taskId: task.id, provider, idempotencyKey: key, baseRef: baseRef.trim() || undefined }, "代理启动失败，请重试");
      setKey(newKey());
      setBaseRef("");
      onStarted();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  return <form className={styles.inlineForm} onSubmit={submit}>
    <label>代理<select value={provider} disabled={busy} onChange={(event) => setProvider(event.target.value)}>{permissions.providers.map((item) => <option key={item} value={item}>{providerLabels[item] ?? item}</option>)}</select></label>
    <label>基准分支或提交（可选）<input value={baseRef} maxLength={255} placeholder="默认分支" disabled={busy} spellCheck={false} autoComplete="off" onChange={(event) => setBaseRef(event.target.value)} /></label>
    <button type="submit" className={styles.primary} disabled={busy || !provider}>{busy ? "正在启动…" : `用第 ${task.confirmedVersion} 版启动代理`}</button>
    <ErrorNote error={error} />
  </form>;
}

type SectionKey = "task" | "attempts" | "changes" | "runs";
const SECTION_ORDER: SectionKey[] = ["task", "attempts", "changes", "runs"];
/** Section each stage opens at; result and next round live with the runs. */
const STAGE_SECTION: Record<StageKey, SectionKey> = { task: "task", code: "attempts", run: "runs", result: "runs", next: "runs" };
const TARGET_SECTION: Record<StageTarget["kind"], SectionKey> = { task: "task", attempt: "attempts", changeRequest: "changes", run: "runs" };

function targetAnchor(target: StageTarget) {
  switch (target.kind) {
    case "attempt": return anchorId.attempt(target.attemptId);
    case "changeRequest": return anchorId.changeRequest(target.changeRequestId);
    case "run": return anchorId.run(target.runId);
    default: return anchorId.task(target.taskId);
  }
}

/** One stage section of an expanded task; collapsed it is a one-line summary. */
function StageSection({ label, title, line, open, onToggle, children }: {
  label: string;
  title: ReactNode;
  line: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return <section className={styles.block} aria-label={label}>
    <details className={stageStyles.section} open={open} onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => {
      // React-driven changes already match `open`; record only the user's own toggles.
      if (event.currentTarget.open !== open) onToggle(event.currentTarget.open);
    }}>
      <summary className={stageStyles.sectionSummary}><h4>{title}</h4>{line ? <span className={stageStyles.sectionLine}>{line}</span> : null}</summary>
      {children}
    </details>
  </section>;
}

/** One research task with its stage bar, versions, agent attempts, change requests and runs. */
export function TaskCard({ summary, runs, options, defaultOpen, onChanged }: {
  summary: TaskSummary;
  runs: RunSummary[];
  options: { entrypoints: Entrypoint[]; datasets: Dataset[] };
  defaultOpen: boolean;
  onChanged: () => void;
}) {
  const { focus, followupTaskIdByRun } = useLoopNavigation();
  const [open, setOpen] = useState(defaultOpen);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [runFormOpen, setRunFormOpen] = useState(false);
  const [showVersion, setShowVersion] = useState<number | null>(null);
  const [compareWithCurrent, setCompareWithCurrent] = useState(false);
  const [sectionOpen, setSectionOpen] = useState<Partial<Record<SectionKey, boolean>>>({});
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const [pendingFocus, setPendingFocus] = useState<(StageTarget & { key: number }) | null>(null);
  const scrolledKey = useRef<number | null>(null);
  const cardRef = useRef<HTMLElement>(null);

  const load = useCallback((signal?: AbortSignal) => Promise.all([
    getJson<TaskDetail>(`/api/research-tasks?taskId=${encodeURIComponent(summary.id)}`, "任务详情读取失败", signal),
    getJson<{ changeRequests: ChangeRequest[] }>(`/api/change-requests?taskId=${encodeURIComponent(summary.id)}`, "变更请求读取失败", signal),
  ]).then(([task, crs]) => {
    if (signal?.aborted) return;
    setDetail(task);
    setChangeRequests(crs.changeRequests);
    setError(null);
  }, (failure: unknown) => { if (!signal?.aborted) setError(failure); }), [summary.id]);

  // Active tasks load eagerly so the stage bar is complete while collapsed;
  // closed and canceled tasks still load when opened. Depending on one boolean
  // keeps opening/closing an active card from refetching.
  const shouldLoad = open || summary.status === "draft" || summary.status === "confirmed";
  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [shouldLoad, load, summary.updatedAt]);

  // A navigation request aimed at this task opens the card and the section
  // holding the target (state adjusted during render, once per focus key).
  if (focus && focus.taskId === summary.id && focus.key !== focusKey) {
    setFocusKey(focus.key);
    setOpen(true);
    setSectionOpen((current) => ({ ...current, [TARGET_SECTION[focus.kind]]: true }));
    setPendingFocus(focus);
  }

  // Then scroll the target's anchor (or the card itself) into view once it has rendered.
  useEffect(() => {
    if (!pendingFocus || !open || scrolledKey.current === pendingFocus.key) return;
    const anchor = pendingFocus.kind === "task" ? null : document.getElementById(targetAnchor(pendingFocus));
    if (!anchor && pendingFocus.kind !== "task" && !detail && !error) return; // wait for the detail
    scrolledKey.current = pendingFocus.key;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    (anchor ?? cardRef.current)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, [pendingFocus, open, detail, error]);

  const refresh = useCallback(() => { void load(); onChanged(); }, [load, onChanged]);

  async function act(body: Record<string, unknown>, success: string) {
    setBusy(true); setError(null); setNotice("");
    try {
      await postJson("/api/research-tasks", { taskId: summary.id, mutationId: newKey(), ...body }, "操作失败，请重试");
      setNotice(success);
      refresh();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  async function revise(content: TaskContentDraft) {
    if (!detail) return;
    await postJson("/api/research-tasks", { action: "revise", taskId: summary.id, expectedVersion: detail.task.currentVersion, mutationId: newKey(), ...content }, "任务修改失败，请重试");
    setEditing(false);
    setNotice(`已保存为第 ${detail.task.currentVersion + 1} 版草稿，需要重新确认。`);
    refresh();
  }

  const task = detail?.task ?? summary;
  const stages = useMemo(() => computeTaskStages({
    task, attempts: detail?.attempts ?? null, changeRequests: detail ? changeRequests : null, runs, followupTaskIdByRun,
  }), [task, detail, changeRequests, runs, followupTaskIdByRun]);
  const lineOf = (...keys: StageKey[]) => stages.stages
    .filter((stage) => keys.includes(stage.key) && (stage.summary || stage.state !== "idle"))
    .map(stageLine).join("；");
  // Sections before the current stage collapse to one line; any can still be opened.
  const currentRank = SECTION_ORDER.indexOf(STAGE_SECTION[stages.current]);
  const isOpen = (key: SectionKey) => sectionOpen[key] ?? SECTION_ORDER.indexOf(key) >= currentRank;
  const toggle = (key: SectionKey) => (value: boolean) => setSectionOpen((current) => ({ ...current, [key]: value }));
  const attemptNumbers = useMemo(() => sequenceNumbers(detail?.attempts ?? []), [detail]);
  const runNumbers = useMemo(() => sequenceNumbers(runs), [runs]);

  const [statusText, statusTone] = label(taskStatusLabels, task.status);
  const versions = detail?.versions ?? [];
  const latest = versions[versions.length - 1];
  const confirmed = versions.find((item) => item.version === task.confirmedVersion);
  const viewing = versions.find((item) => item.version === (showVersion ?? latest?.version));
  // G1: a draft with an earlier version shows what it changes right above the confirm button.
  const baseNumber = comparisonBaseVersion(task);
  const draftBase = baseNumber === null ? undefined : versions.find((item) => item.version === baseNumber);
  const draftDiff = draftBase && latest && latest.version === task.currentVersion && draftBase.version !== latest.version ? draftBase : undefined;
  const canCompare = Boolean(viewing && latest && viewing.version !== latest.version);
  // Comparing the draft's own base already shows the same diff; don't repeat it.
  const showDraftDiff = draftDiff && !(canCompare && compareWithCurrent && viewing?.version === draftDiff.version);
  const permissions = detail?.permissions;
  const attemptCrIds = new Set(changeRequests.map((item) => item.attemptId));
  return <article className={styles.task} id={anchorId.task(summary.id)} ref={cardRef}>
    <button type="button" className={styles.taskHead} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={styles.taskTitle}><strong>{task.title}</strong><small>第 {task.currentVersion} 版{task.confirmedVersion ? ` · 已确认第 ${task.confirmedVersion} 版` : ""} · 更新于 {dateLabel(task.updatedAt)}</small></span>
      <span className={styles.itemMeta}><Pill tone={statusTone}>{statusText}</Pill>{runs.length ? <small>{runs.length} 次运行</small> : null}</span>
    </button>
    <div className={stageStyles.head}>
      <TaskSourceLinks task={task} />
      <StageBar stages={stages} />
    </div>
    {open ? <div className={styles.taskBody}>
      {!detail && !error ? <p className={styles.muted} role="status">正在读取任务…</p> : null}
      <ErrorNote error={error} />
      <Notice>{notice}</Notice>
      {detail ? <>
        <StageSection label="任务内容" title="任务内容" line={lineOf("task")} open={isOpen("task")} onToggle={toggle("task")}>
          {versions.length > 1 ? <div className={stageStyles.sectionTools}><label className={styles.versionPick}><span className={styles.srOnly}>查看版本</span><select value={viewing?.version ?? ""} onChange={(event) => { setShowVersion(Number(event.target.value)); setCompareWithCurrent(false); }}>{[...versions].reverse().map((item) => <option key={item.version} value={item.version}>第 {item.version} 版{item.version === task.confirmedVersion ? "（已确认）" : item.version === task.currentVersion && task.status === "draft" ? "（待确认）" : ""}</option>)}</select></label>{canCompare ? <button type="button" aria-pressed={compareWithCurrent} onClick={() => setCompareWithCurrent(!compareWithCurrent)}>{compareWithCurrent ? "收起比较" : "与当前版比较"}</button> : null}</div> : null}
          {task.status === "draft" && task.confirmedVersion ? <p className={styles.warning}>第 {task.currentVersion} 版是修改后的草稿，需要重新确认；确认前不能启动新的代理或运行。</p> : null}
          {viewing ? <>
            <VersionBody version={viewing} />
            <p className={styles.muted}>快照 sha256 <code>{shortSha(viewing.snapshotSha256, 16)}</code>{viewing.confirmedAt ? ` · 确认于 ${dateLabel(viewing.confirmedAt)}` : " · 未确认"}</p>
            {canCompare && compareWithCurrent && latest ? <VersionDiff previous={viewing} current={latest} heading={`当前第 ${latest.version} 版与第 ${viewing.version} 版相比`} /> : null}
          </> : null}
          {showDraftDiff && draftDiff && latest && !editing ? <VersionDiff previous={draftDiff} current={latest} heading={`与第 ${draftDiff.version} 版相比（第 ${latest.version} 版的改动）`} /> : null}
          {editing && latest ? <TaskForm title={`修改任务（将生成第 ${task.currentVersion + 1} 版）`} submitLabel="保存为新版本" note="已确认的版本不会被覆盖；新版本需要重新确认。" initial={contentOf(latest) as TaskContentDraft} onSubmit={revise} onCancel={() => setEditing(false)} /> : <div className={styles.actions}>
            {permissions?.canConfirm ? <button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ action: "confirm", version: task.currentVersion }, `已确认第 ${task.currentVersion} 版。`)}>确认第 {task.currentVersion} 版</button> : null}
            {permissions?.canRevise ? <button type="button" disabled={busy} onClick={() => setEditing(true)}>修改任务</button> : null}
            {permissions?.canClose ? <ConfirmButton label="完成并关闭" confirmLabel="确认关闭" prompt="关闭后会停止排队中的代理。" busy={busy} onConfirm={() => void act({ action: "close" }, "任务已关闭。")} /> : null}
            {permissions?.canCancel ? <ConfirmButton label="取消任务" confirmLabel="确认取消" prompt="取消后不能恢复。" busy={busy} danger onConfirm={() => void act({ action: "cancel" }, "任务已取消。")} /> : null}
          </div>}
          {task.status === "draft" && !permissions?.canConfirm ? <Blocked>只有学生本人或有审核权限的导师可以确认任务。</Blocked> : null}
        </StageSection>

        <StageSection label="代理尝试" title={<>代理尝试 <small>{detail.attempts.length}</small></>} line={lineOf("code")} open={isOpen("attempts")} onToggle={toggle("attempts")}>
          {task.status === "confirmed" || task.status === "draft" ? <StartAttempt key={`${task.status}-${task.confirmedVersion}`} detail={detail} onStarted={refresh} /> : null}
          {detail.attempts.map((attempt) => <AttemptCard key={attempt.id} attempt={attempt} number={attemptNumbers.get(attempt.id) ?? null} onChanged={refresh} />)}
          {!detail.attempts.length ? <p className={styles.muted}>还没有代理尝试。</p> : null}
          {detail.attempts.some((attempt) => attempt.status === "change_ready" && !attemptCrIds.has(attempt.id)) ? <p className={styles.muted}>部分已完成的尝试尚未生成变更请求。</p> : null}
        </StageSection>

        <StageSection label="变更请求" title={<>变更请求 <small>{changeRequests.length}</small></>} line={lineOf("code")} open={isOpen("changes")} onToggle={toggle("changes")}>
          {changeRequests.map((item) => <ChangeRequestCard key={item.id} item={item} onChanged={refresh} />)}
          {!changeRequests.length ? <p className={styles.muted}>代理产出修改后，会在这里生成变更请求，审阅后发布为 Draft PR。</p> : null}
        </StageSection>

        <StageSection label="运行与结果" title={<>运行与结果 <small>{runs.length}</small></>} line={lineOf("run", "result", "next")} open={isOpen("runs")} onToggle={toggle("runs")}>
          {task.status === "confirmed" && !runFormOpen ? <div className={stageStyles.sectionTools}><button type="button" onClick={() => setRunFormOpen(true)}>登记运行</button></div> : null}
          {task.status !== "confirmed" && task.status !== "closed" && task.status !== "canceled" ? <Blocked>任务确认后才能登记运行。</Blocked> : null}
          {runFormOpen && confirmed ? <RunForm taskId={task.id} budget={confirmed.budget} changeRequests={changeRequests} entrypoints={options.entrypoints} datasets={options.datasets}
            onCreated={() => { setRunFormOpen(false); setNotice("运行已登记，等待导师批准。"); refresh(); }} onCancel={() => setRunFormOpen(false)} /> : null}
          {runs.map((run) => <RunCard key={run.id} run={run} number={runNumbers.get(run.id) ?? null} taskContent={contentOf(confirmed ?? latest)} options={options} onChanged={refresh} />)}
          {!runs.length ? <p className={styles.muted}>还没有运行。失败和取消的运行也会保留在这里。</p> : null}
        </StageSection>
      </> : null}
    </div> : null}
  </article>;
}
