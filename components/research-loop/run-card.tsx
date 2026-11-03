"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getJson, newKey, postJson, type RunDetail, type RunSummary } from "./api";
import {
  artifactKindLabels, bytesLabel, dateLabel, egressLabels, hypothesisLabels, label, reviewStateLabels, runStatusLabels, shortSha, validityLabels,
} from "./labels";
import { TaskForm, type TaskContentDraft } from "./task-form";
import { Blocked, ConfirmButton, ErrorNote, Field, Notice, Pill } from "./ui";
import styles from "./research-loop.module.css";

const TERMINAL = new Set(["completed", "failed", "canceled"]);

function SpecSummary({ detail }: { detail: RunDetail }) {
  const { spec, run } = detail;
  const params = Object.entries(spec.entrypoint.params);
  const egress = spec.egress;
  return <dl className={styles.fields}>
    <Field label="运行 ID" value={`${run.id} · 第 ${run.attempt} 次`} mono />
    <Field label="规范哈希" value={run.runSpecSha256} mono />
    <Field label="执行提交" value={<>{spec.executedCommitSha}{spec.changeRequestId ? <small> · 来自变更请求 {spec.changeRequestId}</small> : null}</>} mono />
    <Field label="仓库" value={spec.repository.fullName} />
    <Field label="数据集版本" value={<>{spec.dataset.versionId}<small> · 清单 {shortSha(spec.dataset.manifestSha256, 12)} · 只读挂载</small></>} mono />
    <Field label="入口" value={<>{spec.entrypoint.argv.join(" ")}<small> · {spec.entrypoint.id}</small></>} mono />
    <Field label="镜像" value={spec.entrypoint.imageRef} mono />
    <Field label="参数" value={params.length ? params.map(([key, value]) => `${key}=${String(value)}`).join("，") : "无"} mono />
    <Field label="资源" value={`${spec.resources.gpuCount} GPU · ${spec.resources.memoryGb} GB 内存 · 最长 ${spec.resources.walltimeMinutes} 分钟`} />
    <Field label="网络与外发" value={`${spec.network === "deny" ? "禁止联网" : spec.network}；外发白名单 ${egress.allowedExtensions.join(" ") || "无"}，单文件 ≤ ${bytesLabel(egress.maxFileBytes)}，图片${egress.allowImages ? "可" : "不"}外发`} />
    <Field label="评价协议" value={spec.evaluationProtocolSha256} mono />
    <Field label="基线" value="未登记（本期运行规范不含基线字段）" />
    <Field label="任务版本" value={`第 ${spec.taskVersion} 版 · 快照 ${shortSha(spec.taskSnapshotSha256, 12)}`} />
  </dl>;
}

