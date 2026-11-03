"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getJson, type ChangeRequest, type TaskSummary } from "./api";
import { ChangeRequestCard } from "./change-request-card";
import { DELEGATION_SCOPE, normalizeDelegatedStudents, type DelegatedStudent } from "./delegations";
import { dateLabel, providerLabels } from "./labels";
import { ErrorNote, Pill } from "./ui";
import local from "./delegations.module.css";
import styles from "./research-loop.module.css";

// FB1: a delegated reviewer's own list of change requests waiting for review,
// per delegated student. Everything shown comes from the server; what the
// reviewer may do is decided on the card itself (server permissions).

type PendingItem = { task: TaskSummary; changeRequest: ChangeRequest };
type StudentReviews = DelegatedStudent & { pending: PendingItem[] | null; error: unknown };

async function loadStudent(student: DelegatedStudent, signal: AbortSignal): Promise<StudentReviews> {
  try {
    const { tasks } = await getJson<{ tasks: TaskSummary[] }>(
      `/api/research-tasks?studentId=${encodeURIComponent(student.studentId)}`, "研究任务读取失败", signal);
    // Drafts never have agent attempts, so they cannot have change requests.
    const candidates = (tasks ?? []).filter((task) => task.status !== "draft");
    const lists = await Promise.all(candidates.map(async (task) => {
      const payload = await getJson<{ changeRequests: ChangeRequest[] }>(
        `/api/change-requests?taskId=${encodeURIComponent(task.id)}`, "变更请求读取失败", signal);
      return (payload.changeRequests ?? []).filter((item) => item.status === "pending_review").map((changeRequest) => ({ task, changeRequest }));
    }));
    const pending = lists.flat().sort((a, b) => a.changeRequest.createdAt.localeCompare(b.changeRequest.createdAt));
    return { ...student, pending, error: null };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ...student, pending: null, error };
  }
}

/** Dashboard list for a delegated code reviewer. Renders nothing when the
 * viewer holds no delegation (or the listing is unavailable). */
export function DelegatedReviews() {
  const titleId = useId();
  const [students, setStudents] = useState<StudentReviews[] | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const delegated = normalizeDelegatedStudents(await getJson<unknown>("/api/review-delegations?mine=1", "代码审查委托读取失败", controller.signal));
      const loaded = await Promise.all(delegated.map((student) => loadStudent(student, controller.signal)));
      if (!controller.signal.aborted) setStudents(loaded);
    } catch {
      // No delegation listing for this viewer (or it failed): show nothing.
      if (!controller.signal.aborted) setStudents([]);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); request.current?.abort(); };
  }, [load]);

  if (!students?.length) return null;
  const total = students.reduce((sum, student) => sum + (student.pending?.length ?? 0), 0);
  return <section className={styles.panel} aria-labelledby={titleId}>
    <header className={styles.panelHead}>
      <div>
        <h2 id={titleId}>代为审查的代码变更{total ? <small className={local.count}>{total} 项待审阅</small> : null}</h2>
        <p>导师委托你审阅以下学生的代码变更。{DELEGATION_SCOPE}。</p>
      </div>
      <button type="button" disabled={loading} onClick={() => void load()}>{loading ? "正在刷新…" : "刷新"}</button>
    </header>
    {students.map((student) => <div key={student.studentId} className={local.student}>
      <div className={local.studentHead}>
        <h4>{student.studentName}{student.pending ? <small>{student.pending.length ? `${student.pending.length} 项待审阅` : "暂无待审阅"}</small> : null}</h4>
        {student.since ? <small>委托自 {dateLabel(student.since)}</small> : null}
      </div>
      <ErrorNote error={student.error} />
      {student.pending?.length ? <ul className={local.list}>{student.pending.map(({ task, changeRequest }) => {
        const actionable = changeRequest.permissions?.canPublish || changeRequest.permissions?.canReject;
        return <li key={changeRequest.id}>
          <span>
            <strong>{task.title}</strong>
            <small>{providerLabels[changeRequest.provider] ?? changeRequest.provider}{changeRequest.modelId ? ` · ${changeRequest.modelId}` : ""} · 提交于 {dateLabel(changeRequest.createdAt)}</small>
          </span>
          <span className={local.right}>
            {changeRequest.requiresExtraReview ? <Pill tone="warn">涉及受保护路径，由导师处理</Pill> : actionable ? <Pill tone="info">待你审阅</Pill> : <Pill tone="neutral">仅可查看</Pill>}
          </span>
          {/* Reviewed in place: a delegate may be a student, who cannot open another student's profile page. */}
          <ChangeRequestCard item={changeRequest} onChanged={() => void load()} />
        </li>;
      })}</ul> : null}
    </div>)}
  </section>;
}
