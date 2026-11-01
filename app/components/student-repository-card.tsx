"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import styles from "./student-repository-card.module.css";

type RepositoryVisibility = "private" | "public" | "unknown";
type RepositoryBinding = {
  studentId: string;
  githubUsername: string;
  repositoryUrl: string;
  repositoryFullName: string;
  visibility: RepositoryVisibility;
  version: number;
  updatedAt: string;
};
type RepositoryPayload = {
  binding: RepositoryBinding | null;
  canManage: boolean;
  currentVersion: number;
  error?: string;
};
type RepositoryDraft = {
  githubUsername: string;
  repositoryUrl: string;
  visibility: RepositoryVisibility;
};

const visibilityLabels: Record<RepositoryVisibility, string> = {
  private: "私有（设置记录）",
  public: "公开（设置记录）",
  unknown: "未注明公开性",
};

// A student change remounts the complete editor, including requests and draft values.
export function StudentRepositoryCard({ studentId }: { studentId: string }) {
  return <RepositoryCardContent key={studentId} studentId={studentId} />;
}

function RepositoryCardContent({ studentId }: { studentId: string }) {
  const titleId = useId();
  const formId = useId();
  const [data, setData] = useState<RepositoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<RepositoryDraft | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const readRequest = useRef<AbortController | null>(null);
  const writeRequest = useRef<AbortController | null>(null);
  const manageButton = useRef<HTMLButtonElement | null>(null);
  const accountInput = useRef<HTMLInputElement | null>(null);
  const unlinkButton = useRef<HTMLButtonElement | null>(null);
  const editingPreviously = useRef(false);
  const editing = draft !== null;

  const load = useCallback(async () => {
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    setLoading(true);
    setError("");
    setNotice("");
    setDraft(null);
    setConfirmUnlink(false);
    setConflict(false);
    try {
      const response = await fetch(`/api/student-repositories?studentId=${encodeURIComponent(studentId)}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      const payload = await response.json() as RepositoryPayload;
      if (!response.ok) throw new Error(payload.error || "科研仓库读取失败，请重试");
      if (!controller.signal.aborted) setData(payload);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setData(null);
        setError(failure instanceof Error ? failure.message : "科研仓库读取失败，请重试");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    void load();
    return () => {
      readRequest.current?.abort();
      writeRequest.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (editing) accountInput.current?.focus();
    else if (confirmUnlink) unlinkButton.current?.focus();
    else if (editingPreviously.current) manageButton.current?.focus();
    editingPreviously.current = editing || confirmUnlink;
  }, [editing, confirmUnlink]);

  function startEditing() {
    if (!data?.canManage || loading || busy) return;
    setDraft({
      githubUsername: data.binding?.githubUsername ?? "",
      repositoryUrl: data.binding?.repositoryUrl ?? "",
      visibility: data.binding?.visibility ?? "unknown",
    });
    setConfirmUnlink(false);
    setError("");
    setNotice("");
  }

  async function saveBinding(method: "PUT" | "DELETE") {
    if (!data?.canManage || busy || loading || conflict || (method === "PUT" && !draft)) return;
    const controller = new AbortController();
    writeRequest.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/student-repositories", {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          studentId,
          expectedVersion: data.currentVersion,
          ...(method === "PUT" ? draft : {}),
        }),
      });
      const payload = await response.json() as RepositoryPayload;
      if (controller.signal.aborted) return;
      if (response.status === 409) {
        setConflict(true);
        throw new Error("仓库设置已被更新。请载入最新设置后再修改。");
      }
      if (!response.ok) throw new Error(payload.error || "仓库设置保存失败，请重试");
      setData(payload);
      setDraft(null);
      setConfirmUnlink(false);
      setNotice(method === "DELETE" ? "已解除档案中的仓库绑定，GitHub 仓库仍保留。" : "科研仓库已绑定到学生档案。");
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "仓库设置保存失败，请重试");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveBinding("PUT");
  }

  const binding = data?.binding;

  return <section className={styles.card} aria-labelledby={titleId}>
    <div className={styles.header}>
      <div><h2 id={titleId}>科研仓库</h2><p>固定保存在学生档案中的代码入口</p></div>
      {!loading && data?.canManage && !draft && !confirmUnlink ? <button ref={manageButton} type="button" onClick={startEditing} disabled={busy || conflict}>
        {binding ? "管理绑定" : "绑定仓库"}
      </button> : null}
    </div>

    {loading && !data ? <p className={styles.helper} role="status">正在读取科研仓库…</p> : null}
    {binding ? <div className={styles.binding}>
      <div className={styles.repository}>
        <strong>{binding.repositoryFullName}</strong>
        <div className={styles.metadata}><span>GitHub 账号：{binding.githubUsername}</span><span className={styles.visibility}>{visibilityLabels[binding.visibility]}</span></div>
      </div>
      <a className={styles.open} href={binding.repositoryUrl} target="_blank" rel="noopener noreferrer">打开 GitHub 仓库 ↗</a>
    </div> : !loading && data ? <p className={styles.empty}>尚未绑定科研仓库。添加仓库地址后，可从这里直接打开。</p> : null}

    {error ? <div className={styles.message} role="alert"><p>{error}</p>
      {!data ? <button type="button" onClick={() => void load()} disabled={loading}>重新加载仓库</button> : null}
      {conflict ? <><span>载入后将放弃本次未保存的修改。</span><button type="button" onClick={() => void load()} disabled={loading || busy}>{loading ? "正在载入…" : "载入最新设置"}</button></> : null}
    </div> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

    {draft ? <form id={formId} className={styles.form} onSubmit={submit}>
      <div className={styles.fields}>
        <label>学生 GitHub 账号<input ref={accountInput} name="githubUsername" required maxLength={39} autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft.githubUsername} disabled={busy || conflict} placeholder="例如：lih62876-ui" onChange={(event) => setDraft({ ...draft, githubUsername: event.target.value })} /></label>
        <label className={styles.urlField}>仓库地址<input name="repositoryUrl" type="url" required maxLength={256} autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft.repositoryUrl} disabled={busy || conflict} placeholder="https://github.com/组织或账号/仓库名" onChange={(event) => setDraft({ ...draft, repositoryUrl: event.target.value })} /><small>填写仓库首页地址，具体代码版本链接仍放在进展记录中。</small></label>
        <label>GitHub 仓库可见性<select name="visibility" value={draft.visibility} disabled={busy || conflict} onChange={(event) => setDraft({ ...draft, visibility: event.target.value as RepositoryVisibility })}><option value="unknown">暂不注明</option><option value="private">私有</option><option value="public">公开</option></select></label>
      </div>
      <p className={styles.helper}>按 GitHub 实际设置填写可见性；保存绑定不会更改仓库权限。</p>
      <div className={styles.actions}>
        <button className={styles.save} type="submit" disabled={busy || conflict}>{busy ? "正在保存…" : "保存绑定"}</button>
        <button type="button" disabled={busy} onClick={() => { setDraft(null); if (!conflict) setError(""); }}>取消</button>
        {binding && !conflict ? <button className={styles.unlink} type="button" disabled={busy} onClick={() => { setDraft(null); setConfirmUnlink(true); setError(""); }}>解除绑定</button> : null}
      </div>
    </form> : null}

    {confirmUnlink ? <div className={styles.confirm}>
      <p>确认从学生档案中解除仓库绑定？此操作不会删除 GitHub 仓库或代码，也不会删除已有进展中的链接。</p>
      <div className={styles.actions}><button ref={unlinkButton} type="button" disabled={busy || conflict} onClick={() => void saveBinding("DELETE")}>{busy ? "正在解除…" : "确认解除绑定"}</button><button type="button" disabled={busy} onClick={() => { setConfirmUnlink(false); if (!conflict) setError(""); }}>保留绑定</button></div>
    </div> : null}

    <p className={styles.footer}>仓库访问权限由 GitHub 控制。提交科研进展时，仍需附上本次成果的具体版本链接。</p>
  </section>;
}