function ResultSection({ detail, taskContent, onReload, onChanged }: {
  detail: RunDetail;
  taskContent: TaskContentDraft | null;
  onReload: () => Promise<void>;
  onChanged: () => void;
}) {
  const { result, review, artifacts, permissions } = detail;
  const [reviewDraft, setReviewDraft] = useState({ state: "", hypothesisOutcome: review?.hypothesisOutcome ?? "not_assessed", note: "" });
  const [comment, setComment] = useState("");
  const [commentKey, setCommentKey] = useState(newKey);
  const [followupKey] = useState(newKey);
  const [followupOpen, setFollowupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const valid = result?.technicalValidity === "valid";
  const source = artifacts.find((item) => item.id === result?.metricsSourceArtifactId);

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || !reviewDraft.state) return;
    setBusy(true); setError(null); setNotice("");
    try {
      await postJson("/api/run-results", { action: "review", runId: detail.run.id, expectedVersion: review.version, ...reviewDraft }, "评审保存失败，请重试");
      setNotice("评审已保存。");
      setReviewDraft((current) => ({ ...current, note: "" }));
      await onReload();
      onChanged();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!comment.trim()) return;
    setBusy(true); setError(null);
    try {
      await postJson("/api/run-results", { action: "comment", runId: detail.run.id, requestId: commentKey, body: comment }, "评论发送失败，请重试");
      setComment("");
      setCommentKey(newKey());
      await onReload();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  async function submitFollowup(content: TaskContentDraft) {
    await postJson("/api/run-results", { action: "followup", runId: detail.run.id, mutationId: followupKey, ...content }, "后续任务创建失败，请重试");
    setFollowupOpen(false);
    setNotice("已创建下一轮任务（草稿），确认后才能执行。");
    await onReload();
    onChanged();
  }

  const [validityText, validityTone] = label(validityLabels, result?.technicalValidity ?? (TERMINAL.has(detail.run.status) ? "unknown" : null));
  const [reviewText, reviewTone] = label(reviewStateLabels, review?.state);
  return <section className={styles.result} aria-label="结果评审">
    <h5>结果</h5>
    {/* Technical validity, hypothesis outcome and human acceptance stay separate. */}
    <div className={styles.verdicts}>
      <div><small>技术有效性</small><Pill tone={validityTone}>{result ? validityText : "无结果记录"}</Pill></div>
      <div><small>假设结论</small><Pill tone="neutral">{hypothesisLabels[review?.hypothesisOutcome ?? "not_assessed"] ?? review?.hypothesisOutcome}</Pill></div>
      <div><small>导师评审</small><Pill tone={review ? reviewTone : "neutral"}>{review ? reviewText : "未开始"}</Pill></div>
    </div>
    {result?.validityNotes ? <p className={valid ? styles.muted : styles.warning}>{result.validityNotes}</p> : null}
    {result?.metrics?.values ? <div className={styles.tableWrap}><table className={styles.table}>
      <caption>指标（{result.metrics.split ?? "未注明划分"}）· 来源 {source ? <>{source.relativePath} · sha256 {shortSha(source.sha256, 12)}{source.downloadable ? <> · <a href={`/api/run-artifacts?artifactId=${encodeURIComponent(source.id)}`}>下载</a></> : null}</> : "未记录"}</caption>
      <thead><tr><th scope="col">指标</th><th scope="col">数值</th></tr></thead>
      <tbody>{Object.entries(result.metrics.values).map(([name, value]) => <tr key={name}><td>{name}</td><td className={styles.mono}>{value}</td></tr>)}</tbody>
    </table></div> : result ? <p className={styles.muted}>没有通过校验的机器指标文件，不能作为正式指标。</p> : null}
    {artifacts.length ? <div className={styles.tableWrap}><table className={`${styles.table} ${styles.wideTable}`}>
      <caption>产物 {artifacts.length} 个</caption>
      <thead><tr><th scope="col">文件</th><th scope="col">类型</th><th scope="col">大小</th><th scope="col">去向</th></tr></thead>
      <tbody>{artifacts.map((item) => {
        const [egressText, egressTone] = label(egressLabels, item.egressDecision);
        return <tr key={item.id}>
          <td><span className={styles.pathCell}>{item.downloadable ? <a href={`/api/run-artifacts?artifactId=${encodeURIComponent(item.id)}`}>{item.relativePath}</a> : item.relativePath}</span><small className={styles.mono}>{shortSha(item.sha256, 12)}</small></td>
          <td>{artifactKindLabels[item.kind] ?? item.kind}</td>
          <td>{bytesLabel(item.sizeBytes)}</td>
          <td><Pill tone={egressTone}>{egressText}</Pill>{item.egressReason ? <small>{item.egressReason}</small> : null}</td>
        </tr>;
      })}</tbody>
    </table></div> : null}

    {review ? <>
      {review.note ? <p className={styles.reviewNote}><strong>评审意见：</strong>{review.note}<small> · {dateLabel(review.updatedAt)}</small></p> : null}
      {review.followupTaskId ? <p className={styles.muted}>已转为下一轮任务：<code>{review.followupTaskId}</code></p> : null}
      {permissions.canReview ? <form className={styles.form} onSubmit={submitReview}>
        <h4>评审结论</h4>
        <div className={styles.grid2}>
          <label>评审结论<select required value={reviewDraft.state} disabled={busy} onChange={(event) => setReviewDraft({ ...reviewDraft, state: event.target.value })}>
            <option value="">请选择</option>
            <option value="accepted" disabled={!valid}>验收{valid ? "" : "（技术有效性未通过，不可选）"}</option>
            <option value="needs_followup">需要后续实验</option>
            <option value="rejected">不采纳</option>
          </select></label>
          <label>假设结论<select value={reviewDraft.hypothesisOutcome} disabled={busy} onChange={(event) => setReviewDraft({ ...reviewDraft, hypothesisOutcome: event.target.value })}>
            {Object.entries(hypothesisLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select></label>
          <label className={styles.wide}>评审说明<textarea rows={2} maxLength={4000} value={reviewDraft.note} disabled={busy} onChange={(event) => setReviewDraft({ ...reviewDraft, note: event.target.value })} /></label>
        </div>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy || !reviewDraft.state}>{busy ? "正在保存…" : "保存评审"}</button></div>
      </form> : <Blocked>结果评审由可审核该学生的导师或超级管理员完成。</Blocked>}
    </> : result === null && TERMINAL.has(detail.run.status) ? <p className={styles.muted}>本次运行没有回传结果，无法评审。</p> : null}

    <div className={styles.comments}>
      <h5>讨论 {detail.comments.length ? <small>{detail.comments.length}</small> : null}</h5>
      {detail.comments.map((item) => <div key={item.id} className={styles.comment}><strong>{item.authorName || "成员"}</strong><small>{dateLabel(item.createdAt)}</small><p>{item.body}</p></div>)}
      {permissions.canComment ? <form className={styles.inlineForm} onSubmit={submitComment}>
        <label className={styles.srOnly} htmlFor={`comment-${detail.run.id}`}>评论</label>
        <textarea id={`comment-${detail.run.id}`} rows={2} maxLength={4000} value={comment} placeholder="写下对这次结果的看法" disabled={busy} onChange={(event) => setComment(event.target.value)} />
        <button type="submit" disabled={busy || !comment.trim()}>发送</button>
      </form> : null}
    </div>
    <ErrorNote error={error} />
    <Notice>{notice}</Notice>
    {TERMINAL.has(detail.run.status) ? followupOpen ? <TaskForm
      title="转为下一轮任务"
      submitLabel="创建下一轮任务"
      note="新任务以草稿保存，记录来源运行；需重新确认后才能交给代理或运行。"
      initial={{ ...(taskContent ?? { title: "", researchQuestion: "", hypothesis: "", instructions: "", acceptanceCriteria: "", allowedPaths: [], protectedPaths: [], budget: {} }), title: taskContent ? `后续：${taskContent.title}`.slice(0, 120) : "" }}
      onSubmit={submitFollowup}
      onCancel={() => setFollowupOpen(false)}
    /> : <div className={styles.actions}><button type="button" disabled={busy} onClick={() => setFollowupOpen(true)}>转为下一轮任务</button></div> : null}
  </section>;
}

/** Run card: the pinned spec, approval bound to the spec hash, and the result. */
export function RunCard({ run, taskContent, onChanged }: { run: RunSummary; taskContent: TaskContentDraft | null; onChanged: () => void }) {
  const [open, setOpen] = useState(run.status === "awaiting_approval");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [rerunKey, setRerunKey] = useState(newKey);

  const load = useCallback((signal?: AbortSignal) => getJson<RunDetail>(`/api/runs?runId=${encodeURIComponent(run.id)}`, "运行详情读取失败", signal)
    .then((payload) => { if (!signal?.aborted) { setDetail(payload); setError(null); } }, (failure: unknown) => { if (!signal?.aborted) setError(failure); }), [run.id]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load, run.status]);

  async function act(body: Record<string, unknown>, success: string) {
    setBusy(true); setError(null); setNotice("");
    try {
      await postJson("/api/runs", { runId: run.id, ...body }, "操作失败，请重试");
      setNotice(success);
      if (body.action === "rerun") setRerunKey(newKey());
      await load();
      onChanged();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  const current = detail?.run ?? run;
  const [text, tone] = label(runStatusLabels, current.status);
  const permissions = detail?.permissions;
  const terminal = TERMINAL.has(current.status);
  return <article className={styles.item}>
    <button type="button" className={styles.itemHead} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={styles.itemTitle}>运行 {current.id.slice(-8)} · 第 {current.attempt} 次 · 提交 {shortSha(current.executedCommitSha, 8)}</span>
      <span className={styles.itemMeta}>
        <Pill tone={tone}>{text}</Pill>
        {current.technicalValidity ? <Pill tone={label(validityLabels, current.technicalValidity)[1]}>{label(validityLabels, current.technicalValidity)[0]}</Pill> : null}
        {current.reviewState ? <Pill tone={label(reviewStateLabels, current.reviewState)[1]}>{label(reviewStateLabels, current.reviewState)[0]}</Pill> : null}
      </span>
    </button>
    {current.status === "failed" || current.failureReason ? <p className={styles.failure}>{current.failureReason || "运行失败，未提供原因"}{current.exitCode !== null && current.exitCode !== undefined ? <code>退出码 {current.exitCode}</code> : null}</p> : null}
    {open ? <div className={styles.itemBody}>
      {detail ? <>
        <SpecSummary detail={detail} />
        {detail.approvals.length ? <ul className={styles.timeline}>{detail.approvals.map((item) => <li key={item.id}>
          {item.approverName || "导师"} 于 {dateLabel(item.approvedAt)} 批准此规范{item.runId && item.runId !== current.id ? `（用于运行 ${item.runId.slice(-8)}）` : ""}{item.revokedAt ? ` · 已于 ${dateLabel(item.revokedAt)} 撤销` : item.current ? " · 当前生效" : ""}{item.note ? ` · ${item.note}` : ""}
        </li>)}</ul> : null}
        {current.status === "awaiting_approval" ? permissions?.canApprove ? <div className={styles.approve}>
          <p>批准将绑定以下规范哈希；规范如有任何变化，批准会被拒绝。</p>
          <code className={styles.hash}>{current.runSpecSha256}</code>
          <label>批准说明（可选）<input maxLength={1000} value={approveNote} disabled={busy} onChange={(event) => setApproveNote(event.target.value)} /></label>
          <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ action: "approve", runSpecSha256: current.runSpecSha256, note: approveNote }, "已批准，运行进入排队。")}>{busy ? "处理中…" : "批准此规范"}</button></div>
        </div> : <Blocked>等待批准：需由可审核该学生的导师或超级管理员批准；运行创建人不能批准自己的运行。</Blocked> : null}
        <div className={styles.actions}>
          {permissions?.canRevokeApproval ? <ConfirmButton label="撤销批准" confirmLabel="确认撤销" prompt="撤销后运行将被取消。" busy={busy} danger onConfirm={() => void act({ action: "revoke_approval" }, "批准已撤销。")} /> : null}
          {permissions?.canCancel ? <ConfirmButton label="取消运行" confirmLabel="确认取消" prompt={current.status === "awaiting_approval" || current.status === "queued" ? "将直接取消。" : "实验室执行器会在下次心跳时停止作业。"} busy={busy} onConfirm={() => void act({ action: "cancel" }, "已提交取消。")} /> : null}
          {permissions?.canRerun ? <button type="button" disabled={busy} onClick={() => void act({ action: "rerun", idempotencyKey: rerunKey }, "已按同一规范新建运行，需要重新批准。")}>按同一规范重跑</button> : null}
        </div>
        {detail.events.length ? <details className={styles.subtle}><summary>状态记录 {detail.events.length} 条</summary><ol className={styles.timeline}>{detail.events.map((event) => <li key={event.sequence}>{dateLabel(event.createdAt)} · {event.fromStatus ? `${label(runStatusLabels, event.fromStatus)[0]} → ` : ""}{label(runStatusLabels, event.toStatus)[0]}<small> · {event.actorType === "user" ? "用户" : event.actorType === "runner" ? "执行器" : "系统"}</small></li>)}</ol></details> : null}
        {terminal || detail.result ? <ResultSection detail={detail} taskContent={taskContent} onReload={() => load()} onChanged={onChanged} /> : null}
      </> : error ? null : <p className={styles.muted} role="status">正在读取运行详情…</p>}
      <ErrorNote error={error} />
      <Notice>{notice}</Notice>
    </div> : null}
  </article>;
}
