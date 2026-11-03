"use client";

// Result card additions (frontend plan FA2–FA4, contract
// lib/research-loop/results-contract.ts): baseline comparison, student
// interpretation and the progress draft. Every action is gated by the
// server's `permissions`; nothing here derives authorization on its own.

import { useState, type FormEvent } from "react";
import type { InterpretationInput, ProgressDraft, ResultInterpretationView, RunBaselineView } from "../../lib/research-loop/results-contract.ts";
import { LoopRequestError, newKey, postJson, type RunDetail } from "./api";
import { dateLabel, shortSha } from "./labels";
import { NavLink } from "./lineage";
import { runLabel } from "./numbering";
import {
  buildMetricComparison, deltaText, emptyInterpretation, INTERPRETATION_FIELDS, INTERPRETATION_MAX_LENGTH, interpretationHasContent,
  interpretationInput, interpretationVersionCount, metricText, progressDraftHref, progressDraftStorageKey, progressDraftText, type MetricValues,
} from "./result-insights-model";
import { CopyButton, ErrorNote, Notice, Pill } from "./ui";
import styles from "./research-loop.module.css";
import rc from "./run-card.module.css";
import ri from "./result-insights.module.css";

function baselineName(baseline: { taskTitle: string; number: number | null }) {
  return `${baseline.taskTitle || "任务"} · ${runLabel(baseline.number)}`;
}

/** FA2: "指标 / 本次 / 基线 / 差值" when a baseline is set, the plain metric
 * table otherwise. Differences carry a sign only — no good/bad colouring. */
export function MetricsWithBaseline({ values, split, baseline }: {
  values: MetricValues;
  split: string | undefined;
  baseline: RunBaselineView | null | undefined;
}) {
  const caption = `指标（${split ?? "未注明划分"}）`;
  if (!baseline) {
    return <div className={styles.tableWrap}><table className={`${styles.table} ${rc.stackTable}`}>
      <caption>{caption}</caption>
      <thead><tr><th scope="col">指标</th><th scope="col">数值</th></tr></thead>
      <tbody>{Object.entries(values).map(([name, value]) => <tr key={name}><td data-label="指标">{name}</td><td data-label="数值" className={styles.mono}>{value}</td></tr>)}</tbody>
    </table></div>;
  }
  const rows = buildMetricComparison(values, baseline.metrics);
  return <div className={styles.tableWrap}><table className={`${styles.table} ${rc.stackTable}`}>
    <caption>{caption}；基线为{baselineName(baseline)}{baseline.metrics ? "" : "（基线没有机器指标）"}</caption>
    <thead><tr><th scope="col">指标</th><th scope="col">本次</th><th scope="col">基线</th><th scope="col">差值</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.name}>
      <td data-label="指标">{row.name}</td>
      <td data-label="本次" className={styles.mono}>{metricText(row.current)}</td>
      <td data-label="基线" className={styles.mono}>{metricText(row.baseline)}</td>
      <td data-label="差值" className={`${styles.mono} ${ri.delta}`}>{deltaText(row.delta)}</td>
    </tr>)}</tbody>
  </table></div>;
}

/** FA2: which run is the baseline, the protocol warning (T21) and, when the
 * server allows it, picking or clearing the baseline. */
