"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { validateProgressFiles } from "../lib/progress-attachments";
import { instantTimestamp } from "../lib/dashboard-overview/dates";
import { findProgressResolutionTarget, groupProgressTasks, progressTaskFilter, type ProgressResolutionTarget, type ProgressTaskFilter } from "../lib/progress-task-view";
import type { ProgressResolutionAttachment as ResolutionAttachment, ProgressResolutionHistory as ResolutionEvent, ProgressResolutionItem as ResolutionItem } from "../lib/progress-resolution";
import styles from "./progress-resolution-panel.module.css";

type ResolutionPayload = {
  items?: ResolutionItem[];
  canReview?: boolean;
  canSubmit?: boolean;
  error?: string;
};
type Editor = { item: ResolutionItem; action: "submit" | "resolve" | "request_changes" | "reopen" };

export type ProgressResolutionPanelProps = {
  studentId?: string;
  mode: "student" | "staff";
  entryId?: number;
  onChanged?: () => void | Promise<void>;
  onConfirmed?: () => void | Promise<void>;
  compact?: boolean;
  refreshKey?: string | number;
  openRequest?: ProgressResolutionTarget & { key: number };
  initialFilter?: ProgressTaskFilter;
  filterRequest?: { filter: ProgressTaskFilter; key: number };
};

const changedEvent = "progress-resolutions-changed";
const attachmentAccept = ".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff";

function completeLabel(item: ResolutionItem) {
  return item.itemKind === "blocker" ? "已解决" : "已完成";
}

function statusLabel(item: ResolutionItem) {
  if (item.current === false) return item.status === "resolved" ? completeLabel(item) : "历史事项";
  return { open: "待处理", pending: "待确认", resolved: completeLabel(item), changes_requested: "待修改" }[item.status];
}

function submitLabel(item: ResolutionItem) {
  const noun = item.itemKind === "blocker" ? "处理结果" : "完成结果";
  return `${item.status === "changes_requested" ? "修改后提交" : "提交"}${noun}`;
}

function eventLabel(event: ResolutionEvent, item: ResolutionItem) {
  return { submit: "提交结果", confirm: `确认${completeLabel(item)}`, request_changes: "退回修改", reopen: "重新打开" }[event.action];
}

function dateLabel(value: string) {
  const timestamp = instantTimestamp(value);
  if (!Number.isFinite(timestamp)) return value.slice(0, 16);
  const parsed = new Date(timestamp);
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed);
}

function Attachments({ files }: { files: ResolutionAttachment[] }) {
  if (!files.length) return null;
  return <ul className={styles.attachments}>{files.map((file) => <li key={file.id}>
    <a href={file.url} target="_blank" rel="noreferrer">{file.fileName}</a>
    <small>{file.sizeBytes < 1024 * 1024 ? `${Math.max(1, Math.round(file.sizeBytes / 1024))} KB` : `${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB`}</small>
  </li>)}</ul>;
}

