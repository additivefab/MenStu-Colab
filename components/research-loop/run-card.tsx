"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { getJson, newKey, postJson, type Dataset, type Entrypoint, type RunDetail, type RunSummary } from "./api";
import {
  artifactKindLabels, bytesLabel, dateLabel, egressLabels, hypothesisLabels, label, reviewStateLabels, runStatusLabels, shortSha, validityLabels,
} from "./labels";
import { NavLink, ResultLineage } from "./lineage";
import { anchorId, useFocusedCard, useLoopNavigation } from "./navigation";
import { runLabel } from "./numbering";
import { describeRunSpec } from "./spec-summary";
import { TaskForm, type TaskContentDraft } from "./task-form";
import { Blocked, ConfirmButton, CopyButton, ErrorNote, Field, Notice, Pill } from "./ui";
import { usePolling } from "./use-polling";
import styles from "./research-loop.module.css";
import rc from "./run-card.module.css";

const TERMINAL = new Set(["completed", "failed", "canceled"]);
/** Statuses that change without user action; the open card polls them (F5). */
const LIVE = new Set(["queued", "dispatching", "running", "collecting", "cancel_requested", "reconciling"]);
const POLL_MS = 5000;

type RunOptions = { entrypoints: Entrypoint[]; datasets: Dataset[] };

function changeRequestText(changeRequestId: string | null, ref: { number: number | null; prNumber: number | null } | null) {
  if (!changeRequestId) return null;
  return ref?.prNumber ? `PR #${ref.prNumber}` : ref?.number ? `变更 #${ref.number}` : "变更请求";
}