export function BaselinePanel({ detail, onReload }: { detail: RunDetail; onReload: () => Promise<void> }) {
  const baseline = detail.baseline ?? null;
  const candidates = (detail.baselineCandidates ?? []).filter((item) => item.runId !== detail.run.id);
  const canSet = detail.permissions.canSetBaseline === true;
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  async function setBaseline(baselineRunId: string | null) {
    setBusy(true); setError(null); setNotice("");
    try {
      await postJson("/api/runs", { action: "set_baseline", runId: detail.run.id, baselineRunId }, "基线保存失败，请重试");
      setNotice(baselineRunId ? "已设为基线。基线只是比较对象，不改变运行规范或批准。" : "已清除基线。");
      setSelected("");
      await onReload();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  const choice = candidates.find((item) => item.runId === selected) ?? null;
  return <div className={ri.baseline}>
    <p className={ri.baselineLine}>
      <strong>基线对比</strong>
      {baseline ? <>
        <NavLink target={{ kind: "run", taskId: baseline.taskId, runId: baseline.runId }}>{baselineName(baseline)}</NavLink>
        <small className={styles.mono}>提交 {baseline.executedCommitShort || "—"}</small>
        {baseline.protocolMatches ? <Pill tone="neutral">评价协议相同</Pill> : <Pill tone="warn">评价协议不同</Pill>}
        <small>{dateLabel(baseline.setAt)} 设定</small>
      </> : <span>未设基线</span>}
    </p>
    {baseline && !baseline.protocolMatches ? <p className={ri.protocolWarning} role="note">
      <strong>评价协议不同，不能作为同协议对比</strong>
      <span>本次协议 <code>{shortSha(detail.spec.evaluationProtocolSha256, 12)}</code>，基线协议 <code>{shortSha(baseline.evaluationProtocolSha256, 12)}</code>。下表数值仅供参考。</span>
    </p> : null}
    {canSet ? <div className={ri.baselinePicker}>
      {candidates.length ? <>
        <label>选择基线<select value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
          <option value="">请选择已完成且技术有效的运行</option>
          {candidates.map((item) => <option key={item.runId} value={item.runId}>
            {baselineName(item)}{item.endedAt ? ` · ${dateLabel(item.endedAt)}` : ""} · {item.protocolMatches ? "协议相同" : "协议不同"}
            {item.runId === baseline?.runId ? "（当前基线）" : ""}
          </option>)}
        </select></label>
        <button type="button" disabled={busy || !selected || selected === baseline?.runId} onClick={() => void setBaseline(selected)}>{busy ? "处理中…" : "设为基线"}</button>
      </> : <small className={styles.muted}>暂无可作基线的运行：需要该学生已完成且技术有效的其他运行。</small>}
      {baseline ? <button type="button" disabled={busy} onClick={() => void setBaseline(null)}>清除基线</button> : null}
      {choice && !choice.protocolMatches ? <small className={ri.pickerNote}>所选运行的评价协议与本次不同，设为基线后会显示协议不同的提示。</small> : null}
    </div> : null}
    <ErrorNote error={error} />
    <Notice>{notice}</Notice>
  </div>;
}

function InterpretationView({ interpretation, count }: { interpretation: ResultInterpretationView; count: number }) {
  return <div className={ri.interpretation}>
    <p className={ri.interpretationMeta}>
      {interpretation.authorName || "学生"} · 第 {interpretation.version} 版 · {dateLabel(interpretation.createdAt)}
      {count > 1 ? <small> · 共 {count} 个版本</small> : null}
    </p>
    <dl className={ri.interpretationFields}>
      {INTERPRETATION_FIELDS.map(({ key, label }) => <div key={key}>
        <dt>{label}</dt>
        <dd>{interpretation[key].trim() ? interpretation[key] : <span className={styles.muted}>未填写</span>}</dd>
      </div>)}
    </dl>
  </div>;
}

/** FA3: the student's reading of the result, shown before the mentor review.
 * Only the owner student (permissions.canInterpret) can write; every save is a
 * new version guarded by expectedVersion. */
export function InterpretationSection({ detail, onReload }: { detail: RunDetail; onReload: () => Promise<void> }) {
  const interpretation = detail.interpretation ?? null;
  const count = interpretationVersionCount(detail.interpretationVersions, interpretation);
  const canInterpret = detail.permissions.canInterpret === true;
  const [editing, setEditing] = useState(canInterpret && !interpretation);
  const [draft, setDraft] = useState<InterpretationInput>(() => interpretationInput(interpretation));
  const [requestId, setRequestId] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  function startEditing() {
    setDraft(interpretationInput(interpretation));
    setRequestId(newKey());
    setError(null); setNotice("");
    setEditing(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interpretationHasContent(draft)) return;
    setBusy(true); setError(null); setNotice("");
    try {
      await postJson("/api/run-results", {
        action: "interpret", runId: detail.run.id, requestId, expectedVersion: interpretation?.version ?? 0, ...draft,
      }, "学生解读保存失败，请重试");
      setEditing(false);
      setRequestId(newKey());
      setNotice("解读已保存，导师评审时会看到。");
      await onReload();
    } catch (failure) {
      if (failure instanceof LoopRequestError && failure.status === 409) {
        // Someone (another tab) saved a newer version: load it, keep this text.
        setRequestId(newKey());
        setError(new Error("解读已有更新的版本，已载入最新内容（见上方）。你的修改仍保留在表单中，核对后可再次保存。"));
        await onReload().catch(() => undefined);
      } else setError(failure);
    } finally { setBusy(false); }
  }

  return <section className={ri.section} aria-label="学生解读">
    <h5>学生解读{count ? <small> 第 {interpretation?.version ?? count} 版</small> : null}</h5>
    {interpretation ? <InterpretationView interpretation={interpretation} count={count} />
      : detail.permissions.canReview ? <p className={styles.warning}>学生尚未解读，评审前可提醒学生补充。</p>
        : canInterpret ? <p className={styles.muted}>请写下你对这次结果的理解：导师会在评审前看到。</p>
          : <p className={styles.muted}>学生尚未解读。</p>}
    {canInterpret ? editing ? <form className={styles.form} onSubmit={submit}>
      <h4>{interpretation ? `修改解读（保存为第 ${interpretation.version + 1} 版）` : "填写解读"}</h4>
      <p className={styles.muted}>解读由你本人撰写，每次保存都会留下一个版本；不必一次写完整，至少填写一项。</p>
      <div className={ri.interpretationGrid}>
        {INTERPRETATION_FIELDS.map(({ key, label, hint }) => <label key={key}>{label}
          <textarea rows={3} maxLength={INTERPRETATION_MAX_LENGTH} placeholder={hint} value={draft[key]} disabled={busy}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
        </label>)}
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={busy || !interpretationHasContent(draft)}>{busy ? "正在保存…" : "保存解读"}</button>
        {interpretation ? <button type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(emptyInterpretation()); setError(null); }}>取消</button> : null}
      </div>
    </form> : <div className={styles.actions}><button type="button" onClick={startEditing}>{interpretation ? "修改解读" : "填写解读"}</button></div> : null}
    <ErrorNote error={error} />
    <Notice>{notice}</Notice>
  </section>;
}

