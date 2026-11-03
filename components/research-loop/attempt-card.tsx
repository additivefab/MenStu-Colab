"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postJson, type AttemptDetail, type AttemptEvent, type AttemptSummary } from "./api";
import { attemptStatusLabels, dateLabel, label, providerLabels, shortSha } from "./labels";
import { ConfirmButton, ErrorNote, Pill } from "./ui";
import styles from "./research-loop.module.css";

const LIVE = new Set(["queued", "running", "waiting_approval", "cancel_requested"]);
const POLL_MS = 4000;
const MAX_EVENTS = 400;

const eventKindLabels: Record<string, string> = {
  status: "状态", message: "消息", tool_call: "工具调用", tool_result: "工具结果",
  file_change: "文件改动", test: "测试", usage: "用量", error: "错误",
};

function eventText(event: AttemptEvent) {
  const payload = event.payload ?? {};
  for (const key of ["text", "message", "summary", "status", "command", "path", "name"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  }
  const json = JSON.stringify(payload);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

/** One agent attempt. While it is live, new worker events are polled with
 * `afterSequence` so only the tail is transferred. */
export function AttemptCard({ attempt, number, onChanged }: { attempt: AttemptSummary; number?: number | null; onChanged: () => void }) {
  void number; // batch 1 (A3): shown as "代理 #n"
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AttemptDetail["attempt"] | null>(null);
  const [events, setEvents] = useState<AttemptEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const after = useRef(0);
  const status = detail?.status ?? attempt.status;
  const live = LIVE.has(status);

  const poll = useCallback((signal: AbortSignal) => getJson<AttemptDetail>(
    `/api/agent-attempts?attemptId=${encodeURIComponent(attempt.id)}&afterSequence=${after.current}`, "代理尝试读取失败", signal,
  ).then((payload) => {
    if (signal.aborted) return;
    setDetail(payload.attempt);
    if (payload.events.length) {
      after.current = payload.nextAfterSequence;
      setEvents((current) => [...current, ...payload.events].slice(-MAX_EVENTS));
    }
    setError(null);
  }, (failure: unknown) => { if (!signal.aborted) setError(failure); }), [attempt.id]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void poll(controller.signal);
    return () => controller.abort();
  }, [open, poll]);

  useEffect(() => {
    if (!open || !live) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => { void poll(controller.signal); }, POLL_MS);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [open, live, poll]);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/agent-attempts", { action: "cancel", attemptId: attempt.id }, "取消失败，请重试");
      const controller = new AbortController();
      await poll(controller.signal);
      onChanged();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  const [text, tone] = label(attemptStatusLabels, status);
  const errorCode = detail?.errorCode ?? attempt.errorCode;
  const errorMessage = detail?.errorMessage ?? attempt.errorMessage;
  return <article className={styles.item}>
    <button type="button" className={styles.itemHead} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={styles.itemTitle}>{providerLabels[attempt.provider] ?? attempt.provider} 代理 · 第 {attempt.taskVersion} 版任务</span>
      <span className={styles.itemMeta}><Pill tone={tone}>{text}</Pill><small>{dateLabel(attempt.createdAt)}</small></span>
    </button>
    {(status === "failed" || status === "canceled") && (errorCode || errorMessage)
      ? <p className={styles.failure}>{errorMessage || "未提供原因"}{errorCode ? <code>{errorCode}</code> : null}</p> : null}
    {open ? <div className={styles.itemBody}>
      <dl className={styles.fields}>
        <div className={styles.field}><dt>尝试编号</dt><dd className={styles.mono}>{attempt.id}</dd></div>
        <div className={styles.field}><dt>基准提交</dt><dd className={styles.mono}>{shortSha(attempt.baseCommitSha, 12)}</dd></div>
        <div className={styles.field}><dt>模型</dt><dd>{(detail?.modelId || attempt.modelId) || "由工作进程上报"}</dd></div>
        <div className={styles.field}><dt>最近心跳</dt><dd>{dateLabel(detail?.heartbeatAt)}</dd></div>
      </dl>
      {detail?.changedPaths.length ? <details className={styles.subtle}><summary>改动文件 {detail.changedPaths.length} 个</summary><ul className={styles.pathList}>{detail.changedPaths.map((path) => <li key={path}>{path}</li>)}</ul></details> : null}
      {detail?.tests.length ? <details className={styles.subtle}><summary>代理自测 {detail.tests.length} 项</summary><ul className={styles.pathList}>{detail.tests.map((item, index) => <li key={index}><code>{item.command}</code> → 退出码 {item.exitCode}{item.summary ? ` · ${item.summary}` : ""}</li>)}</ul></details> : null}
      <div className={styles.eventLog} aria-live={live ? "polite" : undefined}>
        <strong>工作进程事件{live ? <small> · 每 {POLL_MS / 1000} 秒刷新</small> : null}</strong>
        {events.length ? <ol>{events.map((event) => <li key={event.sequence}><span className={styles.eventKind}>{eventKindLabels[event.kind] ?? event.kind}</span><span className={styles.eventText}>{eventText(event)}</span><small>#{event.sequence}</small></li>)}</ol>
          : <p className={styles.muted}>{live ? "等待工作进程上报事件…" : "没有事件记录。"}</p>}
      </div>
      <ErrorNote error={error} />
      {live && status !== "cancel_requested" ? <div className={styles.actions}>
        <ConfirmButton label="取消代理尝试" confirmLabel="确认取消" prompt="取消后需重新发起。" busy={busy} onConfirm={() => void cancel()} />
      </div> : null}
    </div> : null}
  </article>;
}