/** G3: what the approval actually allows, in words, before any hash. */
function ApprovalContent({ detail, taskContent, options, awaiting }: {
  detail: RunDetail;
  taskContent: TaskContentDraft | null;
  options?: RunOptions;
  awaiting: boolean;
}) {
  const nav = useLoopNavigation();
  const { spec } = detail;
  const crRef = spec.changeRequestId ? nav.changeRequestRef?.(spec.changeRequestId) ?? null : null;
  const summary = describeRunSpec(spec, {
    changeRequestLabel: changeRequestText(spec.changeRequestId, crRef),
    datasetLabel: options?.datasets.find((item) => item.id === spec.dataset.versionId)?.label ?? spec.dataset.versionId,
    entrypointName: options?.entrypoints.find((item) => item.id === spec.entrypoint.id)?.name ?? null,
    taskBudget: taskContent?.budget ?? null,
  });
  return <div className={rc.content}>
    <h5>{awaiting ? "本次批准的内容" : "运行内容"}</h5>
    <p className={rc.sentence}>{summary.sentence}</p>
    <ul className={rc.egress}>
      {summary.leavesLab ? <li><span className={rc.egressTag}>会离开实验室</span>{summary.leavesLab}</li> : null}
      {summary.staysInLab ? <li><span className={`${rc.egressTag} ${rc.stays}`}>留在实验室</span>{summary.staysInLab}</li> : null}
    </ul>
    {summary.budget.notes.length || !summary.budget.withinBudget ? <div className={summary.budget.withinBudget ? rc.budget : `${rc.budget} ${rc.overBudget}`}>
      <strong>{summary.budget.withinBudget ? "预算" : "超出任务预算"}</strong>
      {summary.budget.notes.length ? <ul>{summary.budget.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
    </div> : null}
  </div>;
}

/** Readable facts of the pinned spec; hashes live in <Traceability>. */
function SpecFacts({ detail, options }: { detail: RunDetail; options?: RunOptions }) {
  const nav = useLoopNavigation();
  const { spec, run } = detail;
  const params = Object.entries(spec.entrypoint.params);
  const egress = spec.egress;
  const taskId = spec.taskId || run.taskId;
  const crRef = spec.changeRequestId ? nav.changeRequestRef?.(spec.changeRequestId) ?? null : null;
  const datasetLabel = options?.datasets.find((item) => item.id === spec.dataset.versionId)?.label ?? null;
  const entrypointName = options?.entrypoints.find((item) => item.id === spec.entrypoint.id)?.name ?? null;
  return <dl className={styles.fields}>
    <Field label="运行 ID" value={<>{run.id}<small> · 第 {run.attempt} 次执行</small> <CopyButton text={run.id} label="复制 ID" /></>} mono />
    <Field label="执行提交" value={<>{shortSha(spec.executedCommitSha, 7)}{spec.changeRequestId
      ? <small> · 来自 <NavLink target={{ kind: "changeRequest", taskId, changeRequestId: spec.changeRequestId }}>{changeRequestText(spec.changeRequestId, crRef)}</NavLink></small>
      : <small> · 直接指定提交</small>}</>} mono />
    <Field label="仓库" value={spec.repository.fullName} />
    <Field label="数据集版本" value={<>{datasetLabel ?? spec.dataset.versionId}<small>{datasetLabel ? ` · ${spec.dataset.versionId}` : ""} · 只读挂载</small></>} />
    <Field label="入口" value={<>{entrypointName ?? spec.entrypoint.argv.join(" ")}<small> · {entrypointName ? spec.entrypoint.argv.join(" ") : spec.entrypoint.id}</small></>} mono />
    <Field label="参数" value={params.length ? params.map(([key, value]) => `${key}=${String(value)}`).join("，") : "无"} mono />
    <Field label="资源" value={`${spec.resources.gpuCount} GPU · ${spec.resources.memoryGb} GB 内存 · 最长 ${spec.resources.walltimeMinutes} 分钟`} />
    <Field label="网络与外发" value={`${spec.network === "deny" ? "禁止联网" : spec.network}；外发白名单 ${egress.allowedExtensions.join(" ") || "无"}，单文件 ≤ ${bytesLabel(egress.maxFileBytes)}，图片${egress.allowImages ? "可" : "不"}外发`} />
    <Field label="基线" value="未登记（本期运行规范不含基线字段）" />
    <Field label="任务版本" value={`第 ${spec.taskVersion} 版`} />
  </dl>;
}

function HashRow({ name, value, copyLabel }: { name: string; value: string; copyLabel: string }) {
  return <Field label={name} value={<span className={rc.hashRow}><span>{value || "—"}</span>{value ? <CopyButton text={value} label={copyLabel} /> : null}</span>} mono />;
}

/** Full hashes for checking; the approval binds the spec hash shown here. */
function Traceability({ detail, current }: { detail: RunDetail; current: RunSummary }) {
  const { spec } = detail;
  return <details className={`${styles.subtle} ${rc.trace}`}>
    <summary>可追溯信息（完整哈希，可复制核对）</summary>
    <div className={rc.traceSpec}>
      <small>规范哈希 · 批准绑定此值</small>
      <span className={rc.hashRow}><code className={styles.hash}>{current.runSpecSha256}</code><CopyButton text={current.runSpecSha256} label="复制规范哈希" /></span>
    </div>
    <dl className={`${styles.fields} ${rc.traceFields}`}>
      <HashRow name="完整提交 SHA" value={spec.executedCommitSha} copyLabel="复制 SHA" />
      <HashRow name="镜像" value={spec.entrypoint.imageRef} copyLabel="复制镜像" />
      <HashRow name="数据集清单" value={spec.dataset.manifestSha256} copyLabel="复制清单哈希" />
      <HashRow name="划分清单" value={spec.dataset.splitManifestSha256} copyLabel="复制划分哈希" />
      <Field label="评价协议" value={<span className={rc.hashRow}><span>{spec.evaluationProtocolSha256}</span><CopyButton text={spec.evaluationProtocolSha256} label="复制协议哈希" /></span>} mono />
      <HashRow name="任务快照" value={spec.taskSnapshotSha256} copyLabel="复制快照哈希" />
      <Field label="入口命令" value={<>{spec.entrypoint.argv.join(" ")}<small> · {spec.entrypoint.id}</small></>} mono />
      <Field label="数据挂载" value={`${spec.dataset.mount} · ${spec.dataset.versionId}`} mono />
    </dl>
  </details>;
}

function ResultSection({ detail, taskContent, onReload, onChanged }: {
  detail: RunDetail;
  taskContent: TaskContentDraft | null;
  onReload: () => Promise<void>;
  onChanged: () => void;
}) {
  const { result, review, artifacts, permissions } = detail;
  const nav = useLoopNavigation();
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
  const metricsProtocol = result?.metrics?.evaluationProtocolSha256 ?? null;
  const protocolMatches = metricsProtocol ? metricsProtocol === detail.spec.evaluationProtocolSha256 : null;

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
  const metricsHref = source?.downloadable ? `/api/run-artifacts?artifactId=${encodeURIComponent(source.id)}` : null;
  return <section className={styles.result} aria-label="结果评审">
    <h5>结果</h5>
    {/* Technical validity, hypothesis outcome and human acceptance stay separate. */}
    <div className={styles.verdicts}>
      <div><small>技术有效性</small><Pill tone={validityTone}>{result ? validityText : "无结果记录"}</Pill></div>
      <div><small>假设结论</small><Pill tone="neutral">{hypothesisLabels[review?.hypothesisOutcome ?? "not_assessed"] ?? review?.hypothesisOutcome}</Pill></div>
      <div><small>导师评审</small><Pill tone={review ? reviewTone : "neutral"}>{review ? reviewText : "未开始"}</Pill></div>
    </div>
    {result?.validityNotes ? <p className={valid ? styles.muted : styles.warning}>{result.validityNotes}</p> : null}

    {/* G4: evidence first (metrics with their source, artifacts), then the review form. */}
    {result || artifacts.length ? <div className={rc.evidence}>
      <h5>证据</h5>
      {result?.metrics?.values ? <>
        <p className={rc.evidenceMeta}>
          <span>划分：{result.metrics.split ?? "未注明"}</span>
          <span>来源：{source ? <>{metricsHref ? <a href={metricsHref}>{source.relativePath}</a> : source.relativePath}<small className={styles.mono}> · sha256 {shortSha(source.sha256, 12)}</small></> : "未记录"}</span>
          <span>评价协议：{protocolMatches === null ? "指标未声明" : protocolMatches ? <Pill tone="good">与运行规范一致</Pill> : <Pill tone="bad">与运行规范不一致</Pill>}</span>
          <span>基线对比：未登记</span>
        </p>
        <div className={styles.tableWrap}><table className={`${styles.table} ${rc.stackTable}`}>
          <caption>指标（{result.metrics.split ?? "未注明划分"}）</caption>
          <thead><tr><th scope="col">指标</th><th scope="col">数值</th></tr></thead>
          <tbody>{Object.entries(result.metrics.values).map(([name, value]) => <tr key={name}><td data-label="指标">{name}</td><td data-label="数值" className={styles.mono}>{value}</td></tr>)}</tbody>
        </table></div>
      </> : result ? <p className={styles.muted}>没有通过校验的机器指标文件，不能作为正式指标。</p> : null}
      {artifacts.length ? <div className={styles.tableWrap}><table className={`${styles.table} ${styles.wideTable} ${rc.stackTable}`}>
        <caption>产物 {artifacts.length} 个</caption>
        <thead><tr><th scope="col">文件</th><th scope="col">类型</th><th scope="col">大小</th><th scope="col">去向</th></tr></thead>
        <tbody>{artifacts.map((item) => {
          const [egressText, egressTone] = label(egressLabels, item.egressDecision);
          return <tr key={item.id}>
            <td data-label="文件"><span className={styles.pathCell}>{item.downloadable ? <a href={`/api/run-artifacts?artifactId=${encodeURIComponent(item.id)}`}>{item.relativePath}</a> : item.relativePath}</span><small className={styles.mono}>{shortSha(item.sha256, 12)}</small></td>
            <td data-label="类型">{artifactKindLabels[item.kind] ?? item.kind}</td>
            <td data-label="大小">{bytesLabel(item.sizeBytes)}</td>
            <td data-label="去向"><Pill tone={egressTone}>{egressText}</Pill>{item.egressReason ? <small>{item.egressReason}</small> : null}</td>
          </tr>;
        })}</tbody>
      </table></div> : null}
    </div> : null}

    {review ? <>
      {review.note ? <p className={styles.reviewNote}><strong>评审意见：</strong>{review.note}<small> · {dateLabel(review.updatedAt)}</small></p> : null}
      {review.followupTaskId ? <p className={styles.muted}>已转为下一轮任务：<NavLink target={{ kind: "task", taskId: review.followupTaskId }}>{nav.taskTitle(review.followupTaskId) ?? "查看下一轮任务"}</NavLink></p> : null}
      {permissions.canReview ? <form className={styles.form} onSubmit={submitReview}>
        <h4>评审结论</h4>
        <p className={styles.muted}>技术有效性、假设结论和导师评审分别记录：验收只表示导师认可这次结果，不改变技术有效性。</p>
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
    <ResultLineage task={nav.task?.(detail.run.taskId) ?? null} detail={detail} />
  </section>;
}

/** Run card: the pinned spec, approval bound to the spec hash, and the result.
 * `options` (entrypoints/datasets from the panel) is optional and only used to
 * name the dataset and entrypoint; ids are shown when it is absent. */
export function RunCard({ run, number, taskContent, options, onChanged }: {
  run: RunSummary;
  number?: number | null;
  taskContent: TaskContentDraft | null;
  options?: RunOptions;
  onChanged: () => void;
}) {
  const nav = useLoopNavigation();
  const runNumber = number ?? nav.runRef(run.id)?.number ?? null;
  const [open, setOpen] = useState(run.status === "awaiting_approval");
  const rootRef = useFocusedCard<HTMLElement>("run", run.id, setOpen);
  const otherRunLabel = (runId: string) => {
    const other = nav.runRef(runId)?.number ?? null;
    return other ? runLabel(other) : "另一次运行";
  };
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [rerunKey, setRerunKey] = useState(newKey);
  /** Last status this card has seen from the detail endpoint. */
  const seenStatus = useRef<string | null>(null);
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const fetchDetail = useCallback((signal?: AbortSignal) => getJson<RunDetail>(`/api/runs?runId=${encodeURIComponent(run.id)}`, "运行详情读取失败", signal), [run.id]);

  const load = useCallback((signal?: AbortSignal) => fetchDetail(signal)
    .then((payload) => { if (!signal?.aborted) { seenStatus.current = payload.run.status; setDetail(payload); setError(null); } }, (failure: unknown) => { if (!signal?.aborted) setError(failure); }), [fetchDetail]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load, run.status]);

  // F5: refresh the open card while the run moves on its own; tell the panel
  // when the status changes so the task's stage bar follows.
  const poll = useCallback(async (signal: AbortSignal) => {
    const before = seenStatus.current;
    try {
      const payload = await fetchDetail(signal);
      if (signal.aborted) return;
      seenStatus.current = payload.run.status;
      setDetail(payload);
      setError(null);
      if (before !== null && payload.run.status !== before) onChangedRef.current();
    } catch (failure) {
      if (!signal.aborted) setError(failure);
      throw failure;
    }
  }, [fetchDetail]);

  const current = detail?.run ?? run;
  const live = LIVE.has(current.status);
  usePolling(poll, { active: open && live, baseMs: POLL_MS });

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

  const [text, tone] = label(runStatusLabels, current.status);
  const permissions = detail?.permissions;
  const terminal = TERMINAL.has(current.status);
  const failed = current.status === "failed";
  const awaiting = current.status === "awaiting_approval";
  const taskId = detail?.spec.taskId || current.taskId;
  const rerun = () => void act({ action: "rerun", idempotencyKey: rerunKey }, "已按同一规范新建运行，需要重新批准。");
  return <article className={styles.item} id={anchorId.run(run.id)} ref={rootRef}>
    <button type="button" className={styles.itemHead} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={styles.itemTitle}>{runLabel(runNumber)} · 提交 {shortSha(current.executedCommitSha, 7)}{current.attempt > 1 ? ` · 第 ${current.attempt} 次执行` : ""}</span>
      <span className={styles.itemMeta}>
        <Pill tone={tone}>{text}</Pill>
        {current.technicalValidity ? <Pill tone={label(validityLabels, current.technicalValidity)[1]}>{label(validityLabels, current.technicalValidity)[0]}</Pill> : null}
        {current.reviewState ? <Pill tone={label(reviewStateLabels, current.reviewState)[1]}>{label(reviewStateLabels, current.reviewState)[0]}</Pill> : null}
      </span>
    </button>
    {current.status === "failed" || current.failureReason ? <p className={styles.failure}>{current.failureReason || "运行失败，未提供原因"}{current.exitCode !== null && current.exitCode !== undefined ? <code>退出码 {current.exitCode}</code> : null}</p> : null}
    {current.status === "reconciling" ? <p className={rc.liveNote} role="status">正在与实验室核对作业状态（不会重复提交）</p> : null}
    {open ? <div className={styles.itemBody}>
      {failed ? <div className={rc.nextSteps}>
        <strong>下一步</strong>
        {permissions?.canRerun ? <button type="button" disabled={busy} onClick={rerun}>按同一规范重跑（需重新批准）</button> : null}
        <span>{permissions?.canRerun ? "或者调整代码、数据或资源：" : "如需调整代码、数据或资源，请"}<NavLink target={{ kind: "task", taskId }}>修改任务</NavLink>后重新发起运行。</span>
      </div> : null}
      {live && detail ? <p className={rc.pollNote}>状态每 {POLL_MS / 1000} 秒自动刷新</p> : null}
      {detail ? <>
        <ApprovalContent detail={detail} taskContent={taskContent} options={options} awaiting={awaiting} />
        {awaiting ? permissions?.canApprove ? <div className={styles.approve}>
          <label>批准说明（可选）<input maxLength={1000} value={approveNote} disabled={busy} onChange={(event) => setApproveNote(event.target.value)} /></label>
          <div className={`${styles.actions} ${rc.approveRow}`}>
            <button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ action: "approve", runSpecSha256: current.runSpecSha256, note: approveNote }, "已批准，运行进入排队。")}>{busy ? "处理中…" : "批准此规范"}</button>
            <small>批准绑定规范哈希 <code>{shortSha(current.runSpecSha256, 12)}</code>（完整值见下方“可追溯信息”）；规范如有任何变化，批准会被拒绝。</small>
          </div>
        </div> : <Blocked>等待批准：需由可审核该学生的导师或超级管理员批准；运行创建人不能批准自己的运行。</Blocked> : null}
        <SpecFacts detail={detail} options={options} />
        <Traceability detail={detail} current={current} />
        {detail.approvals.length ? <ul className={styles.timeline}>{detail.approvals.map((item) => <li key={item.id}>
          {item.approverName || "导师"} 于 {dateLabel(item.approvedAt)} 批准此规范{item.runId && item.runId !== current.id ? `（用于${otherRunLabel(item.runId)}）` : ""}{item.revokedAt ? ` · 已于 ${dateLabel(item.revokedAt)} 撤销` : item.current ? " · 当前生效" : ""}{item.note ? ` · ${item.note}` : ""}
        </li>)}</ul> : null}
        <div className={styles.actions}>
          {permissions?.canRevokeApproval ? <ConfirmButton label="撤销批准" confirmLabel="确认撤销" prompt="撤销后运行将被取消。" busy={busy} danger onConfirm={() => void act({ action: "revoke_approval" }, "批准已撤销。")} /> : null}
          {permissions?.canCancel ? <ConfirmButton label="取消运行" confirmLabel="确认取消" prompt={current.status === "awaiting_approval" || current.status === "queued" ? "将直接取消。" : "实验室执行器会在下次心跳时停止作业。"} busy={busy} onConfirm={() => void act({ action: "cancel" }, "已提交取消。")} /> : null}
          {permissions?.canRerun && !failed ? <button type="button" disabled={busy} onClick={rerun}>按同一规范重跑（需重新批准）</button> : null}
        </div>
        {detail.events.length ? <details className={styles.subtle}><summary>状态记录 {detail.events.length} 条</summary><ol className={styles.timeline}>{detail.events.map((event) => <li key={event.sequence}>{dateLabel(event.createdAt)} · {event.fromStatus ? `${label(runStatusLabels, event.fromStatus)[0]} → ` : ""}{label(runStatusLabels, event.toStatus)[0]}<small> · {event.actorType === "user" ? "用户" : event.actorType === "runner" ? "执行器" : "系统"}</small></li>)}</ol></details> : null}
        {terminal || detail.result ? <ResultSection detail={detail} taskContent={taskContent} onReload={() => load()} onChanged={onChanged} /> : null}
      </> : error ? null : <p className={styles.muted} role="status">正在读取运行详情…</p>}
      <ErrorNote error={error} />
      <Notice>{notice}</Notice>
    </div> : null}
  </article>;
}