function SourceRef({ value }: { value: string }) {
  return /^https:\/\//u.test(value) ? <a href={value} target="_blank" rel="noreferrer">{value}</a> : <code>{value}</code>;
}

/** FA4 (first bullet): a progress draft built by the server from the task,
 * run, metrics source, PR and latest interpretation. The owner student
 * (permissions.canInterpret) is taken to the progress composer; staff see it
 * read-only — progress is always submitted by the student. */
export function ProgressDraftAction({ detail }: { detail: RunDetail }) {
  const studentFlow = detail.permissions.canInterpret === true;
  const [draft, setDraft] = useState<ProgressDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function generate() {
    setBusy(true); setError(null);
    try {
      const payload = await postJson<{ draft: ProgressDraft }>("/api/run-results", { action: "progress_draft", runId: detail.run.id }, "进展草稿生成失败，请重试");
      if (studentFlow) {
        try { window.sessionStorage.setItem(progressDraftStorageKey(detail.run.id), JSON.stringify(payload.draft)); } catch { /* storage unavailable: the composer can rebuild from draftRun */ }
        window.location.assign(progressDraftHref(detail.run.id));
        return;
      }
      setDraft(payload.draft);
    } catch (failure) { setError(failure); }
    setBusy(false);
  }

  if (!detail.permissions.canDraftProgress) return null;
  return <div className={ri.progress}>
    <div className={styles.actions}>
      <button type="button" disabled={busy} onClick={() => void generate()}>{busy ? "正在生成…" : draft ? "重新生成进展草稿" : "生成进展草稿"}</button>
      <small className={styles.muted}>{studentFlow
        ? "用任务、运行、指标来源、PR 和你的解读预填一条项目进展，提交前可修改。"
        : "草稿只供查看，不会保存；进展须由学生本人提交。"}</small>
    </div>
    {draft ? <div className={ri.draft}>
      <p className={ri.draftHead}><strong>{draft.kind}进展草稿</strong><span>进展须由学生本人提交</span><CopyButton text={progressDraftText(draft)} label="复制草稿" /></p>
      <dl className={ri.interpretationFields}>
        <div><dt>标题</dt><dd>{draft.title}</dd></div>
        <div><dt>摘要</dt><dd>{draft.summary || <span className={styles.muted}>无</span>}</dd></div>
        <div><dt>证据</dt><dd>{draft.evidence || <span className={styles.muted}>无</span>}</dd></div>
        {draft.evidenceSources.length ? <div><dt>证据来源</dt><dd><ul className={ri.sources}>{draft.evidenceSources.map((source) => <li key={`${source.sourceType}:${source.ref}`}>
          {source.label}：<SourceRef value={source.ref} />
        </li>)}</ul></dd></div> : null}
      </dl>
    </div> : null}
    <ErrorNote error={error} />
  </div>;
}
