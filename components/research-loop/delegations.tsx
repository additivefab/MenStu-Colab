"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getJson, LoopRequestError, postJson } from "./api";
import { dateLabel } from "./labels";
import { ConfirmButton, ErrorNote, Notice, Pill } from "./ui";
import local from "./delegations.module.css";
import styles from "./research-loop.module.css";

// FB1 peer code review delegations (docs/科研闭环_实施规格_v1.md §12,
// lib/review-delegation.ts). Who may list, grant or revoke is decided by the
// server; this file only renders what the server returns and its errors.

export const DELEGATION_SCOPE = "被委托人只能审阅、发布或驳回不涉及受保护路径的代码变更，不能批准运行或评审结果";
const ENDPOINT = "/api/review-delegations";

export type Delegation = {
  id: string;
  reviewerUserId: number | null;
  reviewerName: string;
  delegatedByName: string;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
  revokedByName: string;
};

export type DelegatedStudent = { studentId: string; studentName: string; since: string | null };

type Raw = Record<string, unknown>;

const text = (...values: unknown[]) => {
  for (const value of values) if (typeof value === "string" && value) return value;
  return "";
};
const integer = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
};
const rows = (payload: unknown, ...keys: string[]): Raw[] => {
  if (Array.isArray(payload)) return payload.filter((item): item is Raw => Boolean(item) && typeof item === "object");
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      const value = (payload as Raw)[key];
      if (Array.isArray(value)) return rows(value);
    }
  }
  return [];
};

/** Tolerates camelCase / snake_case and a few name variants of the backend shape. */
export function normalizeDelegations(payload: unknown): Delegation[] {
  return rows(payload, "delegations", "items").map((row) => {
    const reviewer = row.reviewer && typeof row.reviewer === "object" ? row.reviewer as Raw : {};
    const delegatedBy = row.delegatedBy && typeof row.delegatedBy === "object" ? row.delegatedBy as Raw : {};
    return {
      id: text(row.id, row.delegationId),
      reviewerUserId: integer(row.reviewerUserId, row.reviewer_user_id, reviewer.id),
      reviewerName: text(row.reviewerName, row.reviewerDisplayName, row.reviewer_name, reviewer.displayName, reviewer.name),
      delegatedByName: text(row.delegatedByName, row.delegated_by_name, typeof row.delegatedBy === "string" ? row.delegatedBy : "", delegatedBy.displayName, delegatedBy.name),
      active: row.active === true || row.active === 1,
      createdAt: text(row.createdAt, row.created_at),
      revokedAt: text(row.revokedAt, row.revoked_at) || null,
      revokedByName: text(row.revokedByName, row.revoked_by_name),
    };
  }).filter((item) => item.id);
}

export function normalizeDelegatedStudents(payload: unknown): DelegatedStudent[] {
  const seen = new Set<string>();
  const result: DelegatedStudent[] = [];
  for (const row of rows(payload, "students", "delegations", "items")) {
    const studentId = text(row.studentId, row.student_id);
    if (!studentId || seen.has(studentId)) continue;
    seen.add(studentId);
    result.push({
      studentId,
      studentName: text(row.studentName, row.displayName, row.student_name, row.display_name) || studentId,
      since: text(row.since, row.createdAt, row.created_at) || null,
    });
  }
  return result;
}

type UserOption = { id: number; name: string; detail: string };

function normalizeUsers(payload: unknown): UserOption[] {
  return rows(payload, "users").flatMap((row) => {
    const id = integer(row.id);
    if (id === null) return [];
    const studentName = text(row.student_name, row.studentName);
    return [{ id, name: text(row.display_name, row.displayName, row.name) || `用户 ${id}`, detail: studentName ? `学生档案：${studentName}` : "" }];
  });
}

/** Parses a user id typed by hand; returns an error message or the id. */
export function parseReviewerUserId(value: string): { id: number } | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { error: "请输入被委托人的用户编号" };
  if (!/^\d+$/u.test(trimmed)) return { error: "用户编号只能是正整数" };
  const id = Number(trimmed);
  if (!Number.isSafeInteger(id) || id <= 0) return { error: "用户编号无效" };
  return { id };
}

/** Staff section on the student's research loop: list, grant and revoke peer
 * code review delegations. Hidden when the server refuses the listing. */
