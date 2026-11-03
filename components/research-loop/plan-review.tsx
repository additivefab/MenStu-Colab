"use client";

import { useState } from "react";
import { LoopRequestError, postJson, type AttemptPlan } from "./api";
import { dateLabel, label, planDecisionLabels } from "./labels";
import { Blocked, ConfirmButton, ErrorNote, Notice, Pill } from "./ui";
import styles from "./research-loop.module.css";
import css from "./plan-review.module.css";

const NOTE_MAX = 2000;

function decider(value: AttemptPlan["decidedBy"]) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** FB2 "修改计划" block of a plan-first attempt: the agent's plan, its decision
 * state and — for a mentor or the student who did not start the attempt — the
 * approve / reject actions. Authorization comes only from `canDecide`. */
export function PlanReview({ attemptId, plan, canDecide, onDecided }: {
  attemptId: string;
  plan: AttemptPlan;
  canDecide: boolean;
  /** Reloads the attempt (after a decision, or after a 409 version conflict). */
  onDecided: () => void | Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [text, tone] = label(planDecisionLabels, plan.decision);
  const pending = plan.decision === "pending";
  const decided = plan.decision === "approved" || plan.decision === "rejected";
  const by = decider(plan.decidedBy);
  const body = typeof plan.text === "string" ? plan.text : "";
  const decisionNote = typeof plan.note === "string" ? plan.note.trim() : "";

  async function decide(decision: "approved" | "rejected") {
    setBusy(true); setError(null); setNotice("");
    try {
      await postJson("/api/agent-attempts", {
        action: "decide_plan", attemptId, decision, note: note.trim(), expectedVersion: plan.version,
      }, decision === "approved" ? "批准计划失败，请重试" : "退回计划失败，请重试");
      setNote("");
      setNotice(decision === "approved" ? "已批准计划，代理将按此计划进入修改阶段。" : "已退回计划，本次尝试已取消。");
      await onDecided();
    } catch (failure) {
      setError(failure);
      // Someone else decided (or the agent resubmitted) first: show the latest plan.
      if (failure instanceof LoopRequestError && failure.status === 409) await Promise.resolve(onDecided()).catch(() => {});
    } finally { setBusy(false); }
  }

  return <section className={css.plan} aria-label="修改计划">
    <div className={css.head}>
      <strong>修改计划</strong>
      <Pill tone={tone}>{text}</Pill>
      {plan.submittedAt ? <small>提交于 {dateLabel(plan.submittedAt)}</small> : null}
    </div>
    {body.trim()
      ? <pre className={css.text} aria-label="计划内容">{body}</pre>
      : <p className={styles.muted}>{plan.decision === "awaiting_plan" ? "代理正在阅读代码并撰写计划，提交前不会修改任何文件。" : "计划内容为空。"}</p>}
    {decided ? <p className={css.decision}>
      {plan.decision === "approved" ? "已批准" : "已退回"}
      {by ? ` · ${by}` : ""}
      {plan.decidedAt ? ` · ${dateLabel(plan.decidedAt)}` : ""}
      {decisionNote ? <span className={css.note}>意见：{decisionNote}</span> : null}
    </p> : null}
    <ErrorNote error={error} />
    <Notice>{notice}</Notice>
    {pending && canDecide ? <div className={css.decide}>
      <label>审阅意见（可选）
        <textarea rows={2} value={note} maxLength={NOTE_MAX} disabled={busy} placeholder="例如：只改 train.py，不要动数据加载" onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void decide("approved")}>{busy ? "处理中…" : "同意按此计划修改"}</button>
        <ConfirmButton label="退回计划" confirmLabel="确认退回" prompt="退回后本次尝试将取消，需重新发起。" busy={busy} danger onConfirm={() => void decide("rejected")} />
      </div>
    </div> : null}
    {pending && !canDecide ? <Blocked>需由导师或学生本人（非发起人）审阅计划。</Blocked> : null}
  </section>;
}