export function ProgressResolutionPanel({ studentId, mode, entryId, onChanged, onConfirmed, compact = false, refreshKey = 0, openRequest, initialFilter = "open", filterRequest }: ProgressResolutionPanelProps) {
  const panelId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [payload, setPayload] = useState<ResolutionPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProgressTaskFilter>(initialFilter);
  const [search, setSearch] = useState("");
  const [focusRequest, setFocusRequest] = useState<{ itemKey?: string; key: number } | null>(null);
  const sequence = useRef(0);
  const confirmRequests = useRef(new Map<string, string>());
  const handledOpenRequest = useRef<string | null>(null);
  const handledFilterRequest = useRef<string | null>(null);
  const previousRefreshKey = useRef(refreshKey);

  const load = useCallback(async () => {
    const requestSequence = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams(studentId ? { studentId } : { view: "completed" });
      if (entryId !== undefined) params.set("entryId", String(entryId));
      const response = await fetch(`/api/progress-resolutions?${params}`, { cache: "no-store" });
      const result = await response.json() as ResolutionPayload;
      if (!response.ok) throw new Error(result.error || "事项读取失败，请重试");
      if (sequence.current === requestSequence) setPayload(result);
    } catch (failure) {
      if (sequence.current === requestSequence) setError(failure instanceof Error ? failure.message : "事项读取失败，请重试");
    } finally {
      if (sequence.current === requestSequence) setLoading(false);
    }
  }, [studentId, entryId]);

  useEffect(() => {
    setPayload(null);
    setNotice("");
    setEditor(null);
    setFilter(initialFilter);
    setFocusRequest(null);
    void load();
    return () => { sequence.current += 1; };
  }, [load, initialFilter]);

  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    function reload(event: Event) {
      const detail = (event as CustomEvent<{ studentId: string; source: string }>).detail;
      if (detail && (!studentId || detail.studentId === studentId) && detail.source !== panelId) void load();
    }
    window.addEventListener(changedEvent, reload);
    return () => window.removeEventListener(changedEvent, reload);
  }, [studentId, panelId, load]);

  async function changed(message: string, nextFilter: ProgressTaskFilter) {
    setEditor(null);
    setNotice(message);
    setFilter(nextFilter);
    await load();
    window.dispatchEvent(new CustomEvent(changedEvent, { detail: { studentId, source: panelId } }));
    try { await onChanged?.(); }
    catch { setError("操作已保存，页面更新失败，请刷新页面。"); }
    noticeRef.current?.focus({ preventScroll: true });
  }

  async function confirm(item: ResolutionItem) {
    if (confirming) return;
    const requestKey = `${item.key}:${item.version}`;
    const requestId = confirmRequests.current.get(requestKey) ?? crypto.randomUUID();
    confirmRequests.current.set(requestKey, requestId);
    setConfirming(item.key);
    setError("");
    try {
      const response = await fetch("/api/progress-resolutions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progressEntryId: item.progressEntryId, revisionNumber: item.revisionNumber, itemKind: item.itemKind, expectedVersion: item.version, action: "confirm", note: "", requestId }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "确认失败，请重试");
      confirmRequests.current.delete(requestKey);
      try { await onConfirmed?.(); }
      catch { setError("任务已完成，列表更新失败，请刷新页面。"); }
      await changed("已确认，任务已移入“已完成”。", "completed");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "确认失败，请重试"); }
    finally { setConfirming(null); }
  }

  const items = (payload?.items ?? []).filter((item) => entryId === undefined || item.progressEntryId === entryId);
  const allStudents = !studentId;
  const canSubmit = !allStudents && mode === "student" && payload?.canSubmit === true;
  const canReview = !allStudents && mode === "staff" && payload?.canReview === true;
  const groups = groupProgressTasks(items);
  const activeFilter = allStudents ? "completed" : filter;

  useEffect(() => {
    if (!filterRequest) return;
    const requestKey = `${studentId}:${filterRequest.key}`;
    if (handledFilterRequest.current === requestKey) return;
    handledFilterRequest.current = requestKey;
    setFilter(filterRequest.filter);
    setFocusRequest({ key: filterRequest.key });
  }, [filterRequest, studentId]);

  useEffect(() => {
    if (!focusRequest || loading) return;
    const frame = requestAnimationFrame(() => {
      const card = focusRequest.itemKey ? Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-task-key]") ?? []).find((element) => element.dataset.taskKey === focusRequest.itemKey) : null;
      const target = card ?? panelRef.current?.querySelector<HTMLElement>("h3");
      const group = card?.closest("details");
      if (group) group.open = true;
      target?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, loading, activeFilter]);

  useEffect(() => {
    if (!openRequest || loading || !payload) return;
    const requestKey = `${studentId}:${openRequest.key}`;
    if (handledOpenRequest.current === requestKey) return;
    handledOpenRequest.current = requestKey;
    const item = findProgressResolutionTarget(payload.items ?? [], openRequest);
    setEditor(null);
    if (!item) { setNotice("事项已更新，请查看最新进展。"); return; }
    setNotice("");
    const itemFilter = progressTaskFilter(item);
    if (itemFilter !== "historical") setFilter(itemFilter);
    setFocusRequest({ itemKey: item.key, key: openRequest.key });
    if (item.current && studentId && mode === "student" && payload.canSubmit && (item.status === "open" || item.status === "changes_requested")) setEditor({ item, action: "submit" });
  }, [openRequest, payload, loading, studentId, mode]);

  function renderItem(item: ResolutionItem) {
      const history = item.history;
      const submission = history.find((event) => event.action === "submit");
      const confirmation = history.find((event) => event.action === "confirm");
      const current = item.current !== false;
      const itemCanReview = canReview && item.canReview !== false;
      return <article key={item.key} data-task-key={item.key} id={`progress-resolution-${item.progressEntryId}-${item.itemKind}${current && item.sourceCurrent !== false ? "" : `-revision-${item.revisionNumber}`}`} tabIndex={-1} className={styles.item}>
        <div className={styles.itemTop}><strong>{allStudents && item.studentName ? <span className={styles.studentName}>{item.studentName} · </span> : null}{item.itemKind === "blocker" ? "困难" : "下一步计划"}</strong><span className={`${styles.status} ${item.status === "resolved" ? styles.resolved : item.status === "pending" ? styles.pending : ""}`}>{statusLabel(item)}</span></div>
        <p className={styles.itemText}>{item.text}</p>
        <p className={styles.meta}>{item.trackType === "paper" ? "论文" : "课题"} · {item.title}{item.sourceCurrent === false && item.itemKind === "blocker" ? <span>来源 V{item.revisionNumber} · 问题独立跟进</span> : null}{item.dueDate ? <span>期限 {item.dueDate}</span> : null}</p>
        {item.submissionNote || submission ? <div className={styles.result}><strong>{item.status === "resolved" ? "完成说明" : "处理结果"}</strong><p>{item.submissionNote || submission?.note}</p><Attachments files={submission?.attachments ?? []} /><p className={styles.resultMeta}>提交：{submission?.actorName || "学生"}{item.submittedAt || submission?.createdAt ? ` · ${dateLabel(item.submittedAt || submission!.createdAt)}` : ""}</p></div> : null}
        {item.status === "resolved" && confirmation?.note ? <div className={styles.result}><strong>导师确认说明</strong><p>{confirmation.note}</p></div> : null}
        {item.status === "resolved" ? <p className={styles.confirmation}>确认：{confirmation?.actorName || "管理员"}{item.resolvedAt || confirmation?.createdAt ? ` · ${dateLabel(item.resolvedAt || confirmation!.createdAt)}` : ""}</p> : null}
        {item.reviewerNote && (item.status === "changes_requested" || item.status === "open") ? <p className={styles.reviewNote}><strong>{item.status === "changes_requested" ? "导师修改意见：" : "重开原因："}</strong>{item.reviewerNote}</p> : null}
        <div className={styles.itemFooter}>
          {item.status === "resolved" ? <small>任务已完成，结果与处理记录已保留。</small>
            : !current ? <small>该事项未确认完成，仅保留历史记录。</small>
              : item.status === "pending" ? <small>已提交，等待管理员确认。</small>
                : mode === "staff" ? <small>{item.status === "changes_requested" ? "已退回，等待学生按意见修改后提交结果。" : itemCanReview ? "可确认完成，或退回并填写修改意见。" : "等待学生提交处理结果。"}</small> : <small>{item.status === "changes_requested" ? "请按导师意见修改后提交结果，再由导师确认。" : "提交结果后，由管理员确认。"}</small>}
          <div className={styles.actions}>
            {allStudents && item.studentId ? <a className={styles.textButton} href={`/students/${encodeURIComponent(item.studentId)}#progress-${item.progressEntryId}`}>查看原进展</a> : null}
            {current && canSubmit && (item.status === "open" || item.status === "changes_requested") ? <button type="button" className={styles.primaryButton} onClick={() => { setNotice(""); setEditor({ item, action: "submit" }); }}>{submitLabel(item)}</button> : null}
            {current && itemCanReview && (item.status === "open" || item.status === "pending" || item.status === "changes_requested") ? <button type="button" className={styles.button} disabled={confirming !== null} onClick={() => setEditor({ item, action: "request_changes" })}>{item.status === "changes_requested" ? "补充修改意见" : "退回修改"}</button> : null}
            {current && itemCanReview && (item.status === "open" || item.status === "changes_requested") ? <button type="button" className={styles.primaryButton} disabled={confirming !== null} onClick={() => { setNotice(""); setEditor({ item, action: "resolve" }); }}>确认{completeLabel(item)}</button> : null}
            {current && itemCanReview && item.status === "pending" ? <button type="button" className={styles.primaryButton} disabled={confirming !== null} onClick={() => void confirm(item)}>{confirming === item.key ? "正在确认…" : `确认${completeLabel(item)}`}</button> : null}
            {current && itemCanReview && item.status === "resolved" ? <button type="button" className={styles.textButton} disabled={confirming !== null} onClick={() => setEditor({ item, action: "reopen" })}>重新打开</button> : null}
          </div>
        </div>
        {history.length ? <details className={styles.history}><summary>处理记录 · {history.length}</summary><ol>{history.map((event) => <li key={event.id}><div><strong>{event.actorName} · {eventLabel(event, item)}</strong><time>{dateLabel(event.createdAt)}</time></div>{event.note ? <p>{event.note}</p> : null}<Attachments files={event.attachments} /></li>)}</ol></details> : null}
      </article>;
  }

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleItems = groups[activeFilter].filter((item) => !allStudents || !normalizedSearch || [item.studentName, item.title, item.text, item.submissionNote, item.reviewerNote].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch)));
  const filters: Array<{ value: ProgressTaskFilter; label: string }> = [{ value: "open", label: "待处理" }, { value: "pending", label: "待确认" }, { value: "completed", label: "已完成" }];
  const emptyLabel = normalizedSearch && allStudents ? "没有符合条件的已完成任务。" : { open: "暂无待处理任务。", pending: "暂无待确认结果。", completed: "暂无已完成任务。" }[activeFilter];
  return <section ref={panelRef} className={`${styles.panel}${compact ? ` ${styles.compact}` : ""}`} aria-labelledby={`${panelId}-title`}>
    <header className={styles.header}><h3 id={`${panelId}-title`} tabIndex={-1}>{allStudents ? "已完成任务" : "任务与结果"}</h3>{allStudents && payload ? <span>{groups.completed.length} 项</span> : null}</header>
    {allStudents ? <label className={styles.search}><span className={styles.srOnly}>查找已完成任务</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索学生姓名或任务" /></label> : <div className={styles.filters} aria-label="任务状态">{filters.map(({ value, label }) => <button key={value} type="button" aria-pressed={filter === value} className={`${styles.filter}${filter === value ? ` ${styles.selectedFilter}` : ""}`} onClick={() => { setFilter(value); setFocusRequest(null); }}>{label}<span>{groups[value].length}</span></button>)}</div>}
    {notice ? <p ref={noticeRef} tabIndex={-1} className={styles.notice} role="status">{notice}</p> : null}
    {error ? <p className={styles.error} role="alert">{error} <button type="button" className={styles.textButton} onClick={() => void load()}>重新读取</button></p> : null}
    {loading && !payload ? <p className={styles.empty} role="status">正在读取…</p> : null}
    <div className={styles.items} aria-label={filters.find(({ value }) => value === activeFilter)?.label}>{visibleItems.map(renderItem)}</div>
    {!loading && !error && !visibleItems.length ? <p className={styles.empty}>{emptyLabel}</p> : null}
    {!allStudents && groups.historical.length ? <details className={styles.historical}><summary>历史事项 · 未确认完成 {groups.historical.length} 项</summary><div className={styles.items}>{groups.historical.map(renderItem)}</div></details> : null}
    {editor ? <ResolutionDialog editor={editor} onClose={() => setEditor(null)} onSaved={changed} /> : null}
  </section>;
}

