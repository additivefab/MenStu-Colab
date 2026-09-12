"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

type RecordTarget = { id: number; title: string; current_revision: number; review_status: string; deletion_id?: string };

export function AiRecordActions({ record, restore = false, onChanged }: {
  record: RecordTarget;
  restore?: boolean;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector('button')?.focus();
    else if (wasConfirming.current) buttonRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  useEffect(() => {
    if (!error || busy) return;
    if (confirming) confirmRef.current?.querySelector<HTMLButtonElement>('button:last-child')?.focus();
    else buttonRef.current?.focus();
  }, [error, busy, confirming]);
  const action = restore ? '恢复' : '删除';
  async function change() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/ai-records', {
        method: restore ? 'PATCH' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progressId: record.id, revision: record.current_revision, reviewStatus: record.review_status, deletionId: record.deletion_id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || `${action}失败，请重试`);
      setConfirming(false);
      await onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `${action}失败，请重试`);
    } finally { setBusy(false); }
  }
  function cancel() {
    setConfirming(false);
    setError('');
  }
  return <div className="ai-record-actions">
    {!confirming ? <button type="button" ref={buttonRef} className={restore ? '' : 'ai-record-delete'}
      aria-label={`${action} AI 记录：${record.title}`} disabled={busy}
      onClick={() => { if (restore) void change(); else setConfirming(true); }}>{busy ? `${action}中…` : action}</button>
      : <div className="ai-record-confirm" ref={confirmRef} role="group" aria-label={`删除确认：${record.title}`}>
        <p>删除“{record.title}”？删除后不再显示或计入进展，可在“已删除”中恢复。</p>
        <div><button type="button" disabled={busy} onClick={cancel}>取消</button>
          <button type="button" className="ai-record-delete" disabled={busy} onClick={() => void change()}>{busy ? '删除中…' : '确认删除'}</button></div>
      </div>}
    {error ? <p role="alert" className="ai-record-error">{error}</p> : null}
  </div>;
}

type DeletedRecord = RecordTarget & { deleted_at: string; deleted_by: string };

export function DeletedAiRecords({ studentId, onChanged, refreshKey = 0 }: { studentId: string; onChanged: () => Promise<void>; refreshKey?: number }) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<DeletedRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/ai-records?studentId=${encodeURIComponent(studentId)}`, { cache: 'no-store' });
      const payload = await response.json() as { records?: DeletedRecord[]; error?: string };
      if (!response.ok) throw new Error(payload.error || '已删除记录读取失败');
      setRecords(payload.records ?? []);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '读取失败，请重试'); }
    finally { setLoading(false); }
  }, [studentId]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [open, refreshKey, load]);
  return <div className="ai-deleted-records">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? '收起已删除记录' : '已删除'}</button>
    {open ? <div aria-label="已删除的 AI 记录">
      {loading ? <p role="status">正在加载…</p> : error ? <p role="alert">{error} <button type="button" onClick={() => void load()}>重试</button></p>
        : records.length ? records.map((record) => <article key={record.id}>
          <div><strong>{record.title}</strong><small>{record.deleted_by} · {record.deleted_at.slice(0, 10)} 删除</small></div>
          <AiRecordActions record={record} restore onChanged={async () => { await load(); await onChanged(); }} />
        </article>) : <p>暂无已删除记录</p>}
    </div> : null}
  </div>;
}