export function Delegations({ studentId }: { studentId: string }) {
  const [items, setItems] = useState<Delegation[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [granting, setGranting] = useState(false);
  const [users, setUsers] = useState<UserOption[] | null>(null);
  const [usersUnavailable, setUsersUnavailable] = useState(false);
  const [manualId, setManualId] = useState("");
  const [inputError, setInputError] = useState("");
  const [showRevoked, setShowRevoked] = useState(false);

  const load = useCallback((signal?: AbortSignal) => getJson<unknown>(
    `${ENDPOINT}?studentId=${encodeURIComponent(studentId)}`, "代码审查委托读取失败", signal,
  ).then((payload) => {
    if (signal?.aborted) return;
    setItems(normalizeDelegations(payload));
    setError(null);
  }, (failure: unknown) => {
    if (signal?.aborted) return;
    if (failure instanceof LoopRequestError && failure.status === 403) setForbidden(true);
    else setError(failure);
  }), [studentId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // The account list is only served to some viewers; otherwise fall back to a
  // numeric user id. Either way the server validates the reviewer.
  useEffect(() => {
    if (!granting || users || usersUnavailable) return;
    const controller = new AbortController();
    getJson<unknown>("/api/users", "账号列表读取失败", controller.signal).then((payload) => {
      if (controller.signal.aborted) return;
      const options = normalizeUsers(payload);
      if (options.length) setUsers(options); else setUsersUnavailable(true);
    }, () => { if (!controller.signal.aborted) setUsersUnavailable(true); });
    return () => controller.abort();
  }, [granting, users, usersUnavailable]);

  async function act(tag: string, body: Record<string, unknown>, success: string) {
    setBusy(tag); setError(null); setNotice("");
    try {
      await postJson<unknown>(ENDPOINT, body, tag === "grant" ? "委托失败，请重试" : "撤销失败，请重试");
      setNotice(success);
      if (tag === "grant") { setGranting(false); setManualId(""); }
      await load();
    } catch (failure) { setError(failure); } finally { setBusy(null); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInputError("");
    let reviewerUserId: number;
    if (users) {
      const parsed = parseReviewerUserId(String(new FormData(event.currentTarget).get("reviewerUserId") ?? ""));
      if ("error" in parsed) { setInputError("请选择被委托人"); return; }
      reviewerUserId = parsed.id;
    } else {
      const parsed = parseReviewerUserId(manualId);
      if ("error" in parsed) { setInputError(parsed.error); return; }
      reviewerUserId = parsed.id;
    }
    void act("grant", { action: "grant", studentId, reviewerUserId }, "已委托代码审查。被委托人刷新页面后即可看到待审阅的变更。");
  }

  if (forbidden) return null;
  const active = items?.filter((item) => item.active) ?? [];
  const revoked = items?.filter((item) => !item.active) ?? [];
  const reviewerLabel = (item: Delegation) => item.reviewerName || (item.reviewerUserId !== null ? `用户 ${item.reviewerUserId}` : "未知用户");

  return <details className={local.section}>
    <summary>代码审查委托{items ? <span className={local.count}>{active.length ? `${active.length} 人有效` : "未委托"}</span> : null}</summary>
    <p className={local.scope}>{DELEGATION_SCOPE}。</p>
    {!items && !error ? <p className={styles.muted} role="status">正在读取…</p> : null}
    {items ? <>
      <ul className={styles.adminList}>
        {active.map((item) => <li key={item.id}>
          <span><strong>{reviewerLabel(item)}</strong><small>{item.delegatedByName ? `由 ${item.delegatedByName} 委托` : "委托"} · {dateLabel(item.createdAt)}</small></span>
          <span className={styles.rowActions}><Pill tone="good">有效</Pill>
            <ConfirmButton label="撤销" confirmLabel="确认撤销" prompt={`撤销后 ${reviewerLabel(item)} 将不能再审阅该学生的代码变更。`}
              busy={busy !== null} danger onConfirm={() => void act(`revoke-${item.id}`, { action: "revoke", delegationId: item.id }, "委托已撤销。")} /></span>
        </li>)}
        {!active.length ? <li className={styles.muted}>当前没有有效的委托，所有代码变更由学生本人或导师审阅。</li> : null}
      </ul>
      {revoked.length ? <div className={local.history}>
        <button type="button" aria-expanded={showRevoked} onClick={() => setShowRevoked((value) => !value)}>{showRevoked ? "收起" : "查看"}已撤销的委托（{revoked.length}）</button>
        {showRevoked ? <ul className={styles.adminList}>{revoked.map((item) => <li key={item.id}>
          <span><strong>{reviewerLabel(item)}</strong><small>{item.delegatedByName ? `由 ${item.delegatedByName} 委托` : "委托"} · {dateLabel(item.createdAt)} · {item.revokedByName ? `${item.revokedByName} ` : ""}撤销于 {dateLabel(item.revokedAt)}</small></span>
          <Pill tone="neutral">已撤销</Pill>
        </li>)}</ul> : null}
      </div> : null}
      {granting ? <form className={styles.form} onSubmit={submit} noValidate>
        <h4>委托代码审查</h4>
        {users ? <label>被委托人<select name="reviewerUserId" required defaultValue="">
          <option value="" disabled>请选择</option>
          {users.map((user) => <option key={user.id} value={user.id}>{user.name}（编号 {user.id}{user.detail ? ` · ${user.detail}` : ""}）</option>)}
        </select></label> : usersUnavailable ? <label>被委托人用户编号
          <input inputMode="numeric" autoComplete="off" value={manualId} aria-invalid={inputError ? true : undefined}
            onChange={(event) => { setManualId(event.target.value); setInputError(""); }} placeholder="例如 12" />
          <small>账号列表不可用，请输入被委托人的用户编号；服务器会核对该账号是否可以接受委托。</small>
        </label> : <p className={styles.muted} role="status">正在读取账号列表…</p>}
        {inputError ? <p className={styles.error} role="alert">{inputError}</p> : null}
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={busy !== null || (!users && !usersUnavailable)}>{busy === "grant" ? "正在委托…" : "确认委托"}</button>
          <button type="button" disabled={busy !== null} onClick={() => { setGranting(false); setInputError(""); }}>取消</button>
        </div>
      </form> : <div className={styles.actions}><button type="button" onClick={() => { setGranting(true); setNotice(""); }}>委托审查人</button></div>}
    </> : null}
    {error ? <div className={styles.errorRow}><ErrorNote error={error} />{!items ? <button type="button" onClick={() => void load()}>重新加载</button> : null}</div> : null}
    <Notice>{notice}</Notice>
  </details>;
}