function ResolutionDialog({ editor: { item, action }, onClose, onSaved }: { editor: Editor; onClose: () => void; onSaved: (message: string, nextFilter: ProgressTaskFilter) => Promise<void> }) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const isSubmission = action === "submit";
  const isResolution = action === "resolve";
  const title = isSubmission ? submitLabel(item) : isResolution ? `确认${completeLabel(item)}` : action === "request_changes" ? item.status === "changes_requested" ? "补充修改意见" : "退回修改" : "重新打开事项";

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    textareaRef.current?.focus();
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const note = String(form.get("note") ?? "").trim();
    if (!note) { setError(isSubmission ? "请填写处理结果。" : isResolution ? "请填写完成情况与核实依据。" : action === "request_changes" ? "请填写具体修改意见。" : "请填写原因。"); textareaRef.current?.focus(); return; }
    const files = form.getAll("files").filter((file): file is File => file instanceof File && Boolean(file.name));
    try { validateProgressFiles(files); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "附件格式不正确"); return; }
    const fingerprint = JSON.stringify({ note, files: files.map((file) => [file.name, file.size, file.lastModified]) });
    if (requestRef.current?.fingerprint !== fingerprint) requestRef.current = { fingerprint, id: crypto.randomUUID() };
    const requestId = requestRef.current.id;
    setBusy(true);
    setError("");
    try {
      const target = { progressEntryId: item.progressEntryId, revisionNumber: item.revisionNumber, itemKind: item.itemKind, expectedVersion: item.version, requestId };
      let response: Response;
      if (isSubmission) {
        const body = new FormData();
        Object.entries(target).forEach(([key, value]) => body.set(key, String(value)));
        body.set("note", note);
        files.forEach((file) => body.append("files", file));
        response = await fetch("/api/progress-resolutions", { method: "POST", body });
      } else {
        response = await fetch("/api/progress-resolutions", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, action, note }) });
      }
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "保存失败，请重试");
      await onSaved(isSubmission ? "结果已提交，等待管理员确认。" : isResolution ? "已确认，任务已移入“已完成”，该事项提醒已关闭。" : action === "request_changes" ? "修改意见已保存，等待学生修改后提交结果。" : "事项已重新打开，学生可再次提交结果。", isSubmission ? "pending" : isResolution ? "completed" : "open");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败，请重试"); setBusy(false); }
  }

  return createPortal(<dialog ref={dialogRef} className={styles.dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-item`} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className={styles.dialogHeader}><h2 id={`${id}-title`}>{title}</h2><button type="button" className={styles.closeButton} disabled={busy} onClick={onClose} aria-label="关闭对话框">×</button></div>
    <div className={styles.dialogContext} id={`${id}-item`}><strong>{item.itemKind === "blocker" ? "困难" : "计划"}</strong><p>{item.text}</p>{item.dueDate ? <small>原定期限 {item.dueDate}</small> : null}</div>
    {action === "request_changes" && item.submissionNote ? <div className={styles.dialogResult}><strong>学生提交的结果</strong><p>{item.submissionNote}</p></div> : null}
    {item.status === "changes_requested" && item.reviewerNote && (isSubmission || action === "request_changes") ? <div className={styles.dialogResult}><strong>导师修改意见</strong><p>{item.reviewerNote}</p></div> : null}
    {action === "request_changes" ? <p>请写明需要修改的内容、要求和需补充的材料。学生会看到这些意见，修改后重新提交结果。</p> : null}
    {isResolution ? <p>请核实这项{item.itemKind === "blocker" ? "困难已解决" : "计划已完成"}后填写说明。确认后将关闭该事项提醒，并保留你的确认记录。</p> : null}
    <form onSubmit={submit}>
      <label className={styles.field} htmlFor={`${id}-note`}>{isSubmission ? "结果说明" : isResolution ? "完成情况与核实依据" : action === "request_changes" ? "具体修改意见" : "重新打开的原因"}<textarea ref={textareaRef} id={`${id}-note`} name="note" required maxLength={4000} rows={5} disabled={busy} placeholder={isSubmission ? item.itemKind === "blocker" ? "说明困难如何解决，以及目前的结果。" : "说明计划完成情况，以及可以核对的结果。" : isResolution ? "说明已完成什么，以及你核对过的材料或结果。" : action === "request_changes" ? "例如：补充对比实验数据，修改图表标注，并逐条说明修改情况。" : "说明为什么需要继续处理。"} /></label>
      {isSubmission ? <label className={styles.field} htmlFor={`${id}-files`}>附件（可选）<input id={`${id}-files`} type="file" name="files" accept={attachmentAccept} multiple disabled={busy} /><small>最多 5 个文件，单个不超过 50 MB，总计不超过 80 MB。</small></label> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <footer className={styles.dialogActions}><button className={styles.button} type="button" disabled={busy} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={busy}>{busy ? "正在保存…" : isSubmission ? "提交给管理员确认" : isResolution ? `确认${completeLabel(item)}` : action === "request_changes" ? "确认退回" : "确认重新打开"}</button></footer>
    </form>
  </dialog>, document.body);
}
